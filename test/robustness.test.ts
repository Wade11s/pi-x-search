import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readConfig } from "../src/config.ts";
import * as output from "../src/output.ts";
import { failureResult, SearchError, searchContext } from "../src/result.ts";
import { createXSearchTool } from "../src/tool.ts";
import { normalizeParams, parseResponse, searchX } from "../src/xai.ts";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";

const MAX_BODY_BYTES = 16 * 1024 * 1024;
const config = readConfig({});
const params = normalizeParams({ query: "test" });
const credential = async () => ({ apiKey: "test-secret", source: "oauth" as const });
const context = searchContext(params, config.model);
const url = "https://x.com/xai/status/123";
const ctx = {
  modelRegistry: { getProviderAuth: async () => ({ auth: { apiKey: "test-secret" }, source: "OAuth" }), find: () => undefined },
} as unknown as ExtensionToolContext;
function sizeError(error: unknown): boolean {
  assert.ok(error instanceof SearchError);
  assert.equal(error.code, "invalid_response");
  assert.equal(error.retryable, true);
  assert.match(error.message, /size limit/);
  return true;
}

for (const status of [200, 429]) {
  test(`oversized Content-Length is rejected before reading HTTP ${status} body`, async () => {
    let reads = 0, cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { reads++; controller.enqueue(new TextEncoder().encode('{"output_text":"ok"}')); controller.close(); },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 });
    await assert.rejects(searchX(params, config, credential, undefined, async () => new Response(body, {
      status, headers: { "content-length": String(MAX_BODY_BYTES + 1) },
    })), sizeError);
    assert.equal(reads, 0);
    assert.equal(cancelled, true);
  });
}

for (const contentLength of [undefined, "1", "not-a-number"]) {
  test(`streaming cap rejects a chunked body with Content-Length ${contentLength}`, async () => {
    let reads = 0, cancelled = false;
    const chunk = new Uint8Array(MAX_BODY_BYTES / 2);
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { reads++; controller.enqueue(chunk); if (reads === 4) controller.close(); },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 });
    await assert.rejects(searchX(params, config, credential, undefined, async () => new Response(body, {
      headers: contentLength === undefined ? {} : { "content-length": contentLength },
    })), sizeError);
    assert.equal(reads, 3, "must stop immediately when actual bytes exceed the cap");
    assert.equal(cancelled, true);
  });
}

test("the body cap counts UTF-8 bytes rather than string characters", async () => {
  const body = new TextEncoder().encode(JSON.stringify({ output_text: "🚀".repeat(MAX_BODY_BYTES / 4) }));
  await assert.rejects(searchX(params, config, credential, undefined, async () => new Response(body)), sizeError);
});

test("a valid body exactly at the size limit is accepted", async () => {
  const overhead = Buffer.byteLength(JSON.stringify({ output_text: "" }));
  const answer = "x".repeat(MAX_BODY_BYTES - overhead);
  const body = JSON.stringify({ output_text: answer });
  assert.equal(Buffer.byteLength(body), MAX_BODY_BYTES);
  const result = await searchX(params, config, credential, undefined, async () => new Response(body));
  assert.equal(result.answer.length, answer.length);
});

test("bounded body parsing preserves split UTF-8 sequences and JSON BOM handling", async () => {
  const bytes = new TextEncoder().encode('\ufeff{"output_text":"搜索🚀"}');
  const body = new ReadableStream<Uint8Array>({ start(controller) {
    for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
    controller.close();
  } });
  const result = await searchX(params, config, credential, undefined, async () => new Response(body));
  assert.equal(result.answer, "搜索🚀");
});

for (const reason of ["timeout", "cancelled"] as const) {
  test(`${reason} during a stalled body read cancels the stream`, async () => {
    let entered: () => void = () => {}, cancelled = false;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const body = new ReadableStream<Uint8Array>({
      pull() { entered(); return new Promise(() => {}); },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 });
    const controller = new AbortController();
    const pending = searchX(params, { ...config, timeoutMs: reason === "timeout" ? 50 : config.timeoutMs },
      credential, controller.signal, async () => new Response(body));
    await started;
    if (reason === "cancelled") controller.abort();
    await assert.rejects(pending, (error: unknown) => {
      assert.ok(error instanceof SearchError);
      assert.equal(error.code, reason);
      return true;
    });
    assert.equal(cancelled, true);
  });
}

for (const json of [true, false]) {
  test(`429 Retry-After seconds survive ${json ? "JSON" : "non-JSON"} errors without retrying`, async () => {
    let calls = 0;
    await assert.rejects(searchX(params, config, credential, undefined, async () => {
      calls++;
      return new Response(json ? '{"error":{"message":"test-secret"}}' : "private body", {
        status: 429, headers: { "Retry-After": "120" },
      });
    }), (error: unknown) => {
      assert.ok(error instanceof SearchError);
      assert.equal(error.httpStatus, 429);
      assert.equal(error.retryable, true);
      assert.match(error.message, /Retry after 120 seconds/);
      assert.equal(error.message.includes("test-secret"), false);
      return true;
    });
    assert.equal(calls, 1);
  });
}

test("429 HTTP-date Retry-After is converted to nonnegative whole seconds", async (t) => {
  const now = Date.UTC(2026, 0, 1);
  t.mock.method(Date, "now", () => now);
  for (const [time, seconds] of [[now + 90_000, 90], [now - 90_000, 0]]) {
    await assert.rejects(searchX(params, config, credential, undefined, async () => new Response("not JSON", {
      status: 429, headers: { "Retry-After": new Date(time!).toUTCString() },
    })), new RegExp(`Retry after ${seconds} seconds`));
  }
});

test("invalid Retry-After values are ignored and never echoed", async () => {
  for (const value of ["test-secret", "-1", "1.5", "Infinity", "999999999999999999999"]) {
    await assert.rejects(searchX(params, config, credential, undefined, async () => new Response("not JSON", {
      status: 429, headers: { "Retry-After": value },
    })), (error: unknown) => {
      assert.ok(error instanceof SearchError);
      assert.equal(error.message.includes("Retry after"), false);
      assert.equal(error.message.includes("test-secret"), false);
      return true;
    });
  }
});

test("exact inline citation duplicates collapse but distinct blocks/coordinates remain", () => {
  const annotation = { type: "url_citation", url, start_index: 0, end_index: 3 };
  const part = { type: "output_text", text: "evidence", annotations: [
    annotation, { ...annotation, title: "duplicate" },
    { ...annotation, start_index: 4, end_index: 7 },
    { type: "url_citation", url }, { type: "url_citation", url },
  ] };
  const result = parseResponse({ output: [{ type: "message", content: [part, part] }] }, context);
  assert.equal(result.inline_citations.length, 6);
  assert.deepEqual(result.inline_citations.map(({ text_index, start_index, end_index }) => [text_index, start_index, end_index]), [
    [0, 0, 3], [0, 4, 7], [0, null, null], [1, 0, 3], [1, 4, 7], [1, null, null],
  ]);
  assert.equal(result.citation_count, 1);
  assert.deepEqual(result.citation_texts, ["evidence", "evidence"]);
});

test("Pi progress updates mark auth, request and parsing without exposing data or claiming success", async () => {
  const updates: string[] = [];
  const tool = createXSearchTool({ env: {}, fetch: async () => {
    assert.equal(updates.length, 2, "request update must arrive before fetch resolves");
    return Response.json({ output_text: "ok" });
  } });
  const result = await tool.execute("progress", { query: "private research", research_mode: "deep" }, undefined, (partial) => {
    assert.equal(partial.structuredContent, undefined);
    assert.equal(partial.details, undefined);
    updates.push((partial.content[0] as { text: string }).text);
  }, ctx);
  assert.equal(result.isError, false);
  assert.deepEqual(updates, ["X Search: resolving credentials…", "X Search: requesting xAI…", "X Search: parsing response…"]);
  assert.equal(JSON.stringify(updates).includes("private research"), false);
  assert.equal(JSON.stringify(updates).includes("test-secret"), false);
});

test("progress observer exceptions cannot interrupt a billable search", async () => {
  const tool = createXSearchTool({ env: {}, fetch: async () => Response.json({ output_text: "ok" }) });
  const result = await tool.execute("observer", { query: "test" }, undefined, () => { throw new Error("observer failure"); }, ctx);
  assert.equal(result.isError, false);
});

test("stale output cleanup removes only old owned directories, not recent ones, files or symlinks", async () => {
  const root = await mkdtemp(join(tmpdir(), "x-search-cleanup-test-"));
  const now = Date.now(), old = new Date(now - 25 * 60 * 60 * 1000);
  try {
    const stale = join(root, "pi-x-search-OLD123"), recent = join(root, "pi-x-search-NEW123");
    const unrelated = join(root, "other-output"), target = join(root, "target");
    for (const path of [stale, recent, unrelated, target]) {
      await mkdir(path, { mode: 0o700 });
      await writeFile(join(path, "result.json"), "keep");
    }
    const file = join(root, "pi-x-search-FIL123");
    await writeFile(file, "keep");
    await symlink(target, join(root, "pi-x-search-LNK123"));
    await Promise.all([stale, unrelated, target, file].map(path => utimes(path, old, old)));
    await output.cleanupStaleOutputs(root, now);
    await assert.rejects(lstat(stale), { code: "ENOENT" });
    assert.equal(await readFile(join(recent, "result.json"), "utf8"), "keep");
    assert.equal(await readFile(join(unrelated, "result.json"), "utf8"), "keep");
    assert.equal(await readFile(join(target, "result.json"), "utf8"), "keep");
    assert.equal(await readFile(file, "utf8"), "keep");
    assert.equal((await lstat(join(root, "pi-x-search-LNK123"))).isSymbolicLink(), true);
    await output.cleanupStaleOutputs(join(root, "missing"), now); // best effort
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("optional internal diagnostics omit error messages, causes, secrets and absolute paths", (t) => {
  const calls: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => { calls.push(args); });
  const error = Object.assign(new TypeError("secret-provider-header"), { code: "ENOSPC", cause: "another-secret" });
  error.stack = "TypeError: secret-provider-header\n    at prepareOutput (/private/home/src/output.ts:55:3)";
  failureResult(context, error);
  assert.equal(calls.length, 0, "diagnostics are opt-in");
  failureResult(context, error, true);
  assert.equal(calls.length, 1);
  assert.match(JSON.stringify(calls), /TypeError/);
  assert.match(JSON.stringify(calls), /ENOSPC/);
  assert.match(JSON.stringify(calls), /output.ts:55:3/);
  for (const secret of ["secret-provider-header", "another-secret", "/private/home"]) assert.equal(JSON.stringify(calls).includes(secret), false);
});

test("diagnostic logger failures cannot escape failureResult", (t) => {
  t.mock.method(console, "error", () => { throw new Error("logger failure"); });
  assert.equal(failureResult(context, new Error("secret"), true).error.code, "internal_error");
});

test("trusted transport does not normalize already-normalized handles again", async () => {
  const normalized = normalizeParams({ query: " test ", allowed_x_handles: ["@XAI"] });
  Object.defineProperty(normalized.allowed_x_handles!, "map", { value: () => { assert.fail("duplicate normalization"); } });
  const result = await searchX(normalized, config, credential, undefined, async () => Response.json({ output_text: "ok" }));
  assert.equal(result.query, "test");
  assert.deepEqual(result.filters.allowed_x_handles, ["xai"]);
});

test("output candidates are serialized only once per sort, not per comparator call", () => {
  const citations = Array.from({ length: 1_000 }, (_, i) => `${url}${i}`);
  let serialized = 0;
  Object.defineProperty(citations, "toJSON", { value: () => { serialized++; return [...citations]; } });
  const full = { ...parseResponse({ output_text: "ok" }, context), answer: "x".repeat(120_000), citations };
  const bounded = output.limitOutput(full, 130_000);
  assert.ok(bounded.success);
  assert.equal(bounded.answer.length, 60_000, "fixture should require a single truncation round");
  assert.ok(serialized <= 4, `retained candidate serialized ${serialized} times in one round`);
});

test("failed output writes remove their newly-created temporary directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "x-search-write-test-"));
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = root;
  try {
    const full = parseResponse({ output_text: "ok" }, context);
    let reads = 0;
    Object.defineProperty(full, "answer", { get() {
      if (++reads === 2) throw new Error("serialization failed during write");
      return "x".repeat(60_000);
    } });
    await assert.rejects(output.prepareOutput(full), /serialization failed during write/);
    assert.deepEqual(await readdir(root), []);
  } finally {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("PI_X_SEARCH_DEBUG enables only redacted diagnostics for unexpected tool errors", async (t) => {
  const calls: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => { calls.push(args); });
  const env = { PI_X_SEARCH_DEBUG: "1" };
  Object.defineProperty(env, "PI_X_SEARCH_MODEL", { get() { throw Object.assign(new Error("private-secret"), { code: "ENOSPC" }); } });
  const result = await createXSearchTool({ env }).execute("debug", { query: "test" }, undefined, undefined, ctx);
  assert.equal(result.isError, true);
  assert.equal(calls.length, 1);
  assert.match(JSON.stringify(calls), /ENOSPC/);
  assert.equal(JSON.stringify([result, calls]).includes("private-secret"), false);
});
