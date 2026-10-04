import { Type } from "typebox";
import { Value } from "typebox/value";
import {
  ReasoningEffortSchema, ResearchModeSchema, SearchError,
  type RequestSettings, type ResearchMode, type SearchOptions,
} from "./result.ts";

export const DEFAULT_MODEL = "grok-4.7";

export interface SearchConfig {
  model: string;
  timeoutMs: number;
  maxOutputTokens: number;
  maxToolCalls: number;
  researchMode: ResearchMode;
  maxCandidates: number;
  reasoningEffort: RequestSettings["reasoning_effort"];
  defaultInstruction: string;
}

const limits = {
  timeout_ms: { minimum: 1_000, maximum: 600_000 },
  max_output_tokens: { minimum: 128, maximum: 32_768 },
  max_tool_calls: { minimum: 1, maximum: 20 },
  max_candidates: { minimum: 1, maximum: 50 },
} as const;
const modelPattern = "^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}(?![\\s\\S])";
export const SearchOptionProperties = {
  model: Type.Optional(Type.String({ minLength: 1, maxLength: 128, pattern: modelPattern,
    description: `Override the xAI search model for this call, not the Pi assistant model. Defaults to PI_X_SEARCH_MODEL or ${DEFAULT_MODEL}. Must support X Search and your account's entitlement.` })),
  timeout_ms: Type.Optional(Type.Integer({ ...limits.timeout_ms, description: "Per-request timeout including auth resolution. Defaults to PI_X_SEARCH_TIMEOUT_MS or 180000. Does not control codemode's own timeout." })),
  max_output_tokens: Type.Optional(Type.Integer({ ...limits.max_output_tokens, description: "Output budget including reasoning. Overrides the environment/preset default; not a result-count or spending cap." })),
  max_tool_calls: Type.Optional(Type.Integer({ ...limits.max_tool_calls, description: "Server-side tool-call budget passed to xAI. Not a cap on retrieved posts, candidate count, or subsequent Pi tool invocations." })),
  research_mode: Type.Optional({ ...ResearchModeSchema, description: "Research strategy and fallback budgets: quick=2 calls/2048 tokens/5 candidates, balanced=8/4096/5 (default), deep=12/8192/10. Explicit call settings or environment defaults take precedence. Does not set reasoning effort." }),
  max_candidates: Type.Optional(Type.Integer({ ...limits.max_candidates, description: "At most this many distinct candidates requested in the generated research instructions. SOFT limit: does not truncate citations or bound posts fetched. Defaults to environment/preset." })),
  reasoning_effort: Type.Optional({ ...ReasoningEffortSchema, description: "Optional Grok reasoning effort; model_default omits reasoning.effort and overrides any configured effort. Only use explicit effort on supported models. Not a search-count limit." }),
};

const presets: Record<ResearchMode, { calls: number; tokens: number; candidates: number }> = {
  quick: { calls: 2, tokens: 2_048, candidates: 5 },
  balanced: { calls: 8, tokens: 4_096, candidates: 5 },
  deep: { calls: 12, tokens: 8_192, candidates: 10 },
};

function optionDescription(key: keyof SearchOptions): string {
  return (SearchOptionProperties[key] as { description?: string }).description ?? "Use a supported value.";
}

/** Whitelist and validate per-call settings even outside Pi's schema pipeline. */
export function normalizeOptions(input: SearchOptions): SearchOptions {
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(SearchOptionProperties) as Array<keyof SearchOptions>) {
    if (input[key] === undefined) continue;
    const schema = SearchOptionProperties[key];
    if (!Value.Check(schema, input[key])) {
      throw new SearchError("invalid_arguments", `${key} is invalid. ${optionDescription(key)}`);
    }
    result[key] = input[key];
  }
  return result as SearchOptions;
}
function envValue<K extends keyof SearchOptions>(
  env: Record<string, string | undefined>, key: K, fallback: NonNullable<SearchOptions[K]>,
): NonNullable<SearchOptions[K]> {
  const name = `PI_X_SEARCH_${key.toUpperCase()}`, raw = env[name];
  if (raw === undefined) return fallback;
  const range = key in limits ? limits[key as keyof typeof limits] : undefined;
  const value: unknown = range && /^\d+$/.test(raw) ? Number(raw) : raw;
  if (!Value.Check(SearchOptionProperties[key], value)) {
    throw new SearchError("invalid_config", range
      ? `${name} must be an integer between ${range.minimum} and ${range.maximum}.`
      : `${name} is invalid. ${optionDescription(key)}`);
  }
  return value as NonNullable<SearchOptions[K]>;
}

/** Priority: explicit call option > environment default > selected preset. */
export function readConfig(env: Record<string, string | undefined> = process.env, input: SearchOptions = {}): SearchConfig {
  const options = normalizeOptions(input);
  const researchMode = options.research_mode ?? envValue(env, "research_mode", "balanced");
  const preset = presets[researchMode];
  const custom = env.PI_X_SEARCH_INSTRUCTION ?? "";
  if (custom.length > 8_000) {
    throw new SearchError("invalid_config", "PI_X_SEARCH_INSTRUCTION must be a string of at most 8000 characters.");
  }
  return {
    model: options.model ?? envValue(env, "model", DEFAULT_MODEL),
    timeoutMs: options.timeout_ms ?? envValue(env, "timeout_ms", 180_000),
    maxOutputTokens: options.max_output_tokens ?? envValue(env, "max_output_tokens", preset.tokens),
    maxToolCalls: options.max_tool_calls ?? envValue(env, "max_tool_calls", preset.calls),
    researchMode,
    maxCandidates: options.max_candidates ?? envValue(env, "max_candidates", preset.candidates),
    reasoningEffort: options.reasoning_effort ?? envValue(env, "reasoning_effort", "model_default"),
    defaultInstruction: custom.trim(),
  };
}

export function requestSettings(config: SearchConfig): RequestSettings {
  return {
    model: config.model, timeout_ms: config.timeoutMs,
    max_output_tokens: config.maxOutputTokens, max_tool_calls: config.maxToolCalls,
    research_mode: config.researchMode, max_candidates: config.maxCandidates,
    reasoning_effort: config.reasoningEffort, default_instruction_applied: !!config.defaultInstruction,
  };
}
