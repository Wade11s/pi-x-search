import assert from "node:assert/strict";
import { test } from "node:test";
import { readConfig } from "../src/config.ts";
import { SearchError, type SearchParams } from "../src/result.ts";
import { buildRequest, normalizeParams, RESPONSES_URL, searchX as searchNormalizedX } from "../src/xai.ts";

// Match the tool boundary: validate once, then enter the trusted transport.
type TransportArgs = Parameters<typeof searchNormalizedX> extends [unknown, ...infer Args] ? Args : never;
async function searchX(input: SearchParams, ...args: TransportArgs) {
  return searchNormalizedX(normalizeParams(input), ...args);
}

const config = readConfig({});
const credential = async () => ({ apiKey: "test-oauth-token", source: "oauth" as const });
const sample = () => ({
  model: "grok-4.7", status: "completed", output_text: "A test post.", citations: ["https://x.com/xai/status/123"],
});

// Never uses real credentials or network.
test("configuration has documented defaults and supports explicit overrides", () => {
  assert.deepEqual(config, {
    model: "grok-4.7", timeoutMs: 180_000, maxOutputTokens: 4_096, maxToolCalls: 8,
    researchMode: "balanced", maxCandidates: 5, reasoningEffort: "model_default", defaultInstruction: "",
  });
  assert.deepEqual(readConfig({
    PI_X_SEARCH_MODEL: "grok-4.3", PI_X_SEARCH_TIMEOUT_MS: "1000",
    PI_X_SEARCH_MAX_OUTPUT_TOKENS: "128", PI_X_SEARCH_MAX_TOOL_CALLS: "1",
  }), { ...config, model: "grok-4.3", timeoutMs: 1_000, maxOutputTokens: 128, maxToolCalls: 1 });
});
for (const [name, value] of [
  ["PI_X_SEARCH_TIMEOUT_MS", ""], ["PI_X_SEARCH_TIMEOUT_MS", "1e3"],
  ["PI_X_SEARCH_TIMEOUT_MS", "999"], ["PI_X_SEARCH_TIMEOUT_MS", "600001"],
  ["PI_X_SEARCH_MAX_OUTPUT_TOKENS", "-1"], ["PI_X_SEARCH_MAX_OUTPUT_TOKENS", "32769"],
  ["PI_X_SEARCH_MAX_TOOL_CALLS", "2.5"], ["PI_X_SEARCH_MAX_TOOL_CALLS", "21"],
  ["PI_X_SEARCH_MODEL", "https://evil.example"], ["PI_X_SEARCH_MODEL", ""],
] as const) {
  test(`rejects invalid configuration ${name}=${value}`, () => {
    assert.throws(() => readConfig({ [name]: value }), (error: unknown) => {
      assert.ok(error instanceof SearchError);
      assert.equal(error.code, "invalid_config");
      assert.match(error.message, new RegExp(name));
      return true;
    });
  });
}

test("normalizes query/handles without losing the caller's scope", () => {
  const params = normalizeParams({ query: " 搜索 xAI ", allowed_x_handles: [" @xAI ", "XAI", "other_user"] });
  assert.equal(params.query, "搜索 xAI");
  assert.deepEqual(params.allowed_x_handles, ["xai", "other_user"]);
});
for (const [params, message] of [
  [{ query: " " }, /query/],
  [{ query: "x", allowed_x_handles: [], excluded_x_handles: [] }, /mutually exclusive/],
  [{ query: "x", allowed_x_handles: [] }, /between 1 and 20/],
  [{ query: "x", allowed_x_handles: Array(21).fill("xai") }, /between 1 and 20/],
  [{ query: "x", allowed_x_handles: ["https://x.com/xai"] }, /valid X handles/],
  [{ query: "x", from_date: "2025-02-29" }, /real calendar date/],
  [{ query: "x", from_date: "2026-02-30" }, /real calendar date/],
  [{ query: "x", from_date: "2026-2-01" }, /YYYY-MM-DD/],
  [{ query: "x", from_date: "2026-09-10", to_date: "2026-09-01" }, /must not be later/],
] as const) {
  test(`validates before resolving credentials: ${JSON.stringify(params)}`, async () => {
    let touchedAuth = false;
    await assert.rejects(searchX(params as Parameters<typeof searchX>[0], config, async () => {
      touchedAuth = true;
      return { apiKey: "test", source: "unknown" };
    }), message);
    assert.equal(touchedAuth, false);
  });
}

test("supports leap days and one-sided date filters", () => {
  assert.equal(normalizeParams({ query: "x", from_date: "2024-02-29" }).from_date, "2024-02-29");
  assert.equal(normalizeParams({ query: "x", to_date: "2026-09-01" }).to_date, "2026-09-01");
});

test("request asks for evidence for an agent, only enables X Search, and disables storage", () => {
  const body = JSON.parse(JSON.stringify(buildRequest(normalizeParams({
    query: "xAI", instruction: "用中文回答", excluded_x_handles: ["@spam"],
    from_date: "2026-09-01", enable_image_understanding: true,
  }), config)));
  assert.equal(body.model, config.model);
  assert.equal(body.tool_choice, "required");
  assert.equal(body.store, false);
  assert.equal(body.stream, false);
  assert.equal(body.max_tool_calls, 8);
  assert.equal(body.max_output_tokens, 4_096);
  assert.deepEqual(body.tools, [{
    type: "x_search", excluded_x_handles: ["spam"], from_date: "2026-09-01",
    enable_image_understanding: true, enable_video_understanding: false,
  }]);
  assert.match(body.input[0].content, /用中文回答/);
  assert.match(body.instructions, /another AI agent/);
  assert.match(body.instructions, /untrusted data/);
  assert.equal("search_parameters" in body, false);
});

test("uses the resolved credential only in the official API authorization header, never the query", async () => {
  let calls = 0;
  const fakeFetch: typeof fetch = async (url, init) => {
    calls++;
    assert.equal(url, RESPONSES_URL);
    assert.equal(init?.method, "POST");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer test-oauth-token");
    assert.equal(init?.redirect, "error");
    assert.equal(init?.signal?.aborted, false);
    assert.equal(String(init?.body).includes("test-oauth-token"), false);
    return Response.json(sample());
  };
  const result = await searchX({ query: "xAI", allowed_x_handles: ["@xai"] }, config, credential, undefined, fakeFetch);
  assert.equal(calls, 1);
  assert.equal(result.success, true);
  assert.equal(result.credential_source, "oauth");
  assert.deepEqual(result.filters, { allowed_x_handles: ["xai"] });
  assert.equal(result.citation_count, 1);
});

test("missing/failed credentials do not reach the network or disclose auth errors", async () => {
  const noNetwork: typeof fetch = async () => { assert.fail("must not send a request"); };
  await assert.rejects(searchX({ query: "x" }, config, async () => undefined, undefined, noNetwork), /No xAI credential.*\/login xai/);
  await assert.rejects(searchX({ query: "x" }, config, async () => {
    throw new Error("secret-refresh-token");
  }, undefined, noNetwork), (error: unknown) => {
    assert.ok(error instanceof SearchError);
    assert.equal(error.code, "auth_failed");
    assert.match(error.message, /resolve or refresh.*\/login xai/);
    assert.equal(error.message.includes("secret-refresh-token"), false);
    return true;
  });
});
for (const [status, hint] of [[401, /\/login xai/], [402, /credits/], [403, /entitlement/], [429, /quota/], [500, /HTTP 500/]] as const) {
  test(`HTTP ${status} has safe error data and deliberate-retry classification; no automatic retries`, async () => {
    let calls = 0;
    const fakeFetch: typeof fetch = async () => {
      calls++;
      return Response.json({ error: { message: "Oops test-oauth-token Bearer another-secret xai-secret-value\u001b" } }, { status });
    };
    await assert.rejects(searchX({ query: "x" }, config, credential, undefined, fakeFetch), (error: unknown) => {
      assert.ok(error instanceof SearchError);
      assert.equal(error.code, "http_error");
      assert.equal(error.httpStatus, status);
      assert.equal(error.retryable, status === 429 || status >= 500);
      assert.match(error.message, hint);
      for (const value of ["test-oauth-token", "another-secret", "xai-secret-value", "\u001b"]) assert.equal(error.message.includes(value), false);
      return true;
    });
    assert.equal(calls, 1);
  });
}

test("distinguishes invalid JSON, non-JSON HTTP errors and network failures", async () => {
  const html: typeof fetch = async () => new Response("not JSON");
  const forbidden: typeof fetch = async () => new Response("private response body", { status: 403 });
  const offline: typeof fetch = async () => { throw new Error("some secret from fetch"); };
  await assert.rejects(searchX({ query: "x" }, config, credential, undefined, html), /invalid JSON/);
  await assert.rejects(searchX({ query: "x" }, config, credential, undefined, forbidden), /HTTP 403.*entitlement/);
  await assert.rejects(searchX({ query: "x" }, config, credential, undefined, offline), /network\/proxy/);
});

test("already-aborted requests do not resolve credentials", async () => {
  await assert.rejects(searchX({ query: "x" }, config, async () => {
    assert.fail("must not resolve credentials");
  }, AbortSignal.abort()), /cancelled/);
});
test("cancellation interrupts pending auth resolution", async () => {
  const controller = new AbortController();
  const pending = searchX({ query: "x" }, config, () => new Promise(() => {}), controller.signal);
  controller.abort();
  await assert.rejects(pending, /cancelled/);
});
for (const phase of ["auth", "fetch", "body"] as const) {
  test(`timeout includes ${phase}, even when an implementation ignores AbortSignal`, async () => {
    const hung = () => new Promise<never>(() => {});
    const fakeFetch: typeof fetch = phase === "fetch" ? hung : async () => new Response(new ReadableStream({ pull: hung }));
    await assert.rejects(searchX({ query: "x" }, { ...config, timeoutMs: 10 }, phase === "auth" ? hung : credential, undefined, fakeFetch), (error: unknown) => {
      assert.ok(error instanceof SearchError);
      assert.equal(error.code, "timeout");
      assert.equal(error.retryable, true);
      return true;
    });
  });
}
test("passes cancellation to in-flight fetch", async () => {
  const controller = new AbortController();
  let entered: () => void = () => {};
  const started = new Promise<void>((resolve) => { entered = resolve; });
  let actualSignal: AbortSignal | undefined;
  const fakeFetch: typeof fetch = async (_url, init) => {
    actualSignal = init?.signal ?? undefined;
    entered();
    return new Promise(() => {});
  };
  const pending = searchX({ query: "x" }, config, credential, controller.signal, fakeFetch);
  await started;
  controller.abort();
  await assert.rejects(pending, /cancelled/);
  assert.equal(actualSignal?.aborted, true);
});
test("embedded provider errors redact the resolved credential", async () => {
  const fakeFetch: typeof fetch = async () => Response.json({ error: { message: "test-oauth-token" } });
  await assert.rejects(searchX({ query: "x" }, config, credential, undefined, fakeFetch), /failed\. \[redacted\]/);
});
