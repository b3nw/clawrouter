import { snapshot } from "./providers";
import type { CompiledProvider, Env } from "./types";

interface UpstreamModel {
  id: string;
  owned_by: string;
}

interface CachedModels {
  models: UpstreamModel[];
  fetchedAt: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5000;
const KV_PREFIX = "upstream-models/";

/**
 * Fetch and cache upstream model listings for passthrough-enabled providers.
 * Returns models not already in the static manifest, prefixed with the provider prefix.
 */
export async function discoverUpstreamModels(env: Env, executableProviderIds: Set<string>): Promise<Array<{ id: string; object: string; owned_by: string; display_name: string; capabilities: string[] }>> {
  const passthroughProviders = snapshot.providers.filter(
    (p) => p.routing.modelPassthrough && p.class === "openai_compatible" && executableProviderIds.has(p.id),
  );

  const results = await Promise.allSettled(
    passthroughProviders.map((provider) => fetchProviderModels(provider, env)),
  );

  const discovered: Array<{ id: string; object: string; owned_by: string; display_name: string; capabilities: string[] }> = [];
  const staticIds = new Set(Object.keys(snapshot.model_index));

  for (let i = 0; i < passthroughProviders.length; i++) {
    const result = results[i];
    if (result.status !== "fulfilled" || !result.value) continue;
    const provider = passthroughProviders[i];
    const prefix = provider.routing.modelPrefixes[0] ?? `${provider.id}/`;
    const template = provider.models[0];
    const capabilities = template?.capabilities ?? provider.capabilities.map((c) => c.id);

    for (const model of result.value) {
      const prefixedId = model.id.startsWith(prefix) ? model.id : `${prefix}${model.id}`;
      if (staticIds.has(prefixedId)) continue;
      discovered.push({
        id: prefixedId,
        object: "model",
        owned_by: provider.id,
        display_name: `${provider.display_name} · ${model.id}`,
        capabilities,
      });
    }
  }

  return discovered;
}

async function fetchProviderModels(provider: CompiledProvider, env: Env): Promise<UpstreamModel[] | null> {
  const cached = await readCache(provider.id, env);
  if (cached) return cached;

  const baseUrl = provider.base_urls.default?.replace(/\/$/, "");
  if (!baseUrl) return null;

  const apiKey = resolveApiKey(provider, env);
  if (!apiKey) return null;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const response = await fetch(`${baseUrl}/v1/models`, {
      headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) return null;
    const body = await response.json<{ data?: Array<{ id: string; owned_by?: string }> }>();
    if (!Array.isArray(body.data)) return null;

    const models: UpstreamModel[] = body.data
      .filter((m) => m.id && typeof m.id === "string")
      .map((m) => ({ id: m.id, owned_by: m.owned_by ?? provider.id }));

    await writeCache(provider.id, models, env);
    return models;
  } catch {
    return null;
  }
}

function resolveApiKey(provider: CompiledProvider, env: Env): string | null {
  for (const key of provider.config_keys) {
    const value = env[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

async function readCache(providerId: string, env: Env): Promise<UpstreamModel[] | null> {
  try {
    const raw = await env.POLICY_KV.get<CachedModels>(`${KV_PREFIX}${providerId}`, "json");
    if (raw && Date.now() - raw.fetchedAt < CACHE_TTL_MS) return raw.models;
  } catch { /* cache miss */ }
  return null;
}

async function writeCache(providerId: string, models: UpstreamModel[], env: Env): Promise<void> {
  const entry: CachedModels = { models, fetchedAt: Date.now() };
  await env.POLICY_KV.put(`${KV_PREFIX}${providerId}`, JSON.stringify(entry), { expirationTtl: 600 });
}
