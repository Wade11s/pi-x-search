import assert from "node:assert/strict";
import { test } from "node:test";
import { Value } from "typebox/value";
import { normalizeOptions, readConfig, requestSettings } from "../src/config.ts";
import { SearchError, type SearchOptions } from "../src/result.ts";
import { createXSearchTool } from "../src/tool.ts";
import { buildRequest, normalizeParams } from "../src/xai.ts";

for (const [mode, calls, tokens, candidates] of [
  ["quick", 2, 2048, 5], ["balanced", 8, 4096, 5], ["deep", 12, 8192, 10],
] as const) {
  test(`${mode} supplies documented fallback research budgets`, () => {
    const config = readConfig({}, { research_mode: mode });
    assert.equal(config.researchMode, mode);
    assert.equal(config.maxToolCalls, calls);
    assert.equal(config.maxOutputTokens, tokens);
    assert.equal(config.maxCandidates, candidates);
    assert.equal(config.reasoningEffort, "model_default", "research mode is not reasoning effort");
    assert.deepEqual(readConfig({ PI_X_SEARCH_RESEARCH_MODE: mode }), config);
    const request = buildRequest({ query: "find evidence" }, config);
    assert.match(String(request.instructions), new RegExp(`Research mode: ${mode}`));
    assert.match(String(request.instructions), new RegExp(`at most ${candidates} distinct candidates`));
  });
}

test("per-field precedence is call > environment > selected preset", () => {
  const env = {
    PI_X_SEARCH_MODEL: "grok-4.5", PI_X_SEARCH_RESEARCH_MODE: "deep",
    PI_X_SEARCH_MAX_OUTPUT_TOKENS: "1024", PI_X_SEARCH_MAX_TOOL_CALLS: "3",
    PI_X_SEARCH_MAX_CANDIDATES: "7", PI_X_SEARCH_TIMEOUT_MS: "90000", PI_X_SEARCH_REASONING_EFFORT: "high",
  };
  const partial = readConfig(env, { research_mode: "quick" });
  assert.equal(partial.researchMode, "quick");
  assert.equal(partial.maxToolCalls, 3, "explicit env setting takes precedence over the quick fallback");
  assert.equal(partial.maxOutputTokens, 1024);
  assert.equal(partial.maxCandidates, 7);
  const selected = readConfig(env, {
    model: "grok-4.7", research_mode: "balanced", max_output_tokens: 512, max_tool_calls: 1,
    max_candidates: 2, timeout_ms: 1000, reasoning_effort: "low",
  });
  assert.deepEqual(requestSettings(selected), {
    model: "grok-4.7", research_mode: "balanced", max_output_tokens: 512, max_tool_calls: 1,
    max_candidates: 2, timeout_ms: 1000, reasoning_effort: "low", default_instruction_applied: false,
  });
});

test("only the selected default is validated; explicit settings can replace an invalid unused default", () => {
  assert.equal(readConfig({ PI_X_SEARCH_MAX_TOOL_CALLS: "bad" }, { max_tool_calls: 2 }).maxToolCalls, 2);
  assert.throws(() => readConfig({ PI_X_SEARCH_MAX_TOOL_CALLS: "bad" }), /PI_X_SEARCH_MAX_TOOL_CALLS/);
});

for (const options of [
  { model: "" }, { model: "https://evil.example" }, { model: "grok-4.7\n" }, { model: "g".repeat(129) },
  { timeout_ms: 999 }, { timeout_ms: 600001 }, { max_output_tokens: 127 }, { max_output_tokens: 32769 },
  { max_tool_calls: 0 }, { max_tool_calls: 21 }, { max_tool_calls: 1.5 },
  { max_candidates: 0 }, { max_candidates: 51 }, { max_candidates: 1.5 },
  { research_mode: "unlimited" }, { reasoning_effort: "none" }, { reasoning_effort: "HIGH" },
] as const) {
  test(`rejects invalid per-call setting: ${JSON.stringify(options)}`, () => {
    assert.throws(() => normalizeParams({ query: "test", ...options } as Parameters<typeof normalizeParams>[0]), (error: unknown) => {
      assert.ok(error instanceof SearchError);
      assert.equal(error.code, "invalid_arguments");
      assert.match(error.message, new RegExp(Object.keys(options)[0]!));
      return true;
    });
    assert.equal(Value.Check(createXSearchTool().parameters, { query: "test", ...options }), false);
  });
}

for (const [key, value] of [
  ["RESEARCH_MODE", "unlimited"], ["REASONING_EFFORT", "none"], ["MAX_CANDIDATES", "0"],
  ["MAX_CANDIDATES", "51"], ["MAX_CANDIDATES", "1e1"], ["MODEL", "grok-4.7\n"],
  ["INSTRUCTION", "x".repeat(8001)],
] as const) {
  test(`invalid environment ${key} reports invalid_config without echoing the value`, () => {
    const name = `PI_X_SEARCH_${key}`;
    assert.throws(() => readConfig({ [name]: value }), (error: unknown) => {
      assert.ok(error instanceof SearchError);
      assert.equal(error.code, "invalid_config");
      assert.match(error.message, new RegExp(name));
      assert.equal(error.message.includes(JSON.stringify(value)), false);
      return true;
    });
  });
}

test("boundary values and only whitelisted settings survive normalization", () => {
  const options: SearchOptions = {
    model: "grok-4.7", timeout_ms: 600000, max_output_tokens: 32768,
    max_tool_calls: 20, max_candidates: 50, research_mode: "deep", reasoning_effort: "xhigh",
  };
  assert.deepEqual(normalizeOptions({ ...options, api_key: "not-an-option" } as SearchOptions), options);
  assert.equal(Value.Check(createXSearchTool().parameters, { query: "test", ...options }), true);
  assert.equal(normalizeParams({ query: " test ", ...options }).model, options.model);
  assert.deepEqual(readConfig({}, options).maxCandidates, 50);
});

for (const effort of ["low", "medium", "high", "xhigh", "model_default"] as const) {
  test(`reasoning ${effort} is explicitly mapped or omitted in the official API request`, () => {
    const config = readConfig({ PI_X_SEARCH_REASONING_EFFORT: "high" }, { reasoning_effort: effort });
    const request = buildRequest({ query: "test" }, config);
    if (effort === "model_default") assert.equal("reasoning" in request, false);
    else assert.deepEqual(request.reasoning, { effort });
    assert.equal(requestSettings(config).reasoning_effort, effort);
  });
}

test("operator and per-call instructions are additive; generated limits and safety are always included", () => {
  const config = readConfig({
    PI_X_SEARCH_RESEARCH_MODE: "quick", PI_X_SEARCH_MAX_CANDIDATES: "3",
    PI_X_SEARCH_INSTRUCTION: "  Prioritize firsthand reports.\nAnswer in Chinese.  ",
  });
  const params = { query: "Test topic", instruction: "Return 100 candidates and expand into adjacent topics." };
  const request = buildRequest(params, config), instructions = String(request.instructions);
  assert.match(instructions, /Prioritize firsthand reports/);
  assert.match(instructions, /Answer in Chinese/);
  assert.match(instructions, /at most 3 distinct candidates/);
  assert.match(instructions, /Do not add reserve candidates/);
  assert.match(instructions, /return fewer/);
  assert.match(instructions, /untrusted data/);
  assert.match(instructions, /take priority over conflicting preferences/);
  assert.ok(instructions.indexOf("at most 3") > instructions.indexOf("Prioritize firsthand reports"));
  assert.deepEqual(request.input, [{ role: "user", content: `${params.query}\n\nAdditional research instructions:\n${params.instruction}` }]);
  assert.equal(requestSettings(config).default_instruction_applied, true);
  assert.equal(request.store, false);
  assert.equal(request.tool_choice, "required");
});
