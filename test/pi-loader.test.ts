import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { loadSearchSession } from "../scripts/load-session.ts";
import { OutputSchema } from "../src/result.ts";

// Real Pi loading and credential orchestration, but fake OAuth/network and a
// temporary dummy credential file. Never touches the user's auth.json or quota.
test("Pi loads the package and refreshes an expired OAuth credential once for concurrent x_search calls", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-x-search-loader-test-"));
  const authPath = join(directory, "auth.json");
  await writeFile(authPath, JSON.stringify({ xai: {
    type: "oauth", access: "expired-test-token", refresh: "test-refresh-token", expires: 0,
  } }), { mode: 0o600 });
  const runtime = await ModelRuntime.create({
    authPath, modelsPath: null, modelsStorePath: join(directory, "models.json"),
    allowModelNetwork: false, refreshOnCreate: false,
  });
  const provider = runtime.getProvider("xai")!;
  let refreshes = 0;
  runtime.registerNativeProvider({ ...provider, auth: {
    ...provider.auth,
    oauth: {
      ...provider.auth.oauth!,
      refresh: async (credential) => {
        refreshes++;
        return { ...credential, access: "refreshed-test-token", expires: Date.now() + 3_600_000 };
      },
      toAuth: async (credential) => ({ apiKey: credential.access }),
    },
  } });
  const savedFetch = globalThis.fetch;
  const authorizations: string[] = [];
  globalThis.fetch = async (url, init) => {
    assert.equal(url, "https://api.x.ai/v1/responses");
    authorizations.push(new Headers(init?.headers).get("authorization")!);
    return Response.json({
      model: "grok-4.7", status: "completed", output_text: "A test post.",
      citations: ["https://x.com/xai/status/123"],
    });
  };
  let session: Awaited<ReturnType<typeof loadSearchSession>> | undefined;
  try {
    session = await loadSearchSession(runtime, directory);
    const tool = session.agent.state.tools.find((tool) => tool.name === "x_search");
    assert.ok(tool, "x_search must be loaded and active in an actual Pi session");
    const results = await Promise.all([
      tool.execute("parallel-1", { query: "xai" }, new AbortController().signal),
      tool.execute("parallel-2", { query: "grok" }, new AbortController().signal),
    ]);
    assert.equal(refreshes, 1);
    assert.deepEqual(authorizations, ["Bearer refreshed-test-token", "Bearer refreshed-test-token"]);
    assert.equal(JSON.parse(await readFile(authPath, "utf8")).xai.access, "refreshed-test-token");
    for (const result of results) {
      assert.ok(Value.Check(OutputSchema, result.structuredContent));
      assert.equal(result.structuredContent.success, true);
      assert.equal(result.structuredContent.credential_source, "oauth");
      assert.equal(JSON.stringify(result).includes("refreshed-test-token"), false);
    }
  } finally {
    session?.dispose();
    globalThis.fetch = savedFetch;
    await rm(directory, { recursive: true, force: true });
  }
});

test("real Pi codemode batches schema objects, discriminates structured failures and sees more than the model preview", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-x-search-codemode-test-"));
  const authPath = join(directory, "auth.json");
  await writeFile(authPath, JSON.stringify({ xai: { type: "api_key", key: "codemode-test-key" } }), { mode: 0o600 });
  const runtime = await ModelRuntime.create({
    authPath, modelsPath: null, modelsStorePath: join(directory, "models.json"),
    allowModelNetwork: false, refreshOnCreate: false,
  });
  const largeText = "Evidence ".repeat(14_000);
  const calls: string[] = [];
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.equal(url, "https://api.x.ai/v1/responses");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer codemode-test-key");
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, "grok-4.7");
    assert.equal(body.max_output_tokens, 1024);
    assert.equal(body.max_tool_calls, 1);
    assert.deepEqual(body.reasoning, { effort: "low" });
    assert.match(body.instructions, /Research mode: quick/);
    assert.match(body.instructions, /at most 2 distinct candidates/);
    assert.match(body.instructions, /Posts-only restriction/);
    assert.match(body.input[0].content, / -filter:replies$/);
    assert.equal("posts_only" in body.tools[0], false);
    const query = body.input[0].content.replace(/ -filter:replies$/, "");
    calls.push(query);
    if (query === "rate") return Response.json({ error: { message: "Rate limited" } }, { status: 429 });
    return Response.json({ model: "grok-4.7", status: "completed", output: [{ type: "message", content: [{
      type: "output_text", text: query === "large" ? largeText : "Small finding", annotations: [{
        type: "url_citation", url: "https://x.com/xai/status/123", start_index: 0, end_index: 8,
      }],
    }] }], usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 } });
  };
  let session: Awaited<ReturnType<typeof loadSearchSession>> | undefined;
  const spillDirectories: string[] = [];
  try {
    session = await loadSearchSession(runtime, directory, { codemode: true });
    const codemode = session.agent.state.tools.find((tool) => tool.name === "codemode");
    assert.ok(codemode, "built-in codemode must be active in an actual Pi session");
    const childUsage: Array<{ id: string; tokens: number }> = [];
    session.subscribe((event) => {
      if (event.type === "tool_execution_end" && event.toolName === "x_search" && event.result.usage) {
        childUsage.push({ id: event.toolCallId, tokens: event.result.usage.totalTokens });
      }
    });
    const code = `
      const outcomes = await Promise.allSettled(["large", "rate", " ", "", "small"].map(query =>
        tools.x_search({ query, allowed_x_handles: ["xai"], model: "grok-4.7", research_mode: "quick",
          max_output_tokens: 1024, max_tool_calls: 1, max_candidates: 2, reasoning_effort: "low", timeout_ms: 30000, posts_only: true })
      ));
      return { rows: outcomes.map(outcome => {
        if (outcome.status === "rejected") return { kind: "rejected", message: String(outcome.reason) };
        const r = outcome.value;
        if (!r.success) return { kind: "error", code: r.error.code, retryable: r.error.retryable };
        return { kind: "success", object_type: typeof r, query: r.query,
          answer_length: r.answer.length, cited_text_length: r.citation_texts[0].length,
          citation_count: r.citation_count, truncated: r.truncated, posts_only: r.filters.posts_only,
          warning_codes: r.warnings.map(w => w.code),
          full_output_path: r.full_output_path, credential_source: r.credential_source, request_settings: r.request_settings };
      }) };
    `;
    // Nested calls require an issuing assistant message in Pi's actual pipeline.
    // Seed that message rather than making any real model request.
    session.agent.state.messages = [...session.agent.state.messages, {
      role: "assistant", api: "openai-responses", provider: "xai", model: "grok-4.7",
      content: [{ type: "toolCall", id: "batch", name: "codemode", arguments: { code } }],
      stopReason: "toolUse", timestamp: Date.now(),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    }];
    const result = await codemode.execute("batch", { code }, new AbortController().signal);
    assert.ok(!result.isError, JSON.stringify(result.content));
    const text = result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
    const projected = JSON.parse(text.slice(text.indexOf("{")));
    for (const row of projected.rows) {
      if (row.full_output_path) spillDirectories.push(join(row.full_output_path, ".."));
    }
    assert.equal(projected.rows[0].kind, "success", JSON.stringify(projected));
    assert.equal(projected.rows[0].object_type, "object");
    assert.equal(projected.rows[0].answer_length, largeText.trim().length);
    assert.equal(projected.rows[0].cited_text_length, largeText.length);
    assert.equal(projected.rows[0].citation_count, 1);
    assert.equal(projected.rows[0].truncated, false);
    assert.equal(projected.rows[0].credential_source, "api_key");
    assert.equal(projected.rows[0].request_settings.research_mode, "quick");
    assert.equal(projected.rows[0].request_settings.max_candidates, 2);
    assert.equal(projected.rows[0].request_settings.max_tool_calls, 1);
    assert.equal(projected.rows[0].request_settings.reasoning_effort, "low");
    assert.equal(projected.rows[0].posts_only, true);
    assert.ok(projected.rows[0].warning_codes.includes("posts_only_unverified"));
    assert.ok(projected.rows[0].full_output_path);
    assert.deepEqual(projected.rows[1], { kind: "error", code: "http_error", retryable: true });
    assert.deepEqual(projected.rows[2], { kind: "error", code: "invalid_arguments", retryable: false });
    assert.equal(projected.rows[3].kind, "rejected");
    assert.equal(projected.rows[4].kind, "success");
    assert.deepEqual([...calls].sort(), ["large", "rate", "small"]);
    assert.equal(childUsage.length, 2);
    assert.equal(new Set(childUsage.map((entry) => entry.id)).size, 2);
    assert.equal(childUsage.reduce((sum, entry) => sum + entry.tokens, 0), 30);
    assert.equal(result.usage, undefined, "parent codemode must not double-count nested tool usage");
    assert.ok(Buffer.byteLength(text) < 5_000, "unprinted nested evidence must not flood model context");
    assert.equal(text.includes("codemode-test-key"), false);
  } finally {
    session?.dispose();
    globalThis.fetch = savedFetch;
    await Promise.all([directory, ...spillDirectories].map((path) => rm(path, { recursive: true, force: true })));
  }
});
