import assert from "node:assert/strict";
import { test } from "node:test";
import { Value } from "typebox/value";
import { failureResult, OutputSchema, SearchError, searchContext } from "../src/result.ts";
import { parseResponse } from "../src/xai.ts";

const context = searchContext({ query: "研究 xAI", allowed_x_handles: ["xai"] }, "grok-4.7", "oauth");
const url = "https://x.com/xai/status/123";
const sample = () => ({
  id: "resp_test", model: "grok-4.7", status: "completed",
  output: [{ type: "message", role: "assistant", content: [{
    type: "output_text", text: "xAI 的一条帖子。", annotations: [{
      type: "url_citation", url, title: "@xai", start_index: 0, end_index: 3,
    }],
  }] }],
  usage: {
    input_tokens: 100, output_tokens: 50, total_tokens: 150,
    input_tokens_details: { cached_tokens: 20 }, output_tokens_details: { reasoning_tokens: 10 },
    cost_in_usd_ticks: 70_000_000,
  },
});

test("success contract includes provenance, original citation coordinates and exact cost", () => {
  const result = parseResponse(sample(), context);
  assert.equal(Value.Check(OutputSchema, result), true);
  assert.equal(result.success, true);
  assert.equal(result.provider, "xai");
  assert.equal(result.tool, "x_search");
  assert.equal(result.query, context.query);
  assert.equal(result.credential_source, "oauth");
  assert.deepEqual(result.filters, { allowed_x_handles: ["xai"] });
  assert.equal(result.response_id, "resp_test");
  assert.equal(result.answer, "xAI 的一条帖子。");
  assert.deepEqual(result.citations, []);
  assert.deepEqual(result.inline_citations, [{ url, title: "@xai", text_index: 0, start_index: 0, end_index: 3 }]);
  assert.deepEqual(result.citation_texts, ["xAI 的一条帖子。"]);
  assert.equal(result.citation_count, 1);
  assert.equal(result.degraded, false);
  assert.equal(result.degraded_reason, null);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.usage, { input_tokens: 100, output_tokens: 50, total_tokens: 150, cached_input_tokens: 20, reasoning_tokens: 10, cost_usd: 0.007 });
});

test("keeps citation channels separate, deduplicates URL lists, but retains repeated inline mentions", () => {
  const body = sample();
  const result = parseResponse({ ...body,
    citations: [url, url, { url: "https://x.com/other/status/456" }, "javascript:alert(1)", "https://user:pass@x.com/private"],
    output: [
      { type: "reasoning", content: [{ type: "output_text", text: "private reasoning" }] },
      { type: "web_search_call", action: { sources: [
        { url: "https://x.com/retrieved/status/789" }, { url: "https://x.com/retrieved/status/789", title: "retrieved" },
      ] } },
      ...body.output,
      { type: "message", role: "user", content: [{ type: "output_text", text: "ignore this" }] },
      { type: "message", content: [{ type: "text", text: "第二部分", annotations: [
        { type: "url_citation", url_citation: { url, title: "again", start_index: 1, end_index: 2 } },
      ] }] },
    ],
  }, context);
  assert.equal(result.answer, "xAI 的一条帖子。\n\n第二部分");
  assert.deepEqual(result.citations, [url, "https://x.com/other/status/456"]);
  assert.equal(result.inline_citations.length, 2);
  assert.equal(result.inline_citations[1]!.text_index, 1);
  assert.deepEqual(result.citation_texts, ["xAI 的一条帖子。", "第二部分"]);
  assert.deepEqual(result.search_sources, [{ url: "https://x.com/retrieved/status/789", title: "retrieved" }]);
  assert.equal(result.citation_count, 2, "retrieved-but-uncited URLs must not inflate the cited evidence count");
});

test("offsets refer to exact block text, not a trimmed, concatenated, sanitized or aggregate answer", () => {
  const raw = "  A🚀\u001bB\n ";
  const result = parseResponse({
    output_text: "a different SDK aggregate",
    output: [{ type: "message", content: [{ type: "output_text", text: raw, annotations: [
      { type: "url_citation", url, start_index: 2, end_index: 6 },
    ] }] }],
  }, context);
  assert.equal(result.citation_texts[0], raw);
  assert.equal(result.inline_citations[0]!.start_index, 2);
  assert.equal(result.inline_citations[0]!.end_index, 6);
  assert.equal(result.answer, "A🚀B");
  const json = JSON.stringify(result);
  assert.equal(json.includes("\u001b"), false, "serialized agent output must not contain an actual terminal escape");
  assert.equal(JSON.parse(json).citation_texts[0], raw, "JSON escaping must not alter the cited text");
});

test("missing/invalid offsets are nullable; never invents positions", () => {
  const body = sample();
  const result = parseResponse({ ...body, output: [{ type: "message", content: [{ type: "output_text", text: "evidence", annotations: [
    { type: "url_citation", url, start_index: -1, end_index: "3" },
    { type: "url_citation", url, start_index: 5, end_index: 2 },
    { type: "url_citation", url },
  ] }] }] }, context);
  assert.deepEqual(result.inline_citations.map(({ start_index, end_index }) => [start_index, end_index]), [[null, null], [5, null]]);
  assert.equal(Value.Check(OutputSchema, result), true);
});

for (const filters of [{ allowed_x_handles: ["xai"] }, { excluded_x_handles: ["spam"] }, { from_date: "2026-01-01" }, { to_date: "2026-01-01" }]) {
  test(`flags uncited filtered answers as degraded: ${JSON.stringify(filters)}`, () => {
    const result = parseResponse({ output_text: "Unsourced explanation" }, searchContext({ query: "test", ...filters }, "grok-4.7"));
    assert.equal(result.degraded, true);
    assert.equal(result.degraded_reason, "no_citations_with_filters");
    assert.equal(result.citation_count, 0);
    assert.equal(result.warnings[0]!.code, "uncited_answer");
    assert.match(result.warnings[0]!.message, /Do not treat.*verified.*or infer/);
  });
}

test("broad uncited answers warn without claiming a filter miss or asserting their origin", () => {
  const result = parseResponse({ output_text: "No citations" }, searchContext({ query: "test" }, "grok-4.7"));
  assert.equal(result.degraded, false);
  assert.equal(result.degraded_reason, null);
  assert.equal(result.citation_count, 0);
  assert.equal(result.warnings[0]!.code, "uncited_answer");
});

test("retrieved sources alone do not establish answer citations or suppress degraded", () => {
  const result = parseResponse({ output_text: "uncited", output: [{ type: "web_search_call", action: { sources: [{ url }] } }] }, context);
  assert.equal(result.search_sources.length, 1);
  assert.equal(result.citation_count, 0);
  assert.equal(result.degraded, true);
});

test("incomplete answers carry a machine-readable reason, warning and usage", () => {
  const result = parseResponse({ ...sample(), status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }, context);
  assert.equal(result.success, true);
  assert.equal(result.status, "incomplete");
  assert.equal(result.incomplete_reason, "max_output_tokens");
  assert.equal(result.warnings[0]!.code, "incomplete_response");
  assert.ok(result.usage);
});

test("redacts echoed credentials without shifting source text coordinates", () => {
  const secret = "test-token", raw = `${secret} cited text`;
  const result = parseResponse({ output: [{ type: "message", content: [{ type: "output_text", text: raw, annotations: [
    { type: "url_citation", url, start_index: secret.length + 1, end_index: raw.length },
    { type: "url_citation", url: `https://x.com/?credential=${secret}` },
  ] }] }] }, context, secret);
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(result.citation_texts[0]!.length, raw.length);
  assert.equal(result.citation_texts[0]!.slice(result.inline_citations[0]!.start_index!), "cited text");
  assert.equal(result.citation_count, 1);
});

test("clamps token details and handles zero/string cost ticks", () => {
  const result = parseResponse({ ...sample(), usage: {
    input_tokens: 10, output_tokens: 5, total_tokens: -1,
    input_tokens_details: { cached_tokens: 100 }, output_tokens_details: { reasoning_tokens: 200 }, cost_in_usd_ticks: "0",
  } }, context);
  assert.deepEqual(result.usage, { input_tokens: 10, output_tokens: 5, total_tokens: 15, cached_input_tokens: 10, reasoning_tokens: 5, cost_usd: 0 });
});

for (const [body, code] of [
  [{}, "empty_response"], [{ error: { message: "Rejected query" } }, "invalid_response"],
  [{ status: "failed" }, "invalid_response"], [{ status: "in_progress" }, "invalid_response"],
  [{ output: [{ type: "message", content: [{ type: "refusal", refusal: "Not allowed" }] }] }, "refused"],
] as const) {
  test(`does not disguise failed/malformed/refused responses as a successful empty search: ${code}`, () => {
    assert.throws(() => parseResponse(body, context), (error: unknown) => {
      assert.ok(error instanceof SearchError);
      assert.equal(error.code, code);
      const failure = failureResult(context, error);
      assert.equal(Value.Check(OutputSchema, failure), true);
      assert.equal(failure.success, false);
      assert.equal("answer" in failure, false);
      return true;
    });
  });
}

test("failure contract preserves incurred usage but never echoes unexpected exceptions", () => {
  const body = { ...sample(), output: [], usage: sample().usage };
  let failure;
  try { parseResponse(body, context); }
  catch (error) { failure = failureResult(context, error); }
  assert.ok(failure?.usage);
  const unexpected = failureResult(context, new Error("secret-provider-header"));
  assert.equal(unexpected.error.code, "internal_error");
  assert.equal(JSON.stringify(unexpected).includes("secret-provider-header"), false);
});

test("reports actual server-side X Search usage counts, independently of citation/candidate counts", () => {
  const result = parseResponse({ ...sample(), usage: {
    ...sample().usage, server_side_tool_usage_details: {
      x_search_calls: 2, x_posts_fetched: 44, x_users_fetched: 0, web_search_calls: 99,
    },
  } }, context);
  assert.equal(result.usage?.x_search_calls, 2);
  assert.equal(result.usage?.x_posts_fetched, 44);
  assert.equal(result.usage?.x_users_fetched, 0);
  assert.equal(result.citation_count, 1);
  assert.equal("web_search_calls" in result.usage!, false);
  assert.equal(Value.Check(OutputSchema, result), true);
  const malformed = parseResponse({ ...sample(), usage: {
    input_tokens: 1, server_side_tool_usage_details: { x_search_calls: -1, x_posts_fetched: 1.5, x_users_fetched: "2" },
  } }, context);
  assert.equal(malformed.usage?.x_search_calls, undefined);
  assert.equal(malformed.usage?.x_posts_fetched, undefined);
  assert.equal(malformed.usage?.x_users_fetched, undefined);
});
