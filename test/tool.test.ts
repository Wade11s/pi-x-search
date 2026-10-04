import assert from "node:assert/strict";
import { test } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import extension from "../index.ts";
import { OutputSchema, type ToolOutput } from "../src/result.ts";
import { createXSearchTool, toPiUsage } from "../src/tool.ts";

const model: Model<Api> = {
  type: "chat", id: "grok-4.7", name: "Test Grok", api: "openai-responses", provider: "xai",
  baseUrl: "https://api.x.ai/v1", reasoning: true, input: ["text"],
  cost: { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0 }, contextWindow: 500_000, maxTokens: 8_192,
};
const rawUsage = { input_tokens: 100, output_tokens: 50, total_tokens: 150, cached_input_tokens: 20, reasoning_tokens: 10, cost_usd: 0.007 };
const successResponse = () => Response.json({
  model: model.id, status: "completed", output_text: "搜索结果。", citations: ["https://x.com/xai/status/123"],
  usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150, cost_in_usd_ticks: 70_000_000 },
});
function context(resolve: (provider: string) => Promise<unknown>): ExtensionToolContext {
  return { model: { ...model, provider: "another-provider" }, signal: undefined,
    modelRegistry: { getProviderAuth: resolve, find: () => model },
  } as unknown as ExtensionToolContext;
}
function structured(result: { structuredContent?: unknown }): ToolOutput {
  assert.ok(Value.Check(OutputSchema, result.structuredContent));
  return result.structuredContent;
}

// Agent consumers are tested through the same execute/output-schema contract.
test("extension factory only registers x_search and performs no network or login work", () => {
  const names: string[] = [];
  extension({ registerTool: (tool: { name: string }) => names.push(tool.name) } as unknown as ExtensionAPI);
  assert.deepEqual(names, ["x_search"]);
});
test("input schema rejects unknown fields and enforces date/handle shapes", () => {
  const tool = createXSearchTool({ env: {} });
  assert.equal(Value.Check(tool.parameters, { query: "test", allowed_x_handles: ["@xai"] }), true);
  for (const extra of [
    { api_key: "must-not-be-a-tool-argument" }, { base_url: "https://evil.example" }, { from_date: "September 1" },
    { allowed_x_handles: [] }, { allowed_x_handles: Array(21).fill("xai") },
  ]) assert.equal(Value.Check(tool.parameters, { query: "test", ...extra }), false);
});

test("direct model content is valid JSON, codemode receives an object, and errors are not marked on success", async () => {
  const tool = createXSearchTool({ env: {}, fetch: async () => successResponse() });
  let requestedProvider = "";
  const result = await tool.execute("test", { query: " 搜索 xAI ", allowed_x_handles: ["@xai"] }, undefined, undefined, context(async (provider) => {
    requestedProvider = provider;
    return { auth: { apiKey: "dummy-oauth-token" }, source: "OAuth" };
  }));
  const output = structured(result);
  assert.equal(output.success, true);
  assert.equal(output.credential_source, "oauth");
  assert.equal(output.query, "搜索 xAI");
  assert.deepEqual(output.filters, { allowed_x_handles: ["xai"] });
  assert.equal(requestedProvider, "xai", "current assistant provider must not affect xAI search auth");
  assert.equal(result.isError, false);
  const content = result.content[0];
  assert.ok(content?.type === "text");
  assert.deepEqual(JSON.parse(content.text), output);
  assert.deepEqual(output, result.details);
  assert.equal(result.usage?.cost.total, 0.007);
  assert.equal(JSON.stringify(result).includes("dummy-oauth-token"), false);
});

for (const [source, expected] of [["OAuth", "oauth"], ["XAI_API_KEY", "api_key"], [undefined, "unknown"]] as const) {
  test(`credential source exposes only non-secret metadata: ${String(source)}`, async () => {
    const tool = createXSearchTool({ env: {}, fetch: async () => successResponse() });
    const result = await tool.execute("source", { query: "test" }, undefined, undefined, context(async () => ({ auth: { apiKey: "dummy" }, source })));
    assert.equal(structured(result).credential_source, expected);
  });
}

test("credentials are resolved on each call rather than cached by the extension", async () => {
  const seen: string[] = [];
  const tool = createXSearchTool({ env: {}, fetch: async (_url, init) => {
    seen.push(new Headers(init?.headers).get("authorization")!);
    return successResponse();
  } });
  let resolved = 0;
  const ctx = context(async () => ({ auth: { apiKey: `rotated-token-${++resolved}` } }));
  await tool.execute("first", { query: "test" }, undefined, undefined, ctx);
  await tool.execute("second", { query: "test" }, undefined, undefined, ctx);
  assert.deepEqual(seen, ["Bearer rotated-token-1", "Bearer rotated-token-2"]);
});

for (const [params, env, code] of [
  [{ query: " " }, {}, "invalid_arguments"],
  [{ query: "test", from_date: "2026-02-30" }, {}, "invalid_arguments"],
  [{ query: "test" }, { PI_X_SEARCH_TIMEOUT_MS: "bad" }, "invalid_config"],
] as const) {
  test(`validation/config failure is structured and marked as a Pi error: ${code}`, async () => {
    const tool = createXSearchTool({ env, fetch: async () => { assert.fail("must not call network"); } });
    const result = await tool.execute("invalid", params, undefined, undefined, context(async () => { assert.fail("must not resolve auth"); }));
    const output = structured(result);
    assert.equal(output.success, false);
    assert.ok(!output.success);
    assert.equal(output.status, "error");
    assert.equal(output.error.code, code);
    assert.equal(output.error.retryable, false);
    assert.equal(result.isError, true);
    assert.equal("answer" in output, false);
    assert.deepEqual(JSON.parse((result.content[0] as { text: string }).text), output);
  });
}

test("missing auth and refresh failures remain structured without exposing the underlying error", async () => {
  const tool = createXSearchTool({ env: {}, fetch: async () => { assert.fail("must not call network"); } });
  for (const [resolve, code] of [
    [async () => undefined, "auth_unavailable"],
    [async () => { throw new Error("secret-refresh-token"); }, "auth_failed"],
  ] as const) {
    const result = await tool.execute("auth", { query: "test" }, undefined, undefined, context(resolve));
    const output = structured(result);
    assert.ok(!output.success);
    assert.equal(output.error.code, code);
    assert.equal(result.isError, true);
    assert.equal(JSON.stringify(result).includes("secret-refresh-token"), false);
  }
});

test("context cancellation yields structured cancelled error without resolving credentials", async () => {
  const tool = createXSearchTool({ env: {} });
  const ctx = context(async () => { assert.fail("must not resolve auth"); });
  ctx.signal = AbortSignal.abort();
  const result = await tool.execute("cancelled", { query: "test" }, undefined, undefined, ctx);
  const output = structured(result);
  assert.ok(!output.success);
  assert.equal(output.error.code, "cancelled");
  assert.equal(result.isError, true);
});

test("HTTP errors expose status/retryability while preserving query provenance and avoiding retries", async () => {
  let calls = 0;
  const tool = createXSearchTool({ env: {}, fetch: async () => {
    calls++;
    return Response.json({ error: { message: "dummy-oauth-token" } }, { status: 429 });
  } });
  const result = await tool.execute("rate", { query: "test" }, undefined, undefined, context(async () => ({ auth: { apiKey: "dummy-oauth-token" }, source: "OAuth" })));
  const output = structured(result);
  assert.ok(!output.success);
  assert.equal(output.error.code, "http_error");
  assert.equal(output.error.http_status, 429);
  assert.equal(output.error.retryable, true);
  assert.equal(output.credential_source, "oauth");
  assert.equal(output.query, "test");
  assert.equal(JSON.stringify(result).includes("dummy-oauth-token"), false);
  assert.equal(calls, 1);
});

test("failed responses still report known incurred usage to Pi", async () => {
  const tool = createXSearchTool({ env: {}, fetch: async () => Response.json({
    status: "incomplete", output: [], usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150, cost_in_usd_ticks: 70_000_000 },
  }) });
  const result = await tool.execute("spent", { query: "test" }, undefined, undefined, context(async () => ({ auth: { apiKey: "dummy" } })));
  const output = structured(result);
  assert.ok(!output.success);
  assert.equal(output.error.code, "empty_response");
  assert.equal(output.usage?.total_tokens, 150);
  assert.equal(result.usage?.cost.total, 0.007);
});

test("maps cache/reasoning tokens correctly and prefers reported total cost including searches", () => {
  const usage = toPiUsage(rawUsage, model)!;
  assert.equal(usage.input, 80);
  assert.equal(usage.output, 50);
  assert.equal(usage.cacheRead, 20);
  assert.equal(usage.reasoning, 10);
  assert.equal(usage.totalTokens, 150);
  assert.equal(usage.cost.total, 0.007);
  assert.ok(usage.cost.input + usage.cost.output + usage.cost.cacheRead < usage.cost.total);
  assert.equal(toPiUsage(undefined), undefined);
  assert.equal(toPiUsage({ ...rawUsage, cost_usd: 0 }, model)!.cost.total, 0);
  const { cost_usd: _unused, ...tokens } = rawUsage;
  assert.ok(Math.abs(toPiUsage(tokens, model)!.cost.total - 0.00047) < 1e-12);
});

test("per-call options reach xAI and request_settings without forwarding operator instructions to results", async () => {
  let authCalls = 0;
  const tool = createXSearchTool({ env: {
    PI_X_SEARCH_MODEL: "grok-4.7", PI_X_SEARCH_RESEARCH_MODE: "deep", PI_X_SEARCH_MAX_OUTPUT_TOKENS: "8192",
    PI_X_SEARCH_INSTRUCTION: "Operator-only research guidance",
  }, fetch: async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, "grok-4.5");
    assert.equal(body.max_output_tokens, 512);
    assert.equal(body.max_tool_calls, 1);
    assert.deepEqual(body.reasoning, { effort: "low" });
    assert.match(body.instructions, /Research mode: quick/);
    assert.match(body.instructions, /at most 2 distinct candidates/);
    assert.match(body.instructions, /Operator-only research guidance/);
    assert.match(body.input[0].content, /Firsthand reports only/);
    return successResponse();
  } });
  const result = await tool.execute("options", {
    query: "test", instruction: "Firsthand reports only", model: "grok-4.5",
    research_mode: "quick", max_output_tokens: 512, max_tool_calls: 1, max_candidates: 2,
    reasoning_effort: "low", timeout_ms: 1200,
  }, undefined, undefined, context(async (provider) => {
    assert.equal(provider, "xai");
    authCalls++;
    return { auth: { apiKey: "test-secret" }, source: "OAuth" };
  }));
  const output = structured(result);
  assert.ok(output.success);
  assert.equal(output.model, "grok-4.7", "actual response model is independent of the requested alias");
  assert.deepEqual(output.request_settings, {
    model: "grok-4.5", research_mode: "quick", max_output_tokens: 512, max_tool_calls: 1, max_candidates: 2,
    reasoning_effort: "low", timeout_ms: 1200, default_instruction_applied: true,
  });
  assert.equal(authCalls, 1);
  assert.equal(JSON.stringify(result).includes("Operator-only research guidance"), false);
  assert.equal(JSON.stringify(result).includes("test-secret"), false);
});

test("missing auth still records the selected request settings without a billable request", async () => {
  const tool = createXSearchTool({ env: { PI_X_SEARCH_RESEARCH_MODE: "quick" },
    fetch: async () => { assert.fail("must not call network"); },
  });
  const result = await tool.execute("no-auth-settings", { query: "test", model: "grok-4.5", max_candidates: 3 }, undefined, undefined, context(async () => undefined));
  const output = structured(result);
  assert.ok(!output.success);
  assert.equal(output.error.code, "auth_unavailable");
  assert.equal(output.request_settings?.model, "grok-4.5");
  assert.equal(output.request_settings?.max_tool_calls, 2);
  assert.equal(output.request_settings?.max_candidates, 3);
});

test("invalid per-call budgets/model fail before resolving auth even when schema validation is bypassed", async () => {
  const tool = createXSearchTool({ env: {}, fetch: async () => { assert.fail("must not call network"); } });
  for (const params of [
    { query: "test", max_output_tokens: 0 }, { query: "test", max_candidates: 51 },
    { query: "test", timeout_ms: 999 }, { query: "test", model: "https://evil.example" },
  ]) {
    const result = await tool.execute("invalid-settings", params, undefined, undefined, context(async () => { assert.fail("must not resolve auth"); }));
    const output = structured(result);
    assert.ok(!output.success);
    assert.equal(output.error.code, "invalid_arguments");
    assert.equal(result.isError, true);
    assert.equal(output.request_settings, undefined, "invalid input must not pretend to have resolved settings");
  }
});
