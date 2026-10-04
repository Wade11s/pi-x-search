# Changelog

## Unreleased

### Fixed

- Upgrade Pi development dependencies to 1.0.2 and refresh the lockfile to use patched `brace-expansion@5.0.12`; host-provided peer dependencies remain unchanged.
- Cap xAI response bodies at 16 MiB using both Content-Length checks and streamed byte counting; cancel oversized, timed-out or cancelled body reads.
- Best-effort cleanup of owned `pi-x-search-*` temporary directories older than 24 hours, scheduled at most once per hour during tool execution. Remove new directories if saving their output fails.
- Serialize output candidate sizes once per truncation round, and write unique temporary files without a shared mutation queue.
- Normalize search parameters once before entering the internal transport; enforce the boundary with a normalized-input type.
- Remove unreachable instruction validation and centralize the default model.
- Deduplicate inline citations by URL, text block and offsets, preserving distinct mentions and original coordinates.

### Added

- Credential, request and response-parsing progress updates through Pi's tool update callback.
- Safe Retry-After wait hints for HTTP 429, including delta-seconds and HTTP dates; no automatic retries.
- Opt-in `PI_X_SEARCH_DEBUG=1` local diagnostics containing only error categories, allowlisted filesystem codes and local source coordinates, never raw exception messages or credentials.
- Node 22 GitHub Actions checks, additional regression tests and `.DS_Store` exclusion.

## 0.4.0

- Add `posts_only` with keyword-search reply exclusion instructions and the `posts_only_unverified` warning.
- Validate the optional boolean and cover request generation and real Pi codemode consumption.

## 0.3.0

- Add per-call model, timeout, token/tool budget, research mode, candidate limit and reasoning overrides.
- Generate shared research instructions with configuration precedence: call > environment > preset.
- Report `request_settings` and optional server-side X Search usage counts.

## 0.2.0

- Introduce schema-based success/error results and codemode structured objects.
- Separate top-level citations, inline citations, exact citation texts and retrieved sources.
- Expose quality warnings as structured objects and internal failures as schema-defined results.
