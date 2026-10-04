import assert from "node:assert/strict";
import { readFile, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { test } from "node:test";
import { DEFAULT_MAX_BYTES } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { limitOutput, MAX_STRUCTURED_BYTES, prepareOutput } from "../src/output.ts";
import { failureResult, OutputSchema, SearchError, searchContext, type SearchResult } from "../src/result.ts";
import { parseResponse } from "../src/xai.ts";

const context = searchContext({ query: "test", allowed_x_handles: ["xai"] }, "grok-4.7", "oauth");
const url = "https://x.com/xai/status/123";
function fullResult(): SearchResult {
  return parseResponse({ output_text: "A cited finding.", citations: [url] }, context);
}
function assertReferences(result: SearchResult): void {
  for (const citation of result.inline_citations) {
    assert.ok(citation.text_index < result.citation_texts.length);
    assert.ok(result.citation_texts[citation.text_index]);
  }
}

test("small output is compact valid JSON identical to the codemode object and needs no file", async () => {
  const full = fullResult(), prepared = await prepareOutput(full);
  assert.equal(prepared.result, full);
  assert.equal(prepared.preview, full);
  assert.equal(prepared.result.full_output_path, undefined);
  assert.deepEqual(JSON.parse(prepared.text), full);
  assert.equal(prepared.text.includes("\n"), false);
  assert.equal(prepared.text.startsWith("{"), true);
});

for (const [kind, answer, citations] of [
  ["Unicode bytes", "搜索🚀".repeat(20_000), [url]],
  ["escaped control characters", "\u0000".repeat(12_000), [url]],
  ["large citation list", "Short finding", Array.from({ length: 10_000 }, (_, index) => `https://x.com/xai/status/${index}`)],
] as const) {
  test(`model preview is bounded while codemode retains complete ${kind}`, async () => {
    const full = { ...fullResult(), answer, citations: [...citations], citation_count: citations.length };
    const prepared = await prepareOutput(full);
    const path = prepared.result.full_output_path!;
    try {
      assert.ok(Buffer.byteLength(prepared.text) <= DEFAULT_MAX_BYTES);
      assert.equal(prepared.preview.truncated, true);
      assert.ok(prepared.preview.truncated_fields.length > 0);
      assert.equal(prepared.result.truncated, false, "codemode must not inherit the smaller model-preview budget");
      assert.deepEqual({ ...prepared.result, full_output_path: undefined }, { ...full, full_output_path: undefined });
      assert.deepEqual(JSON.parse(prepared.text), prepared.preview);
      assert.equal(Value.Check(OutputSchema, prepared.preview), true);
      assert.equal(Value.Check(OutputSchema, prepared.result), true);
      assert.deepEqual(JSON.parse(await readFile(path, "utf8")), full);
      assert.equal((await stat(path)).mode & 0o777, 0o600);
      assert.equal((await stat(dirname(path))).mode & 0o777, 0o700);
    } finally { await rm(dirname(path), { recursive: true, force: true }); }
  });
}

test("JSON escaping means many source-text lines need no arbitrary pre-truncation for codemode", async () => {
  const full = { ...fullResult(), answer: "a\n".repeat(3_000) };
  const prepared = await prepareOutput(full);
  assert.equal(prepared.result.truncated, false);
  assert.equal(prepared.preview.truncated, false);
  assert.equal(prepared.result.full_output_path, undefined);
  assert.equal(prepared.text.split("\n").length, 1);
  assert.equal(prepared.result.success && prepared.result.answer, full.answer);
});

test("oversized structured results are bounded to 1 MiB without invalid JSON or split surrogate pairs", async () => {
  const full = { ...fullResult(), answer: "🚀".repeat(300_001) };
  const prepared = await prepareOutput(full), path = prepared.result.full_output_path!;
  try {
    assert.ok(Buffer.byteLength(JSON.stringify(prepared.result)) <= MAX_STRUCTURED_BYTES);
    assert.ok(Buffer.byteLength(prepared.text) <= DEFAULT_MAX_BYTES);
    assert.ok(prepared.result.success);
    assert.equal(prepared.result.truncated, true);
    assert.ok(prepared.result.truncated_fields.includes("answer"));
    assert.equal(/[\ud800-\udbff]$/.test(prepared.result.answer), false);
    assert.equal(full.answer.startsWith(prepared.result.answer), true);
    assert.equal(prepared.result.citation_count, full.citation_count);
    assert.equal(prepared.result.degraded, false);
    assert.equal(Value.Check(OutputSchema, prepared.result), true);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), full);
  } finally { await rm(dirname(path), { recursive: true, force: true }); }
});

test("truncation drops whole citation text blocks and their annotations rather than corrupting offsets", async () => {
  const text = "Evidence🚀".repeat(12_000);
  const full = parseResponse({ output: [{ type: "message", content: [{ type: "output_text", text, annotations: [
    { type: "url_citation", url, start_index: 2, end_index: 8 },
  ] }] }] }, context);
  const prepared = await prepareOutput(full), path = prepared.result.full_output_path!;
  try {
    assert.ok(prepared.result.success && prepared.preview.success);
    assert.equal(prepared.result.truncated, false);
    assert.equal(prepared.result.citation_texts[0], text);
    assert.deepEqual(prepared.result.inline_citations, full.inline_citations);
    assert.equal(prepared.preview.citation_count, 1);
    assert.equal(prepared.preview.degraded, false);
    assert.ok(prepared.preview.truncated_fields.includes("citation_texts"));
    assert.ok(prepared.preview.truncated_fields.includes("inline_citations"));
    assertReferences(prepared.preview);
    assert.equal(Value.Check(OutputSchema, prepared.preview), true);
  } finally { await rm(dirname(path), { recursive: true, force: true }); }
});

test("retained inline coordinates and source text are unchanged when citation arrays are reduced", () => {
  const full = { ...fullResult(), citation_texts: ["exact source"],
    inline_citations: Array.from({ length: 2_000 }, () => ({ url, text_index: 0, start_index: 0, end_index: 5 })),
  };
  const bounded = limitOutput(full, DEFAULT_MAX_BYTES);
  assert.ok(bounded.success);
  assert.ok(bounded.inline_citations.length < full.inline_citations.length);
  assert.equal(bounded.citation_texts[0], "exact source");
  assert.deepEqual(bounded.inline_citations[0], full.inline_citations[0]);
  assertReferences(bounded);
  assert.equal(full.inline_citations.length, 2_000, "must not mutate the full result");
});

test("failure previews use the same schema and explicitly flag a shortened query", async () => {
  const failure = failureResult({ ...context, query: "🚀".repeat(16_000) }, new SearchError("auth_unavailable", "No credential"));
  const prepared = await prepareOutput(failure), path = prepared.result.full_output_path!;
  try {
    assert.ok(!prepared.preview.success && !prepared.result.success);
    assert.equal(prepared.preview.truncated, true);
    assert.ok(prepared.preview.truncated_fields.includes("query"));
    assert.equal(prepared.preview.error.code, "auth_unavailable");
    assert.equal(prepared.result.query, failure.query);
    assert.equal(Value.Check(OutputSchema, prepared.preview), true);
  } finally { await rm(dirname(path), { recursive: true, force: true }); }
});
