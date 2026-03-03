# Obsidian Vault Assistant

Version: `0.6.0`

Obsidian Desktop community plugin that integrates with Google NotebookLM through globally installed `notebooklm-mcp-cli` executables:

- `notebooklm-mcp` (MCP server)
- `nlm` (CLI for login/diagnostics)

The plugin provides a right-sidebar chat workflow:

1. Optional BM25 search over vault notes
2. Optional explicit source selection via `@` / `@@`
3. Source preparation and upload/reuse in NotebookLM
4. NotebookLM query with bounded source scope
5. Persisted conversation/source metadata for follow-up reuse

## Features

- Right sidebar chat view (single-tab operation)
- User questions in bubbles, NotebookLM answers rendered as markdown
- Live 3-step progress UI (search -> upload -> response)
- During query processing, composer interactions stay enabled (input, mention search, chip actions, `Search vault` toggle); only `Send`, `New`, and `History` are disabled.
- Step 2 upload progress is synchronized with explicit pre-upload state (for example, `2/5` can be shown if Submit is pressed during the 3rd upload).
- Explicit source selection in composer:
  - type `@` for markdown-only file/path search
  - type `@@` for all-file file/path search
  - live search updates while typing
  - keyboard and mouse selection support (`ArrowUp`, `ArrowDown`, `Enter`, `Escape`)
  - supports search terms with spaces and underscore-to-space matching
  - selected files/paths start sequential source upload immediately after selection
- Slash command autocomplete in composer:
  - type `/` to show available root commands (`/source`, `/create`, `/setting`, `/research`)
  - root command list is filtered by typed text (for example `/s`)
  - subcommands are suggested after a completed root command (for example `/source ` -> `/source add`, `/source get`; `/research ` -> `/research links`, `/research deep`)
  - subcommand list is filtered while typing (for example `/source ad` -> `/source add`)
  - pressing `Enter` with an active suggestion autocompletes to the selected command text instead of sending
  - when no command matches (for example `/source edit`), the suggestion panel is hidden and `Enter` performs normal query send
  - slash command rows are rendered with a distinct command-style background pill in the suggestion list
- `/research` command execution (does not add chat message history entries):
  - `/research <single-http-url>`: add one NotebookLM source via `source_type=url` (works for regular web links and YouTube links)
  - `/research links <url...>`: sequentially add multiple links as NotebookLM sources
  - `/research <query>`: run NotebookLM fast research, import discovered web sources, and keep source IDs for follow-up query scope
  - `/research deep <query>`: run NotebookLM deep research with mutable `task_id` tracking (`task_id` + `query` polling), import eligible web sources, and store deep report markdown for modal viewing
  - all `/research` sources are stored as NotebookLM metadata only (source IDs, titles, urls, query/report metadata). Raw source content remains in NotebookLM unless explicitly fetched later.
- Research chips in composer (same chip area as `@` / `@@`):
  - dedicated non-local icons for link(url), link(youtube), links, research fast, research deep
  - loading spinner for all research types, with `%` progress center for `links`
  - hover-to-show `x` remove behavior; removing a loading research chip excludes it from query scope/UI but does not cancel the underlying NotebookLM operation
  - `no_research` / `error` research results are marked with a light-red chip background and are excluded from query `source_ids`
- Research source click behavior (composer chips + assistant source list):
  - link: open URL directly in default browser
  - links/research fast: open modal to choose URL (title + muted link text)
  - research deep: open deep report modal rendered via `MarkdownRenderer.render`
- Extension-aware source upload:
  - `.md` and `.txt` are uploaded as `source_type=text`
  - allowed non-text/media extensions are uploaded as `source_type=file`
  - disallowed extensions from `@`/`@@` selections are ignored with a notice showing ignored count and extensions
- Result list UX:
  - left-aligned icon, filename, path
  - extension-based icons for folder/markdown/pdf/image/video/code/common file types
- Selected source chips above composer:
  - file/path chips are clickable
  - path chips show only the last folder name and include descendant file count (for example `topic (4)`)
  - hovering a chip shows full source text in a small tooltip (`title`) so truncated names can be read fully
  - explicit `@` / `@@` chips remain visible across follow-up questions in the same tab
  - during explicit background upload, each chip shows a circular loading indicator in place of `x`
  - hovering an uploading chip switches the indicator to `x` so removal is still immediate
  - for multi-file selections (for example folder selections), loading indicator center text shows upload completion percentage
  - each chip remains removable via `x`
  - if an uploading path chip is removed mid-upload, the current file is allowed to finish and remaining queued files for that path are skipped
  - if that path is re-added later, progress starts from already uploaded files (for example `6/10` starts at `60%`)
  - removing a chip excludes that file/path source ID(s) from subsequent query `source_ids`
  - path chip click opens folder note only when `path/name/name.md|canvas|base` exists
- Path guardrails:
  - warning when path expansion exceeds 15 files
  - reject when path expansion exceeds 200 files
- Always-visible `Search vault` toggle in composer:
  - default: enabled
  - persisted in `data.json`
  - when enabled: BM25 + explicit selections
  - when disabled: explicit selections and conversation-carried sources only
- Source reuse across follow-up questions in the same tab/session
- `New` action for fresh conversation context
- `History` modal to reload prior conversations

## Timeout behavior

- `Query timeout (seconds)` default is `300`.
- This setting is used for:
  - `notebook_query` tool argument timeout
  - MCP request timeout for NotebookLM calls (with a small buffer)
- Timeout handling is applied to query, source upload/replacement flow, and startup notebook readiness calls.

## Requirements

- Obsidian Desktop
- Node.js 18+
- Global installation of `notebooklm-mcp-cli`

Install `notebooklm-mcp-cli` (one option):

```bash
pip install notebooklm-mcp-cli
# or
uv tool install notebooklm-mcp-cli
# or
pipx install notebooklm-mcp-cli
```

Authenticate NotebookLM before plugin use:

```bash
nlm login
nlm login --check
```

## Development

Install dependencies:

```bash
npm install
```

Watch build:

```bash
npm run dev
```

Production build:

```bash
npm run build
```

Tests:

```bash
npm test
```

## Usage

1. Build the plugin.
2. Copy `main.js`, `manifest.json`, and `styles.css` to:
   - `<Vault>/.obsidian/plugins/obsidian-vault-assistant/`
3. Enable the plugin at **Settings -> Community plugins**.
4. Run command: `Open NotebookLM chat`.
5. Ask questions in the right sidebar chat view.
6. Optionally add explicit sources via `@` / `@@` before sending.
7. Optionally use `/` command autocomplete in the composer (`/source`, `/create`, `/setting`, `/research`, and supported subcommands).
8. Run `/research` commands from the same composer to prepare NotebookLM-only sources without adding chat history messages.
9. Keep or remove chips above the composer to control carried source scope (`x` excludes removed items from subsequent query `source_ids`).
10. Use `Search vault` toggle to include/exclude BM25 for the current and subsequent queries.

## Settings

- `Debug mode`
- `Refresh Auth`
- BM25 parameters:
  - `Top N`
  - `cutoff ratio`
  - `min K`
  - `k1`
  - `b`
- `Query timeout (seconds)` (default `300`)

## Repository structure

- `/Users/jaewone/developer/utils/obsidian/current_using/obsidian-vault-assistant/src/main.ts`: minimal entrypoint
- `/Users/jaewone/developer/utils/obsidian/current_using/obsidian-vault-assistant/src/plugin/NotebookLMPlugin.ts`: plugin lifecycle + orchestration
- `/Users/jaewone/developer/utils/obsidian/current_using/obsidian-vault-assistant/src/plugin/ExplicitSourceSelectionService.ts`: `@` / `@@` search and path expansion logic
- `/Users/jaewone/developer/utils/obsidian/current_using/obsidian-vault-assistant/src/plugin/SourcePreparationService.ts`: source upload/reuse/replace/eviction algorithm service
- `/Users/jaewone/developer/utils/obsidian/current_using/obsidian-vault-assistant/src/plugin/explicitSelectionMerge.ts`: BM25 + explicit merge utilities
- `/Users/jaewone/developer/utils/obsidian/current_using/obsidian-vault-assistant/src/plugin/historySourceIds.ts`: bounded history source carry-over logic
- `/Users/jaewone/developer/utils/obsidian/current_using/obsidian-vault-assistant/src/mcp/NotebookLMMcpClient.ts`: MCP subprocess/client wrapper
- `/Users/jaewone/developer/utils/obsidian/current_using/obsidian-vault-assistant/src/search/BM25.ts`: BM25 indexing/search logic
- `/Users/jaewone/developer/utils/obsidian/current_using/obsidian-vault-assistant/src/storage/PluginDataStore.ts`: persisted settings/history/source registry
- `/Users/jaewone/developer/utils/obsidian/current_using/obsidian-vault-assistant/src/ui/`: chat view, mention parser, history modal, settings tab

## Algorithm documentation

- `/Users/jaewone/developer/utils/obsidian/current_using/obsidian-vault-assistant/BM25_NOTEBOOKLM_ALGORITHMS_0.4.0.md`
- `/Users/jaewone/developer/utils/obsidian/current_using/obsidian-vault-assistant/BM25_NOTEBOOKLM_PIPELINE_0.4.0.md`

## Troubleshooting

`notebooklm-mcp` or `nlm` not found:

```bash
which notebooklm-mcp
which nlm
```

Authentication issues:

```bash
nlm login
nlm login --check
```

General diagnostics:

```bash
nlm doctor --verbose
```
