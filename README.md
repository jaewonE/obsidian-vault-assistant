# Obsidian Vault Assistant

Version: `0.4.2`

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
- Explicit source selection in composer:
  - type `@` for markdown-only file/path search
  - type `@@` for all-file file/path search
  - live search updates while typing
  - keyboard and mouse selection support (`ArrowUp`, `ArrowDown`, `Enter`, `Escape`)
  - supports search terms with spaces and underscore-to-space matching
- Extension-aware source upload:
  - `.md` and `.txt` are uploaded as `source_type=text`
  - allowed non-text/media extensions are uploaded as `source_type=file`
  - disallowed extensions from `@`/`@@` selections are ignored with a notice showing ignored count and extensions
- Result list UX:
  - left-aligned icon, filename, path
  - extension-based icons for folder/markdown/pdf/image/video/code/common file types
- Selected source chips above composer:
  - file/path chips are clickable
  - path chips include descendant file count (for example `docs/topic (4)`)
  - explicit `@` / `@@` chips remain visible across follow-up questions in the same tab
  - each chip removable via `x`
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
7. Keep or remove chips above the composer to control carried source scope (`x` excludes removed items from subsequent query `source_ids`).
8. Use `Search vault` toggle to include/exclude BM25 for the current and subsequent queries.

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
