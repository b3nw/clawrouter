import { listGrantRecords, snapshot } from "./providers";
import type { CompiledProvider, Env, UpstreamGrant } from "./types";

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
 * Resolves auth from env API keys first, then falls back to upstream grants.
 * Returns models not already in the static manifest, prefixed with the provider prefix.
 */
export async function discoverUpstreamModels(env: Env, executableProviderIds: Set<string>): Promise<Array<{ id: string; object: string; owned_by: string; display_name: string; capabilities: string[] }>> {
  const passthroughProviders = snapshot.providers.filter(
    (p) => p.routing.modelPassthrough && p.class === "openai_compatible" && executableProviderIds.has(p.id),
  );

  const grants = await listGrantRecords(env);

  const results = await Promise.allSettled(
    passthroughProviders.map((provider) => fetchProviderModels(provider, env, grants)),
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

  return applyModelFilters(discovered, env);
}

async function fetchProviderModels(provider: CompiledProvider, env: Env, grants: Array<{ key: string; grant: UpstreamGrant }>): Promise<UpstreamModel[] | null> {
  const cached = await readCache(provider.id, env);
  if (cached) return cached;

  const baseUrl = resolveBaseUrl(provider, env);
  if (!baseUrl) return null;

  const authToken = resolveAuth(provider, env, grants);
  if (!authToken) return null;

  const modelsUrl = resolveModelsEndpoint(provider, baseUrl);

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const response = await fetch(modelsUrl, {
      headers: { authorization: `Bearer ${authToken}`, accept: "application/json" },
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

function resolveBaseUrl(provider: CompiledProvider, env: Env): string | null {
  let url = provider.base_urls.default;
  if (!url) return null;
  // Resolve template parameters (e.g. ${local_openai_base_url})
  const templateMatch = url.match(/\$\{([^}]+)\}/);
  if (templateMatch) {
    const envKey = templateMatch[1].toUpperCase().replace(/-/g, "_");
    const value = env[envKey];
    if (typeof value !== "string" || !value.trim()) return null;
    url = url.replace(templateMatch[0], value.trim());
  }
  return url.replace(/\/$/, "");
}

function resolveModelsEndpoint(provider: CompiledProvider, baseUrl: string): string {
  // Most providers: baseUrl + /v1/models or /models
  // If baseUrl already contains /v1, just append /models
  if (baseUrl.endsWith("/v1")) return `${baseUrl}/models`;
  return `${baseUrl}/v1/models`;
}

/** Resolve auth: env API key first, then usable grant credentials. */
function resolveAuth(provider: CompiledProvider, env: Env, grants: Array<{ key: string; grant: UpstreamGrant }>): string | null {
  // 1. Env-based API key
  for (const key of provider.config_keys) {
    const value = env[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  // 2. Grant-based auth (api_key or oauth with accessToken)
  const providerGrants = grants.filter(
    (entry) => entry.grant.provider === provider.id && entry.grant.enabled !== false,
  );
  for (const { grant } of providerGrants) {
    const token = grant.credential ?? grant.accessToken ?? firstCredential(grant.credentials);
    if (token) return token;
  }
  return null;
}

function firstCredential(values: Record<string, string> | undefined): string | null {
  return values ? Object.values(values).find(Boolean) ?? null : null;
}

/**
 * Build a reusable filter function from IGNORE_MODELS_* / WHITELIST_MODELS_* env vars.
 * Applies to any model with { id, owned_by } — works for both static and dynamic models.
 */
export function buildModelFilter(env: Env): (model: { id: string; owned_by: string }) => boolean {
  const ignorePatterns = new Map<string, string[]>();
  const whitelistPatterns = new Map<string, string[]>();

  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== "string" || !value.trim()) continue;
    const upperKey = key.toUpperCase();
    if (upperKey.startsWith("IGNORE_MODELS_")) {
      const provider = upperKey.slice("IGNORE_MODELS_".length).toLowerCase().replace(/_/g, "-");
      ignorePatterns.set(provider, value.split(",").map((p) => p.trim()).filter(Boolean));
    } else if (upperKey.startsWith("WHITELIST_MODELS_")) {
      const provider = upperKey.slice("WHITELIST_MODELS_".length).toLowerCase().replace(/_/g, "-");
      whitelistPatterns.set(provider, value.split(",").map((p) => p.trim()).filter(Boolean));
    }
  }

  if (!ignorePatterns.size && !whitelistPatterns.size) return () => true;

  return (model) => {
    const whitelist = whitelistPatterns.get(model.owned_by);
    if (whitelist?.length) return whitelist.some((pattern) => globMatch(model.id, pattern));
    const ignore = ignorePatterns.get(model.owned_by);
    if (ignore?.length) return !ignore.some((pattern) => globMatch(model.id, pattern));
    return true;
  };
}

function applyModelFilters(
  models: Array<{ id: string; object: string; owned_by: string; display_name: string; capabilities: string[] }>,
  env: Env,
): typeof models {
  const filter = buildModelFilter(env);
  return models.filter(filter);
}

function globMatch(value: string, pattern: string): boolean {
  if (pattern === "*") return true;
  const regex = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`);
  return regex.test(value);
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
