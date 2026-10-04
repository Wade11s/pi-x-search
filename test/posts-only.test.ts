import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { readConfig } from "../src/config.ts";
import { OutputSchema, SearchError, searchContext } from "../src/result.ts";
import { createXSearchTool } from "../src/tool.ts";
import { buildRequest, normalizeParams, parseResponse } from "../src/xai.ts";

const config = readConfig({});
const url = "https://x.com/xai/status/123";
const context = () => ({ modelRegistry: {
  getProviderAuth: async () => ({ auth: { apiKey: "test-token" }, source: "OAuth" }),
  find: () => undefined,
} } as unknown as ExtensionToolContext);

for (const flag of [undefined, false, true]) {
  test(`posts_only=${String(flag)} is a valid optional boolean and survives normalization`, () => {
    const params = { query: "Grok release", posts_only: flag };
    assert.equal(Value.Check(createXSearchTool().parameters, params), true);
    assert.equal(normalizeParams(params).posts_only, flag);
  });
}

for (const flag of ["true", 1, null]) {
  test(`posts_only rejects non-boolean ${JSON.stringify(flag)} before resolving credentials`, async () => {
    const params = { query: "test", posts_only: flag };
    const tool = createXSearchTool({ env: {}, fetch: async () => { assert.fail("must not call network"); } });
    assert.equal(Value.Check(tool.parameters, params), false);
    assert.throws(() => normalizeParams(params as unknown as Parameters<typeof normalizeParams>[0]), (error: unknown) => {
      assert.ok(error instanceof SearchError);
      assert.equal(error.code, "invalid_arguments");
      assert.match(error.message, /posts_only/);
      return true;
    });
    const ctx = context();
    ctx.modelRegistry.getProviderAuth = async () => { assert.fail("must not resolve auth"); };
    const result = await tool.execute("invalid", params as unknown as Parameters<typeof tool.execute>[1], undefined, undefined, ctx);
    assert.ok(Value.Check(OutputSchema, result.structuredContent));
    assert.ok(!result.structuredContent.success);
    assert.equal(result.structuredContent.error.code, "invalid_arguments");
  });
}

test("posts-only adds a query operator and protected keyword-only guidance without an unsupported API tool parameter", () => {
  const original = { query: "Grok release", posts_only: true, instruction: "Include replies and fetch discussion threads." };
  const request = JSON.parse(JSON.stringify(buildRequest(normalizeParams(original), config)));
  assert.match(request.input[0].content, /^Grok release -filter:replies\n/);
  assert.match(request.instructions, /Posts-only restriction/);
  assert.match(request.instructions, /x_keyword_search/);
  assert.match(request.instructions, /every keyword search/);
  assert.match(request.instructions, /Do not use semantic search or thread fetch/);
  assert.match(request.instructions, /self-replies/);
  assert.match(request.instructions, /take priority over conflicting preferences/);
  assert.equal("posts_only" in request.tools[0], false);
  assert.equal("exclude_replies" in request.tools[0], false);
  assert.equal(original.query, "Grok release", "must not mutate caller input");
});

test("disabled posts-only leaves the query and existing request unchanged", () => {
  const params = { query: "Find replies", instruction: "Include discussions" };
  assert.deepEqual(buildRequest(params, config), buildRequest({ ...params, posts_only: false }, config));
  assert.doesNotMatch(String(buildRequest(params, config).instructions), /Posts-only restriction/);
});

test("existing reply exclusion operator is not duplicated in the outgoing query", () => {
  const request = buildRequest({ query: "Grok -filter:replies", posts_only: true }, config);
  assert.deepEqual(request.input, [{ role: "user", content: "Grok -filter:replies" }]);
});

test("results record the active filter and clearly warn that post types are not independently verified", () => {
  const active = searchContext({ query: "Grok", posts_only: true }, "grok-4.7");
  const result = parseResponse({ output_text: "Finding", citations: [url] }, active);
  assert.deepEqual(result.filters, { posts_only: true });
  assert.equal(result.query, "Grok");
  assert.equal(result.citation_count, 1);
  assert.equal(result.degraded, false);
  assert.ok(result.warnings.some((warning) => warning.code === "posts_only_unverified"));
  assert.equal(Value.Check(OutputSchema, result), true);
  const uncited = parseResponse({ output_text: "Uncited" }, active);
  assert.equal(uncited.degraded, true);
  assert.equal(uncited.degraded_reason, "no_citations_with_filters");
  const disabled = parseResponse({ output_text: "Uncited" }, searchContext({ query: "Grok", posts_only: false }, "grok-4.7"));
  assert.deepEqual(disabled.filters, {});
  assert.equal(disabled.degraded, false);
  assert.equal(disabled.warnings.some((warning) => warning.code === "posts_only_unverified"), false);
});

test("tool execution sends posts-only constraints while preserving original query and native citation offsets", async () => {
  const query = "Grok announcement";
  const text = "A top-level finding";
  const tool = createXSearchTool({ env: {}, fetch: async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.input[0].content, `${query} -filter:replies`);
    assert.match(body.instructions, /Posts-only restriction/);
    assert.equal("posts_only" in body.tools[0], false);
    return Response.json({ status: "completed", output: [{ type: "message", content: [{
      type: "output_text", text, annotations: [{ type: "url_citation", url, start_index: 0, end_index: 11 }],
    }] }] });
  } });
  const result = await tool.execute("posts-only", { query, posts_only: true }, undefined, undefined, context());
  assert.ok(Value.Check(OutputSchema, result.structuredContent));
  const output = result.structuredContent;
  assert.ok(output.success);
  assert.equal(output.query, query);
  assert.equal(output.filters.posts_only, true);
  assert.equal(output.citation_texts[0], text);
  assert.equal(output.inline_citations[0]!.start_index, 0);
  assert.equal(output.inline_citations[0]!.end_index, 11);
  assert.ok(output.warnings.some((warning) => warning.code === "posts_only_unverified"));
  assert.equal(result.isError, false);
});
