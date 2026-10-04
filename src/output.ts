import { lstat, mkdtemp, opendir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MAX_BYTES } from "@earendil-works/pi-coding-agent";
import type { ToolOutput } from "./result.ts";

export const MAX_STRUCTURED_BYTES = 1024 * 1024;
const OUTPUT_RETENTION_MS = 24 * 60 * 60 * 1_000;
let nextCleanupAt = 0;

/** Best effort: never follow symlinks or remove another user's temp directories. */
export async function cleanupStaleOutputs(root = tmpdir(), now = Date.now()): Promise<void> {
  try {
    const directory = await opendir(root);
    for await (const entry of directory) {
      if (!entry.isDirectory() || !/^pi-x-search-[A-Za-z0-9]{6}$/.test(entry.name)) continue;
      try {
        const path = join(root, entry.name), info = await lstat(path);
        if (!info.isDirectory() || (process.getuid && info.uid !== process.getuid())) continue;
        if (info.mtimeMs < now - OUTPUT_RETENTION_MS) await rm(path, { recursive: true, force: true });
      } catch { /* One inaccessible/disappearing directory must not stop the sweep. */ }
    }
  } catch { /* Cleanup must never affect a search. */ }
}

/** Launch at most one sweep per hour, without delaying authentication/network work. */
export function scheduleOutputCleanup(): void {
  const now = Date.now();
  if (now < nextCleanupAt) return;
  nextCleanupAt = now + 60 * 60 * 1_000;
  void cleanupStaleOutputs();
}
function jsonBytes(value: unknown): number { return Buffer.byteLength(JSON.stringify(value)); }
function halfText(value: string): string {
  const prefix = value.slice(0, Math.floor(value.length / 2));
  return /[\ud800-\udbff]$/.test(prefix) ? prefix.slice(0, -1) : prefix;
}

/** Compact valid JSON, with intact offsets for every retained inline citation. */
export function limitOutput(full: ToolOutput, maxBytes: number): ToolOutput {
  if (jsonBytes(full) <= maxBytes) return full;
  const result = { ...full, truncated: true, truncated_fields: [...full.truncated_fields] };
  function omitted(field: string): void {
    if (!result.truncated_fields.includes(field)) result.truncated_fields.push(field);
  }
  while (jsonBytes(result) > maxBytes) {
    const candidates: Record<string, string | unknown[]> = { query: result.query };
    if (result.success) Object.assign(candidates, {
      answer: result.answer, citations: result.citations, inline_citations: result.inline_citations,
      citation_texts: result.citation_texts, search_sources: result.search_sources,
    });
    const sizes = Object.entries(candidates).map(([field, value]) => [field, jsonBytes(value)] as const);
    const field = sizes.sort((a, b) => b[1] - a[1])[0]![0];
    if (field === "query" && result.query) {
      result.query = halfText(result.query);
    } else if (result.success) {
      switch (field) {
        case "answer": result.answer = halfText(result.answer); break;
        case "citations": result.citations = result.citations.slice(0, Math.floor(result.citations.length / 2)); break;
        case "search_sources": result.search_sources = result.search_sources.slice(0, Math.floor(result.search_sources.length / 2)); break;
        case "citation_texts": {
          result.citation_texts = result.citation_texts.slice(0, Math.floor(result.citation_texts.length / 2));
          result.inline_citations = result.inline_citations.filter((citation) => citation.text_index < result.citation_texts.length);
          omitted("inline_citations");
          break;
        }
        case "inline_citations": result.inline_citations = result.inline_citations.slice(0, Math.floor(result.inline_citations.length / 2)); break;
        default: throw new Error("X Search output metadata exceeds the output budget.");
      }
    } else {
      throw new Error("X Search error metadata exceeds the output budget.");
    }
    omitted(field);
  }
  // Never clip a cited text block: either keep it whole, or drop its annotations.
  // citation_count/degraded describe the FULL response, not this bounded view.
  return result;
}

export async function prepareOutput(full: ToolOutput): Promise<{
  text: string;
  result: ToolOutput;
  preview: ToolOutput;
}> {
  if (jsonBytes(full) <= DEFAULT_MAX_BYTES) return { text: JSON.stringify(full), result: full, preview: full };
  const directory = await mkdtemp(join(tmpdir(), "pi-x-search-"));
  const fullOutputPath = join(directory, "result.json");
  try {
    await writeFile(fullOutputPath, JSON.stringify(full, null, 2), { encoding: "utf8", mode: 0o600 });
  } catch (error) {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  const withPath = { ...full, full_output_path: fullOutputPath };
  // Codemode can inspect/filter more data than should enter model context.
  const result = limitOutput(withPath, MAX_STRUCTURED_BYTES);
  const preview = limitOutput(result, DEFAULT_MAX_BYTES);
  return { text: JSON.stringify(preview), result, preview };
}
