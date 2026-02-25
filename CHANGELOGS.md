# Changelogs

All notable repository changes are documented here.

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
