import { normalizeOptions, requestSettings, type SearchConfig } from "./config.ts";
import { researchInstructions } from "./research.ts";
import {
  SearchError, searchContext,
  type InlineCitation, type SearchContext, type SearchParams, type SearchResult,
  type SearchUsage, type Source, type XaiCredential,
} from "./result.ts";
export type { SearchParams, SearchResult, SearchUsage } from "./result.ts";

export const RESPONSES_URL = "https://api.x.ai/v1/responses";
export const MAX_BODY_BYTES = 16 * 1024 * 1024;
declare const normalizedParams: unique symbol;
export type NormalizedSearchParams = SearchParams & { readonly [normalizedParams]: true };
export type SearchPhase = "auth" | "request" | "parse";
type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : {};
}
function array(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function cleanText(value: string): string { return value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ""); }
function invalidArguments(message: string): never { throw new SearchError("invalid_arguments", message); }

function handles(value: string[] | undefined, name: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) {
    invalidArguments(`${name} must contain between 1 and 20 X handles.`);
  }
  return [...new Set(value.map((handle) => {
    if (typeof handle !== "string") invalidArguments(`${name} must contain X handles, not URLs.`);
    const nameOnly = handle.trim().replace(/^@/, "").toLowerCase();
    if (!/^[a-z0-9_]{1,15}$/.test(nameOnly)) invalidArguments(`${name} must contain valid X handles (without URLs).`);
    return nameOnly;
  }))];
}
function validateDate(value: string | undefined, name: string): void {
  if (value === undefined) return;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    invalidArguments(`${name} must be a real calendar date in YYYY-MM-DD format.`);
  }
  const date = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    invalidArguments(`${name} must be a real calendar date in YYYY-MM-DD format.`);
  }
}
export function normalizeParams(params: SearchParams): NormalizedSearchParams {
  if (typeof params.query !== "string" || !params.query.trim() || params.query.length > 16_000) {
    invalidArguments("query must be non-empty and at most 16000 characters.");
  }
  if (params.instruction !== undefined && (typeof params.instruction !== "string" || params.instruction.length > 8_000)) {
    invalidArguments("instruction must be a string of at most 8000 characters.");
  }
  if (params.allowed_x_handles !== undefined && params.excluded_x_handles !== undefined) {
    invalidArguments("allowed_x_handles and excluded_x_handles are mutually exclusive.");
  }
  validateDate(params.from_date, "from_date");
  validateDate(params.to_date, "to_date");
  if (params.from_date && params.to_date && params.from_date > params.to_date) invalidArguments("from_date must not be later than to_date.");
  for (const field of ["posts_only", "enable_image_understanding", "enable_video_understanding"] as const) {
    if (params[field] !== undefined && typeof params[field] !== "boolean") invalidArguments(`${field} must be a boolean.`);
  }
  return {
    ...normalizeOptions(params),
    query: params.query.trim(), instruction: params.instruction?.trim() || undefined,
    allowed_x_handles: handles(params.allowed_x_handles, "allowed_x_handles"),
    excluded_x_handles: handles(params.excluded_x_handles, "excluded_x_handles"),
    from_date: params.from_date, to_date: params.to_date, posts_only: params.posts_only,
    enable_image_understanding: params.enable_image_understanding, enable_video_understanding: params.enable_video_understanding,
  } as NormalizedSearchParams;
}

export function buildRequest(params: SearchParams, config: SearchConfig): ObjectValue {
  const query = params.posts_only && !/(?:^|\s)-filter:replies(?=\s|$)/.test(params.query)
    ? `${params.query} -filter:replies` : params.query;
  return {
    model: config.model, instructions: researchInstructions(config, params.posts_only),
    ...(config.reasoningEffort !== "model_default" ? { reasoning: { effort: config.reasoningEffort } } : {}),
    input: [{ role: "user", content: params.instruction
      ? `${query}\n\nAdditional research instructions:\n${params.instruction}` : query }],
    tools: [{
      type: "x_search", allowed_x_handles: params.allowed_x_handles, excluded_x_handles: params.excluded_x_handles,
      from_date: params.from_date, to_date: params.to_date,
      enable_image_understanding: params.enable_image_understanding ?? false,
      enable_video_understanding: params.enable_video_understanding ?? false,
    }],
    tool_choice: "required", max_tool_calls: config.maxToolCalls, max_output_tokens: config.maxOutputTokens,
    store: false, stream: false,
  };
}

// No raw provider bodies or auth exceptions are exposed. If a credential is
// unexpectedly echoed in evidence, replace it at equal length to keep offsets.
function redactText(value: string, secret: string): string {
  return secret ? value.split(secret).join("*".repeat(secret.length)) : value;
}
function safeMessage(value: unknown, secret: string): string {
  if (typeof value !== "string") return "";
  return (secret ? value.split(secret).join("[redacted]") : value)
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]").replace(/\bxai-[a-zA-Z0-9_-]+/g, "[redacted]")
    .replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 600);
}
function providerMessage(body: unknown, secret: string): string {
  const root = object(body);
  return safeMessage(object(root.error).message ?? root.error ?? root.message, secret);
}
function retryAfterSeconds(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const raw = value.trim();
  let seconds: number;
  if (/^\d+$/.test(raw)) seconds = Number(raw);
  else if (/^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(raw)) {
    seconds = Math.max(0, Math.ceil((Date.parse(raw) - Date.now()) / 1_000));
  } else return undefined;
  return Number.isSafeInteger(seconds) && seconds >= 0 ? seconds : undefined;
}
function httpError(status: number, body: unknown, secret: string, retryAfter?: string | null): SearchError {
  const hints: Record<number, string> = {
    401: "Run /login xai in Pi to renew the xAI credential.",
    402: "Check your xAI API credits or subscription quota.",
    403: "Check subscription tier, model/tool entitlement, or API-key permissions. Logging in again may not fix an entitlement restriction.",
    429: "xAI rate limit or quota reached. Wait or check your subscription/API quota before retrying.",
  };
  const wait = status === 429 ? retryAfterSeconds(retryAfter) : undefined;
  return new SearchError("http_error",
    [`xAI X Search failed (HTTP ${status}).`, providerMessage(body, secret), hints[status],
      wait !== undefined ? `Retry after ${wait} seconds (Retry-After).` : ""].filter(Boolean).join(" "),
    status === 429 || status >= 500, status, parseUsage(object(body).usage));
}
function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}
function tokens(value: unknown): number { return Math.floor(number(value) ?? 0); }
function index(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
function parseUsage(value: unknown): SearchUsage | undefined {
  const raw = object(value);
  if (!Object.keys(raw).length) return undefined;
  const input = tokens(raw.input_tokens), output = tokens(raw.output_tokens);
  const ticks = typeof raw.cost_in_usd_ticks === "string" && /^\d+$/.test(raw.cost_in_usd_ticks)
    ? number(Number(raw.cost_in_usd_ticks)) : number(raw.cost_in_usd_ticks);
  const reasoning = number(object(raw.output_tokens_details).reasoning_tokens);
  const toolUsage = object(raw.server_side_tool_usage_details);
  const toolCounts = Object.fromEntries(["x_search_calls", "x_posts_fetched", "x_users_fetched"].flatMap((key) => {
    const count = index(toolUsage[key]);
    return count !== null ? [[key, count]] : [];
  }));
  return {
    ...toolCounts,
    input_tokens: input, output_tokens: output,
    cached_input_tokens: Math.min(input, tokens(object(raw.input_tokens_details).cached_tokens)),
    total_tokens: Math.max(input + output, tokens(raw.total_tokens)),
    ...(reasoning !== undefined ? { reasoning_tokens: Math.min(output, Math.floor(reasoning)) } : {}),
    ...(ticks !== undefined ? { cost_usd: ticks / 10_000_000_000 } : {}),
  };
}
function source(value: unknown, secret: string): Source | undefined {
  if (typeof value === "string") value = { url: value };
  let raw = object(value);
  if (raw.url === undefined) raw = object(raw.url_citation);
  if (typeof raw.url !== "string" || (secret && raw.url.includes(secret))) return undefined;
  let url: URL;
  try { url = new URL(raw.url); } catch { return undefined; }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return undefined;
  const title = typeof raw.title === "string" ? cleanText(redactText(raw.title, secret)).trim() : "";
  return { url: url.href, ...(title ? { title } : {}) };
}

export function parseResponse(body: unknown, context: SearchContext, secret = ""): SearchResult {
  const root = object(body), usage = parseUsage(root.usage);
  if (root.error != null) {
    throw new SearchError("invalid_response", `xAI X Search failed. ${providerMessage(body, secret) || "The API returned an error."}`, false, undefined, usage);
  }
  if (root.status !== undefined && root.status !== "completed" && root.status !== "incomplete") {
    throw new SearchError("invalid_response", "xAI X Search did not return a completed response.", false, undefined, usage);
  }
  const citations = [...new Set(array(root.citations).flatMap((value) => {
    const citation = source(value, secret);
    return citation ? [citation.url] : [];
  }))];
  const searchSources = new Map<string, Source>();
  const texts: string[] = [], citationTexts: string[] = [], inlineCitations: InlineCitation[] = [];
  let refusal = "";
  for (const outputItem of array(root.output)) {
    const output = object(outputItem);
    for (const value of array(object(output.action).sources)) {
      const found = source(value, secret);
      if (found && (!searchSources.has(found.url) || found.title)) searchSources.set(found.url, found);
    }
    if (output.type !== "message" || (output.role !== undefined && output.role !== "assistant")) continue;
    for (const contentItem of array(output.content)) {
      const part = object(contentItem);
      if (["output_text", "text"].includes(String(part.type)) && typeof part.text === "string") {
        const text = redactText(part.text, secret);
        texts.push(cleanText(text));
        const annotations = array(part.annotations).flatMap((value) => {
          const annotation = object(value);
          if (annotation.type !== "url_citation") return [];
          const citation = source(annotation, secret);
          if (!citation) return [];
          const offsets = annotation.url === undefined ? object(annotation.url_citation) : annotation;
          const start = index(offsets.start_index), end = index(offsets.end_index);
          return [{ ...citation, start_index: start, end_index: end !== null && start !== null && end < start ? null : end }];
        });
        if (annotations.length) {
          const textIndex = citationTexts.push(text) - 1;
          const seen = new Set<string>();
          for (const annotation of annotations) {
            // text_index is fixed within this block. Keep distinct mentions/blocks.
            const identity = JSON.stringify([annotation.url, annotation.start_index, annotation.end_index]);
            if (seen.has(identity)) continue;
            seen.add(identity);
            inlineCitations.push({ ...annotation, text_index: textIndex });
          }
        }
      } else if (part.type === "refusal" && typeof part.refusal === "string") {
        refusal = safeMessage(part.refusal, secret);
      }
    }
  }
  const answer = texts.join("\n\n").trim() ||
    (typeof root.output_text === "string" ? cleanText(redactText(root.output_text, secret)).trim() : "");
  if (!answer) {
    throw new SearchError(refusal ? "refused" : "empty_response", refusal
      ? `xAI refused this X Search request: ${refusal}`
      : "xAI X Search returned no answer text. Try a narrower query or increase PI_X_SEARCH_MAX_OUTPUT_TOKENS.", false, undefined, usage);
  }
  const citationCount = new Set([...citations, ...inlineCitations.map((citation) => citation.url)]).size;
  const activeFilters = Object.keys(context.filters);
  const degraded = activeFilters.length > 0 && citationCount === 0;
  const incompleteReason = safeMessage(object(root.incomplete_details).reason, secret);
  const warnings: SearchResult["warnings"] = [];
  if (context.filters.posts_only) warnings.push({ code: "posts_only_unverified", message: "Reply exclusion was requested via keyword-search constraints and Grok instructions, not a native xAI post-type filter. Returned post types are not independently verified; do not assume guaranteed reply-free retrieval." });
  if (root.status === "incomplete") warnings.push({ code: "incomplete_response", message: `xAI returned an incomplete answer${incompleteReason ? ` (${incompleteReason})` : ""}.` });
  if (!citationCount) warnings.push({ code: "uncited_answer", message: "No answer citations were returned. Do not treat this answer as verified X evidence or infer that no matching posts exist." });
  return {
    ...context,
    model: typeof root.model === "string" ? safeMessage(root.model, secret).slice(0, 128) : context.model,
    ...(typeof root.id === "string" ? { response_id: safeMessage(root.id, secret).slice(0, 256) } : {}),
    success: true, status: root.status === "incomplete" ? "incomplete" : "completed",
    ...(root.status === "incomplete" && incompleteReason ? { incomplete_reason: incompleteReason } : {}),
    answer, citations, inline_citations: inlineCitations, citation_texts: citationTexts,
    search_sources: [...searchSources.values()], citation_count: citationCount,
    degraded, degraded_reason: degraded ? "no_citations_with_filters" : null,
    ...(usage ? { usage } : {}), warnings, truncated: false, truncated_fields: [],
  };
}

async function abortable<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try { return await Promise.race([work(), aborted]); }
  finally { signal.removeEventListener("abort", onAbort); }
}
/** Bound actual (decoded) HTTP body bytes, even without an honest Content-Length. */
async function readJsonBody(response: Response, signal: AbortSignal): Promise<unknown> {
  const tooLarge = () => new SearchError("invalid_response", "xAI response exceeded the size limit (16 MiB).", true);
  if (Number(response.headers.get("content-length")) > MAX_BODY_BYTES) {
    void response.body?.cancel().catch(() => {});
    throw tooLarge();
  }
  if (!response.body) throw new SyntaxError("Empty response body.");
  const reader = response.body.getReader();
  let bytes = Buffer.allocUnsafe(0), total = 0, complete = false;
  try {
    while (true) {
      const { done, value } = await abortable(() => reader.read(), signal);
      if (done) { complete = true; break; }
      const nextTotal = total + value.byteLength;
      if (nextTotal > MAX_BODY_BYTES) throw tooLarge();
      if (nextTotal > bytes.length) {
        // Coalesce chunks so millions of tiny chunks cannot grow an unbounded
        // metadata array. Grow geometrically, but never past the byte cap.
        const grown = Buffer.allocUnsafe(Math.min(MAX_BODY_BYTES, Math.max(nextTotal, bytes.length * 2, 4_096)));
        bytes.copy(grown, 0, 0, total);
        bytes = grown;
      }
      bytes.set(value, total);
      total = nextTotal;
    }
    // TextDecoder strips a UTF-8 BOM just like Response.json().
    return JSON.parse(new TextDecoder().decode(bytes.subarray(0, total)));
  } finally {
    // Do not wait for a possibly uncooperative stream's cancellation promise.
    if (!complete) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Internal transport: callers must normalize once before resolving credentials. */
export async function searchX(
  params: NormalizedSearchParams, config: SearchConfig,
  resolveCredential: () => Promise<XaiCredential | undefined>,
  signal?: AbortSignal, fetchImpl: typeof fetch = globalThis.fetch,
  onProgress?: (phase: SearchPhase) => void,
): Promise<SearchResult> {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), config.timeoutMs);
  const requestSignal = AbortSignal.any(signal ? [signal, timeout.signal] : [timeout.signal]);
  try {
    requestSignal.throwIfAborted();
    onProgress?.("auth");
    let credential: XaiCredential | undefined;
    try { credential = await abortable(resolveCredential, requestSignal); }
    catch {
      requestSignal.throwIfAborted();
      throw new SearchError("auth_failed", "Unable to resolve or refresh the Pi xAI credential. Run /login xai in Pi.");
    }
    requestSignal.throwIfAborted();
    const key = credential?.apiKey;
    if (!key?.trim()) throw new SearchError("auth_unavailable", "No xAI credential available. Run /login xai in Pi (Grok/X subscription or API key), or set XAI_API_KEY before starting Pi.");
    onProgress?.("request");
    let response: Response;
    try {
      response = await abortable(() => fetchImpl(RESPONSES_URL, {
        method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(buildRequest(params, config)), signal: requestSignal, redirect: "error",
      }), requestSignal);
    } catch {
      requestSignal.throwIfAborted();
      throw new SearchError("network_error", "Unable to reach the official xAI API. Check your network/proxy before retrying.", true);
    }
    onProgress?.("parse");
    let body: unknown;
    try { body = await readJsonBody(response, requestSignal); }
    catch (error) {
      requestSignal.throwIfAborted();
      if (error instanceof SearchError) throw error;
      if (!response.ok) throw httpError(response.status, undefined, key, response.headers.get("retry-after"));
      throw new SearchError("invalid_response", "xAI X Search returned invalid JSON.", true);
    }
    requestSignal.throwIfAborted();
    if (!response.ok) throw httpError(response.status, body, key, response.headers.get("retry-after"));
    return parseResponse(body, searchContext(params, config.model, credential!.source, requestSettings(config)), key);
  } catch (error) {
    if (signal?.aborted) throw new SearchError("cancelled", "X Search cancelled.");
    if (timeout.signal.aborted) throw new SearchError("timeout", `X Search timed out after ${config.timeoutMs} ms.`, true);
    throw error;
  } finally { clearTimeout(timer); }
}
