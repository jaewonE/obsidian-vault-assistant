# Changelogs

All notable repository changes are documented here.

## [0.11.0] - 2026-07-16

### Added

- Made NotebookLM answer citations clickable. Each `[N]` now preserves the response's citation-number-to-source-ID mapping and cited passage, then opens the exact mapped local image or document in a new Obsidian tab.
- Added image, document, and search icons before resolved citations. Search citations open their stored source URL in a new Obsidian Web viewer tab.
- Added citation extraction and persistence regression coverage for direct, wrapped, and reference-only NotebookLM response shapes.

### Changed

- Raised the minimum Obsidian version to 1.8.0 for the built-in Web viewer used by search citations.

## [0.10.5] - 2026-07-16

### Fixed

- Persist `/Anki` work in conversation history: the original composer command is stored as the user message, followed by a Korean success or failure summary that reports the source scope, generated-card count, and Anki deck destination.
- Added regression coverage for nested-deck, duplicate-aware, and failure history summaries.

## [0.10.4] - 2026-07-16

### Fixed

- Moved NotebookLM MCP startup out of the blocking plugin-load path. The chat view and the rest of Obsidian can load while the connection and notebook refresh run in the background; first use shares the in-flight startup instead of competing with it.
- Removed the redundant startup `server_info` round trip and limited background notebook readiness requests to 15 seconds. Normal query and source-operation timeouts remain unchanged.

## [0.10.3] - 2026-07-16

### Fixed

- Strengthened `/Anki quiz` and `/Anki flashcards` generation instructions: Korean (ko-KR) and the count target are now repeated in both the planning query and final focus prompt, with the mandatory contract placed last so a source-specific instruction cannot dilute it.
- Kept `max-counts` as an upper bound while directing NotebookLM to produce as close to it as possible before stopping for source-grounded coverage or non-redundancy.
- Localized the fixed quiz-card wrapper labels (question, hint, choices, answer, and rationales) to Korean.
- Added regression coverage for the target-count prompt contract and Korean quiz-card wrapper labels.

## [0.10.2] - 2026-07-15

### Fixed

- Added the pipx user-local `~/.local/bin` directory to the MCP subprocess environment, so macOS Obsidian GUI sessions can start `notebooklm-mcp` even when their inherited `PATH` omits it.
- Added regression coverage for the GUI-path fallback and duplicate-path handling.

## [0.10.1] - 2026-07-15

### Fixed

- Extended `/Anki flashcards` and `/Anki quiz` artifact polling from five to ten minutes, allowing NotebookLM studio generations that outlast normal question responses to finish and download.
- Kept failed Anki progress details visible in the four-step panel and refreshed the chat after the command finishes, so the generic `NotebookLM is working...` placeholder cannot hide the actual error.
- Added regression coverage for NotebookLM's initial `not found` and `unknown` artifact states during flashcard polling.

## [0.10.0] - 2026-07-15

### Fixed

- Fixed the `/Anki flashcards` and `/Anki quiz` connection bridge to use Obsidian's CommonJS plugin loader for `requestUrl`, so the AnkiConnect preflight reaches the local service instead of failing on an unresolved dynamic `obsidian` import.
- Added regression coverage for the AnkiConnect request bridge and its `modelNames` request payload.

## [0.9.1] - 2026-07-14

### Added

- Added quoted `key=value` argument parsing for `/Anki flashcards` and `/Anki quiz`, including card counts, direct Anki decks, deck roots, and stale-source ratio controls.
- Added `count`/`counts`, `deck`, and `root` aliases plus concise positional count/deck-root forms.
- Added parser and generation regression coverage for aliases, quoted values, positional values, duplicate precedence, quiz counts, deck targeting, and stale-source tolerance.

### Changed

- Explicit Anki arguments now override positional values; the last explicit value for an option wins and unknown arguments remain ignored.

## [0.9.0] - 2026-07-14

### Added

- Added `/Anki flashcards` and `/Anki quiz` composer commands that use only the current source chips, create source-grounded NotebookLM artifacts, and import verified `Basic(Front, Back)` cards through AnkiConnect.
- Added source-selection validation, source-specific generation planning with JSON retry, card artifact polling/download, duplicate-aware Anki import, and post-import note-count verification.
- Added a four-step Anki progress panel for source selection, source upload, card generation, and Anki synchronization.
- Added console logging plus Obsidian notices for Anki generation failures, alongside slash-command and generation/import regression tests.

### Changed

- Documented AnkiConnect requirements, privacy boundary, and `/Anki` command usage in English and Korean.

## [0.8.0] - 2026-07-11

### Added

- Added optional `$` composer selection for a markdown document and every descendant linked through a configurable YAML parent property.
- Added breadth-first hierarchy expansion with wikilink-list support, deterministic ordering, duplicate/cycle protection, and an optional total-document limit (`-1` for unlimited).
- Added settings to enable hierarchical selection, choose a one-word YAML property, and limit the total selected document count.
- Added validation and regression coverage for `$` mention parsing, YAML property normalization, missing frontmatter/property handling, hierarchy limits, and cyclic links.

### Changed

- Updated English/Korean usage, settings, algorithm, and pipeline documentation for hierarchical source selection.

## [0.7.0] - 2026-07-08

### Added

- Added copy icons to every user question and NotebookLM answer in the chat view, copying the original message text to the clipboard.
- Added Korean README documentation and bilingual README navigation.

### Changed

- Updated release metadata, documentation, and vault-install artifacts for the 0.7.0 GitHub publication.

### Fixed

- Restored `/source`, `/setting`, and `/source add` / `/source get` slash command autocomplete entries to match the documented composer command list.

## [0.6.1] - 2026-07-03

### Fixed

- Recreated the plugin notebook when a persisted NotebookLM notebook ID returns `NOT_FOUND`/404 during readiness checks, including **Refresh auth** verification.
- Added a regression test for NotebookLM missing-notebook error classification.

## [0.6.0] - 2026-03-03

### Added

- Added executable `/research` slash command workflow (composer command execution, not chat history messages):
  - `/research <url>` (single link upload)
  - `/research links <url ...>` (sequential multi-link upload)
  - `/research <query>` (fast research)
  - `/research deep <query>` (deep research)
- Added deep research tracking with mutable `task_id` handling (`task_id` + `query` polling fallback) and fast/deep polling schedules:
  - fast: first poll at `t+1s`, then `5s`
  - deep: first poll at `t+2s`, then `20s -> 10s -> 5s` with transient-error backoff
- Added research import selection policy:
  - fast: import all returned indices
  - deep: import only `result_type_name=web` entries with non-empty URLs
- Added research metadata persistence (`researchRecords`, `researchSourceIndex`) for NotebookLM-only source lifecycle:
  - stores source IDs, titles, URLs, query/report/task metadata
  - does not store raw source content locally
- Added dedicated composer chip UX for non-local research sources:
  - 5 icon variants (link-url, link-youtube, links, research fast, research deep)
  - loading spinner states with `%` center for multi-link uploads
  - non-cancel remove behavior while loading (remove from UI/query scope only)
  - light-red error state for `no_research` / `error`
- Added research source click behaviors (composer + assistant source list):
  - link: open URL directly
  - links / fast: modal URL picker (title + muted URL)
  - deep: modal deep-report markdown render via `MarkdownRenderer.render`
- Added unit test coverage for:
  - research command parsing
  - deep task-id mutation tracker behavior
  - research import index selection rules
  - research record persistence and reconciliation

### Changed

- Query execution now accepts manual non-file source IDs (from active research chips) and merges them with BM25/explicit/history source IDs.
- `sourceSummary` now optionally tracks `manualExternalSelectedCount`.
- Slash command autocomplete now includes `/research` root with `links` and `deep` subcommands.
- Link source add now always uses MCP `source_add` with `source_type=url` for both web and YouTube links (removed youtube-first fallback branch).
- Fast/deep research runs now attach a unique run token to the query (`[run-...]`) and use that same stable query in all status polls while tracking mutable `task_id`.
- Removed automatic `force=true` retry on `research_start`; runs now follow guide-aligned tracking/import flow without force-start side effects.
- Extended post-import source validation policy to `link` and `links` flows as well:
  - validates with `source_get_content` after `10s -> 20s -> 30s`
  - automatically deletes unusable NotebookLM sources (`content` empty + `char_count<=0`)
  - keeps failed links visible/openable in modal but excludes them from query source scope

### Fixed

- Fixed modal UI for research links/fast picker:
  - increased vertical spacing for item/list top-bottom readability
  - ensured failed links show light-red background (not border-only)
  - truncated long title/url with ellipsis instead of wrapping
  - replaced failed item title text with explicit failure status message to avoid duplicate URL display

## [0.5.0] - 2026-03-02

### Added

- Added slash command autocomplete in composer mention UI:
  - typing `/` shows root commands (`/source`, `/create`, `/setting`)
  - typing a completed root command with space shows subcommands (currently `/source add`, `/source get`)
  - root and subcommand suggestions are filtered live by typed text
- Added command suggestion styling in mention list:
  - command rows now render a distinct command-block label with accent background and blur/glow edge treatment
  - command text is displayed slightly smaller and bolder for clear visual distinction
- Added slash-command search unit tests (`test/ui/slashCommands.test.ts`) and parser coverage updates (`test/ui/pathMention.test.ts`).

### Changed

- Composer mention parser now keeps `/...` command context active while typing subcommand text (spaces allowed inside slash-command term).
- `Enter` behavior in composer mention panel was refined:
  - if a slash command suggestion exists, `Enter` autocompletes to the selected item (or top item when none is explicitly selected)
  - if no slash command suggestion matches current input (for example `/source edit`), mention panel is hidden and `Enter` falls back to normal query submission.

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
