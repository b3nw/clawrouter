import assert from "node:assert/strict";
import { extname } from "node:path";
import { registerHooks } from "node:module";
import test from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier.startsWith(".") &&
      context.parentURL &&
      !extname(new URL(specifier, context.parentURL).pathname)
    ) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});

const { modelRoute, providerById } = await import("../providers.ts");

test("static model resolves from the model index", () => {
  const route = modelRoute("openai/gpt-5.6");
  assert.ok(route);
  assert.equal(route.provider.id, "openai");
  assert.equal(route.model.id, "openai/gpt-5.6");
  assert.equal(route.model.upstream, "gpt-5.6");
  assert.ok(route.model.pricing, "static models have pricing");
});

test("passthrough model resolves for a provider with modelPassthrough enabled", () => {
  const openai = providerById("openai");
  assert.ok(openai);
  assert.equal(openai.routing.modelPassthrough, true);

  const route = modelRoute("openai/gpt-99-turbo");
  assert.ok(route, "unknown model with matching prefix should resolve");
  assert.equal(route.provider.id, "openai");
  assert.equal(route.model.id, "openai/gpt-99-turbo");
  assert.equal(route.model.upstream, "gpt-99-turbo");
  assert.equal(route.model.pricing, null, "passthrough models have no pricing");
  assert.equal(route.model.pricing_ref, null);
  assert.ok(route.model.capabilities.length > 0, "inherits template capabilities");
});

test("passthrough model resolves for anthropic", () => {
  const route = modelRoute("anthropic/claude-future-99");
  assert.ok(route, "unknown anthropic model should resolve via passthrough");
  assert.equal(route.provider.id, "anthropic");
  assert.equal(route.model.upstream, "claude-future-99");
  assert.equal(route.model.pricing, null);
});

test("passthrough model resolves for mistral", () => {
  const route = modelRoute("mistral/mistral-future-model");
  assert.ok(route);
  assert.equal(route.provider.id, "mistral");
  assert.equal(route.model.upstream, "mistral-future-model");
});

test("passthrough does NOT resolve for providers without it enabled", () => {
  const bedrock = providerById("aws-bedrock");
  assert.ok(bedrock);
  assert.equal(bedrock.routing.modelPassthrough, false);

  const route = modelRoute("aws-bedrock/some-unknown-model");
  assert.equal(route, null, "providers without passthrough reject unknown models");
});

test("passthrough requires a non-empty upstream segment after prefix", () => {
  const route = modelRoute("openai/");
  assert.equal(route, null, "bare prefix without model name should not resolve");
});

test("completely unknown prefix returns null", () => {
  const route = modelRoute("nonexistent-provider/some-model");
  assert.equal(route, null);
});

test("static models take precedence over passthrough", () => {
  const route = modelRoute("openai/gpt-5.5");
  assert.ok(route);
  assert.equal(route.model.id, "openai/gpt-5.5");
  assert.ok(route.model.pricing, "static model retains its pricing");
});
