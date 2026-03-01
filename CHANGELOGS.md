# Changelogs

All notable repository changes are documented here.

## [0.4.4] - 2026-03-01

### Changed

- Explicit `@` / `@@` selections now start immediate sequential source upload in the background as soon as they are added to the composer.
- Query upload stage now reuses and waits on explicit pre-upload state instead of restarting from scratch for explicit paths.
- Step 2 upload progress is synchronized with in-flight explicit uploads, so submitting mid-upload reflects already completed counts (for example `2/5` while the 3rd file uploads).
- Source preparation execution is now serialized through a mutex to prevent concurrent upload/replace races between background explicit pre-upload and query-time upload paths.
- Composer source chips now render explicit-upload status:
  - uploading chips show a circular loading indicator in place of `x`
  - hovering an uploading chip temporarily shows `x` so the source can still be removed immediately
  - multi-file chips show upload completion percent (`%`) in the center of the loading indicator
- Composer source chip readability was improved:
  - path chips now show only the last folder segment plus file count (for example `topic (23)`)
  - chip text still truncates with `...`, and hovering a chip shows full source text via tooltip
- Interrupting an in-flight explicit path upload by removing its chip now cancels only remaining queued files for that path:
  - current in-progress file is allowed to finish
  - subsequent files for that deselected path are skipped so the worker can proceed to other queued sources
  - re-adding the same path later resumes progress from already uploaded files (for example `6/10` starts at `60%`)

## [0.4.3] - 2026-03-01

### Changed

- Busy-state UI locking in chat composer was relaxed during query execution:
  - query textarea remains editable
  - `@` / `@@` mention panel remains interactive
  - selected source chips and `Search vault` toggle remain interactive
- While processing, only `Send`, `New`, and `History` controls are disabled.
- `Enter` key handling while busy no longer consumes input for a blocked send attempt, so normal textarea interaction is preserved.

## [0.4.2] - 2026-03-01

### Changed

- Explicit `@` / `@@` source chips are no longer cleared on send, so the composer keeps showing the currently referenced manual sources across follow-up questions in the same tab.
- Clicking `x` on a source chip now records a source exclusion and applies it to subsequent queries:
  - deselected file/path descendants are excluded from path selection inputs
  - resolved source IDs for deselected paths are excluded from final NotebookLM query `source_ids` merge (including conversation carry-over)
- Query planning now supports exclusion-aware source reuse filtering, preventing deselected sources from being reintroduced via history carry-over.

## [0.4.1] - 2026-03-01

### Added

- Added extension-aware source upload policy for `@` / `@@` selected files:
  - allowed extensions are centrally validated before upload
  - upload method is selected per extension (`text` vs `file`)
- Added modular upload planning utility:
  - centralized extension parsing, allowlist checks, and upload-plan creation
  - single-part upload plans are used now, with plan structure prepared for future subdivision/splitting extensions

### Changed

- Refactored source preparation flow to remove hardcoded text upload and use upload plans.
- Non-text allowed extensions now use MCP `source_add` with `source_type=file` and `file_path` instead of pasted text payloads.
- Query execution now ignores disallowed `@` / `@@` file paths and shows a notice:
  - `Ignored N files due to unallowed extensions ...`
- Updated source preparation hashing to support binary content hashing for file uploads.

## [0.4.0] - 2026-02-25

### Added

- Added Add File/Path composer workflow with `@` and `@@`:
  - `@`: markdown-only search scope
  - `@@`: all-file search scope
  - live candidate updates while typing
  - empty-state message when no candidate is found
- Added explicit source chips above composer:
  - clickable file/path chips
  - path descendant count in chip label (`path (N)`)
  - chip removal via `x`
- Added folder-note resolution for selected paths:
  - opens only `path/name/name.md`, `path/name/name.canvas`, or `path/name/name.base` if present
- Added path expansion safeguards:
  - warning when selected path expands to more than 15 files
  - reject when selected path expands to more than 200 files
- Added extension-based icons in mention list for folder/markdown/pdf/image/video/code/common files
- Added persistent composer `Search vault` toggle:
  - always visible
  - persisted in plugin data (`data.json`)
  - default enabled

### Changed

- Query planning now supports two modes:
  - `Search vault = on`: BM25 + explicit selections
  - `Search vault = off`: explicit selections + conversation-carried source IDs
- Explicit selection metadata is persisted in query records (`kind`, `mode`, `path`, `resolvedPaths`, `subfileCount`).
- Mention list UX was refined:
  - left-aligned icon -> filename -> path
  - improved keyboard navigation behavior
  - improved active/hover highlight behavior during keyboard navigation
- Mention parsing/search behavior was refined:
  - search terms support spaces
  - underscore-to-space normalization for matching
- Source read abstraction moved from markdown-only to generic file content read path for `@@` support.
- Timeout handling was corrected and extended:
  - plugin setting timeout is passed to `notebook_query`
  - MCP request timeout now explicitly follows setting-derived values (with small buffer)
  - timeout handling now also applies to source upload/replacement flow and notebook readiness calls
- Query timeout default changed to `300` seconds.

### Fixed

- Fixed chat input focus regressions triggered by mention-list keyboard handling patterns.
- Fixed mention-list arrow navigation state conflicts between hover and keyboard selection.
- Fixed mention-list icon vertical alignment.
- Fixed cases where long operations could fail with MCP request timeout despite higher user timeout settings.

## [0.3.2] - 2026-02-25

### Changed

- BM25 indexing now supports persisted cache storage in plugin data and startup synchronization using markdown file metadata (`mtime`, `size`), reducing unnecessary full rebuilds.
- BM25 synchronization behavior was refactored from full vault re-indexing to incremental/semi-incremental updates:
  - added/modified markdown files are re-tokenized individually
  - deleted markdown files are removed from postings
  - unchanged markdown files are reused from cache
- Source preparation logic now performs hash-based synchronization before reusing uploaded NotebookLM sources:
  - if local content hash changed, the old remote source is replaced with a new upload
  - if hash matches and path was effectively moved/renamed, source mapping is reassigned without re-upload
- Added `source_id` alias-chain resolution so historical IDs can map to the latest active source IDs across sessions.
- Added tests for BM25 cache hydration/incremental update behavior and source registry alias-chain/cached-index persistence.
- Source preparation flow was refactored into a dedicated service module with add-first replacement ordering and remote-capacity-based eviction decisions.
- MCP retry behavior now retries only idempotent tool calls on connection issues to avoid duplicate side effects on mutating operations.
- Added bounded history source carry-over, runtime settings sanitization, and persistence compaction/alias pruning safeguards.
- Added final algorithm documentation for v0.3.2 implementation details and traceability:
  - `BM25_NOTEBOOKLM_ALGORITHMS_0.3.2.md`
  - `BM25_NOTEBOOKLM_PIPELINE_0.3.2.md`

## [0.3.1] - 2026-02-25

### Changed

- Improved markdown table readability in chat answers by rendering visible borders for all table cells (`th`, `td`) and table outer edges.
- Added a configurable table border color CSS variable (`--nlm-table-border-color`) with a gray default fallback.

## [0.2.2] - 2026-02-24

### Changed

- Reused source context within the same conversation tab by carrying forward previously used `source_ids` into each new NotebookLM query.
- Added a source list UI at the top of each assistant answer:
  - toggle button to show/hide sources used for that answer
  - clickable source titles (for example, `algorithm.md`) that open the source note in a new Obsidian tab
- Added per-query source summary fields and UI lines for:
  - step 1: newly prepared sources for the current question
  - step 2: total sources used for final query context (current + history carry-over)

## [0.2.1] - 2026-02-24

### Changed

- Added live query progress UI with three explicit steps:
  - BM25 search and document selection
  - selected document upload/preparation
  - NotebookLM response wait
- Added per-document progress detail for step 2, including the currently processed file path and upload/reuse counts.

## [0.2.0] - 2026-02-24

### Changed

- Updated chat UI for mixed message presentation:
  - user questions remain speech bubbles
  - NotebookLM responses render as markdown-formatted text blocks (no assistant bubble)
- Improved assistant message readability for headings, lists, links, and other markdown output.

## [0.1.0] - 2026-02-24

### Added

- NotebookLM MCP integration using globally installed executables:
  - `notebooklm-mcp --transport stdio`
  - `nlm` for login/troubleshooting workflow
- Thin MCP TypeScript client wrapper with:
  - tool-call abstraction
  - JSON-like result parsing
  - reconnect behavior after connection failures
- Right-sidebar chat experience with:
  - user/assistant message rendering
  - send flow
  - `New` conversation action
  - `History` modal for previous conversations
- Settings tab with:
  - `Debug mode`
  - `Refresh Auth`
  - BM25 tuning fields (`Top N`, `cutoff ratio`, `min K`, `k1`, `b`)
  - query timeout control
- BM25 retrieval engine over vault markdown notes with:
  - index rebuild support
  - Okapi BM25 scoring (`k1=1.2`, `b=0.75` defaults)
  - exact selection rule: top N -> dynamic threshold -> min K fallback
- Persistent plugin data model for:
  - settings
  - source registry (`path <-> sourceId`)
  - conversation history with metadata
- Source capacity management with a segmented queue approach (probation/protected) and remote source eviction support.

### Changed

- Project restructured from sample-plugin skeleton into modular architecture under `src/`.
- `main.ts` reduced to a minimal entrypoint that re-exports the plugin implementation.
- Manifest/package metadata updated for repository identity and desktop-focused behavior.
- Styles updated to support chat view and history modal UI.
- README rewritten for NotebookLM workflow, setup steps, and troubleshooting.

### Removed

- Sample plugin scaffolding settings module and sample behaviors unrelated to NotebookLM workflow.
