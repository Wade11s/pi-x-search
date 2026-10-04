import { Type, type Static } from "typebox";

export const ResearchModeSchema = Type.Union([
  Type.Literal("quick"), Type.Literal("balanced"), Type.Literal("deep"),
]);
export const ReasoningEffortSchema = Type.Union([
  Type.Literal("model_default"), Type.Literal("low"), Type.Literal("medium"), Type.Literal("high"), Type.Literal("xhigh"),
]);
export type ResearchMode = Static<typeof ResearchModeSchema>;
export type ReasoningEffort = Static<typeof ReasoningEffortSchema>;
export type SearchOptions = {
  model?: string;
  timeout_ms?: number;
  max_output_tokens?: number;
  max_tool_calls?: number;
  research_mode?: ResearchMode;
  max_candidates?: number;
  reasoning_effort?: ReasoningEffort;
};
export type SearchParams = SearchOptions & {
  query: string;
  instruction?: string;
  allowed_x_handles?: string[];
  excluded_x_handles?: string[];
  from_date?: string;
  to_date?: string;
  posts_only?: boolean;
  enable_image_understanding?: boolean;
  enable_video_understanding?: boolean;
};

const CredentialSourceSchema = Type.Union([
  Type.Literal("oauth"), Type.Literal("api_key"), Type.Literal("unknown"),
]);
export type CredentialSource = Static<typeof CredentialSourceSchema>;
export type XaiCredential = { apiKey?: string; source: CredentialSource };

const FiltersSchema = Type.Object({
  allowed_x_handles: Type.Optional(Type.Array(Type.String())),
  excluded_x_handles: Type.Optional(Type.Array(Type.String())),
  from_date: Type.Optional(Type.String()),
  to_date: Type.Optional(Type.String()),
  posts_only: Type.Optional(Type.Boolean({ description: "Requested best-effort exclusion of replies, not independently verified post types." })),
});
const SourceSchema = Type.Object({ url: Type.String(), title: Type.Optional(Type.String()) });
const IndexSchema = Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]);
const InlineCitationSchema = Type.Object({
  url: Type.String(),
  title: Type.Optional(Type.String()),
  text_index: Type.Integer({ minimum: 0, description: "Index into citation_texts. Provider offsets refer to this exact text, not answer." }),
  start_index: IndexSchema,
  end_index: IndexSchema,
});
const UsageSchema = Type.Object({
  input_tokens: Type.Number(), output_tokens: Type.Number(), cached_input_tokens: Type.Number(), total_tokens: Type.Number(),
  reasoning_tokens: Type.Optional(Type.Number()), cost_usd: Type.Optional(Type.Number()),
  x_search_calls: Type.Optional(Type.Integer({ minimum: 0 })),
  x_posts_fetched: Type.Optional(Type.Integer({ minimum: 0 })),
  x_users_fetched: Type.Optional(Type.Integer({ minimum: 0 })),
});
const RequestSettingsSchema = Type.Object({
  model: Type.String(),
  timeout_ms: Type.Integer(),
  max_output_tokens: Type.Integer(),
  max_tool_calls: Type.Integer(),
  research_mode: ResearchModeSchema,
  max_candidates: Type.Integer({ description: "Prompt-level candidate limit, not a hard cap on retrieved posts or citations." }),
  reasoning_effort: ReasoningEffortSchema,
  default_instruction_applied: Type.Boolean(),
});
const WarningSchema = Type.Object({ code: Type.String(), message: Type.String() });
const ContextProperties = {
  provider: Type.Literal("xai"),
  tool: Type.Literal("x_search"),
  query: Type.String(),
  model: Type.String(),
  credential_source: CredentialSourceSchema,
  filters: FiltersSchema,
  request_settings: Type.Optional(RequestSettingsSchema),
};
const CommonProperties = {
  ...ContextProperties,
  response_id: Type.Optional(Type.String()),
  usage: Type.Optional(UsageSchema),
  truncated: Type.Boolean(),
  truncated_fields: Type.Array(Type.String()),
  full_output_path: Type.Optional(Type.String()),
};
const SuccessSchema = Type.Object({
  ...CommonProperties,
  success: Type.Literal(true),
  status: Type.Union([Type.Literal("completed"), Type.Literal("incomplete")]),
  incomplete_reason: Type.Optional(Type.String()),
  answer: Type.String(),
  citations: Type.Array(Type.String(), { description: "Deduplicated top-level API citation URLs." }),
  inline_citations: Type.Array(InlineCitationSchema),
  citation_texts: Type.Array(Type.String(), { description: "Exact source text blocks for inline citation offsets; only blocks with citations are included." }),
  search_sources: Type.Array(SourceSchema, { description: "Retrieved sources, not necessarily cited in the answer. Do not treat these as answer citations." }),
  citation_count: Type.Integer({ minimum: 0, description: "Unique cited URLs in the full response, before truncation; excludes search_sources." }),
  degraded: Type.Boolean(),
  degraded_reason: Type.Union([Type.Literal("no_citations_with_filters"), Type.Null()]),
  warnings: Type.Array(WarningSchema),
});
const ErrorCodeSchema = Type.Union([
  Type.Literal("invalid_arguments"), Type.Literal("invalid_config"), Type.Literal("auth_unavailable"),
  Type.Literal("auth_failed"), Type.Literal("http_error"), Type.Literal("network_error"),
  Type.Literal("invalid_response"), Type.Literal("refused"), Type.Literal("empty_response"),
  Type.Literal("timeout"), Type.Literal("cancelled"), Type.Literal("internal_error"),
]);
export const OutputSchema = Type.Union([SuccessSchema, Type.Object({
  ...CommonProperties,
  success: Type.Literal(false),
  status: Type.Literal("error"),
  error: Type.Object({
    code: ErrorCodeSchema,
    message: Type.String(),
    retryable: Type.Boolean(),
    http_status: Type.Optional(Type.Integer()),
  }),
})]);

const ContextSchema = Type.Object(ContextProperties);
export type SearchContext = Static<typeof ContextSchema>;
export type Source = Static<typeof SourceSchema>;
export type InlineCitation = Static<typeof InlineCitationSchema>;
export type SearchUsage = Static<typeof UsageSchema>;
export type RequestSettings = Static<typeof RequestSettingsSchema>;
export type SearchResult = Static<typeof SuccessSchema>;
export type ToolOutput = Static<typeof OutputSchema>;
export type ErrorCode = Static<typeof ErrorCodeSchema>;

export class SearchError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly retryable = false,
    public readonly httpStatus?: number,
    public readonly usage?: SearchUsage,
  ) {
    super(message);
    this.name = "SearchError";
  }
}

export function searchContext(params: SearchParams, model: string, source: CredentialSource = "unknown", settings?: RequestSettings): SearchContext {
  return {
    provider: "xai", tool: "x_search", query: params.query, model, credential_source: source,
    ...(settings ? { request_settings: settings } : {}),
    filters: {
      ...(params.allowed_x_handles ? { allowed_x_handles: params.allowed_x_handles } : {}),
      ...(params.excluded_x_handles ? { excluded_x_handles: params.excluded_x_handles } : {}),
      ...(params.from_date ? { from_date: params.from_date } : {}),
      ...(params.to_date ? { to_date: params.to_date } : {}),
      ...(params.posts_only ? { posts_only: true } : {}),
    },
  };
}

function logUnexpectedError(error: unknown): void {
  try {
    // Even local stderr can be persisted. Only emit allowlisted diagnostics, never
    // messages, causes, arbitrary error names/codes, or absolute stack paths.
    const type = error instanceof TypeError ? "TypeError" : error instanceof RangeError ? "RangeError"
      : error instanceof SyntaxError ? "SyntaxError" : error instanceof Error ? "Error" : "NonError";
    const code = error instanceof Error ? (error as Error & { code?: unknown }).code : undefined;
    const systemCode = typeof code === "string" && /^(EACCES|EPERM|ENOENT|ENOSPC|EROFS|EMFILE|ENFILE|EIO)$/.test(code) ? code : undefined;
    const frames = error instanceof Error && typeof error.stack === "string"
      ? error.stack.slice(0, 4_096).split("\n").slice(1).flatMap(line =>
        line.match(/\b(?:config|result|xai|output|research|tool)\.ts:\d{1,6}:\d{1,6}\b/)?.[0] ?? []).slice(0, 5) : [];
    console.error("[pi-x-search] Unexpected internal error (message redacted).", { type, ...(systemCode ? { code: systemCode } : {}), frames });
  } catch { /* Diagnostics must not break the structured failure fallback. */ }
}

export function failureResult(context: SearchContext, error: unknown, debug = false): Extract<ToolOutput, { success: false }> {
  // Unexpected exceptions can carry tokens, headers, or provider bodies. Never echo them.
  if (debug && !(error instanceof SearchError)) logUnexpectedError(error);
  const failure = error instanceof SearchError ? error
    : new SearchError("internal_error", "Unable to complete X Search due to an internal error.");
  return {
    ...context, success: false, status: "error", truncated: false, truncated_fields: [],
    ...(failure.usage ? { usage: failure.usage } : {}),
    error: {
      code: failure.code, message: failure.message, retryable: failure.retryable,
      ...(failure.httpStatus !== undefined ? { http_status: failure.httpStatus } : {}),
    },
  };
}
