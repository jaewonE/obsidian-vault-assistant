# Obsidian Vault Assistant

Version: `0.2.2`

Obsidian Desktop community plugin that integrates with Google NotebookLM through globally installed `notebooklm-mcp-cli` executables:

- `notebooklm-mcp` (MCP server)
- `nlm` (CLI for login/diagnostics)

The plugin provides a right-sidebar chat workflow:

1. BM25 search over vault markdown notes
2. Top N and dynamic threshold source selection
3. Upload selected notes as NotebookLM text sources (if missing)
4. Query NotebookLM with restricted `source_ids`
5. Persist conversation history and query metadata

## Features

- Right sidebar chat view (single-tab operation)
- User questions in speech bubbles with NotebookLM answers rendered as markdown text
- Live 3-step progress UI (BM25 selection -> source upload -> NotebookLM response wait)
- In-tab source context reuse across follow-up questions (previous source IDs are passed with new queries)
- Per-answer source list toggle with clickable source items that open files in new Obsidian tabs
- `New` action for a fresh conversation context
- `History` modal to reload prior conversations
- Source registry with capacity control and eviction
- Settings for debug mode, auth refresh, and BM25 parameters
- Resilient MCP client integration (stdio subprocess + reconnect)

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

## Usage

1. Build the plugin.
2. Copy `main.js`, `manifest.json`, and `styles.css` to:
   - `<Vault>/.obsidian/plugins/obsidian-vault-assistant/`
3. Enable the plugin at **Settings → Community plugins**.
4. Run command: `Open NotebookLM chat`.
5. Ask questions in the right sidebar chat view.

## Settings

- `Debug mode`
- `Refresh Auth`
- BM25 parameters:
  - `Top N`
  - `cutoff ratio`
  - `min K`
  - `k1`
  - `b`
- Query timeout seconds

## Repository structure

- `/Users/jaewone/developer/utils/obsidian/current_using/obsidian-vault-assistant/src/main.ts`: minimal entrypoint
- `/Users/jaewone/developer/utils/obsidian/current_using/obsidian-vault-assistant/src/plugin/NotebookLMPlugin.ts`: plugin lifecycle + orchestration
- `/Users/jaewone/developer/utils/obsidian/current_using/obsidian-vault-assistant/src/mcp/NotebookLMMcpClient.ts`: MCP subprocess/client wrapper
- `/Users/jaewone/developer/utils/obsidian/current_using/obsidian-vault-assistant/src/search/BM25.ts`: BM25 indexing/search logic
- `/Users/jaewone/developer/utils/obsidian/current_using/obsidian-vault-assistant/src/storage/PluginDataStore.ts`: persisted settings/history/source registry
- `/Users/jaewone/developer/utils/obsidian/current_using/obsidian-vault-assistant/src/ui/`: chat view, history modal, settings tab
- `/Users/jaewone/developer/utils/obsidian/current_using/obsidian-vault-assistant/src/logging/logger.ts`: debug-aware logging

## Implementation considerations (from AGENTS.md)

- Keep `main.ts` minimal and move feature logic into dedicated modules.
- Use npm and esbuild for install/build (`npm install`, `npm run dev`, `npm run build`).
- Keep stable command IDs; avoid renaming public command IDs after release.
- Persist settings/data via `loadData()` and `saveData()`.
- Register listeners with Obsidian `register*` helpers for safe unload behavior.
- Do not commit build artifacts (`main.js`) or `node_modules/`.
- Maintain accurate `manifest.json` and `versions.json` version compatibility.
- Treat plugin `id` as stable once publicly released.
- Keep desktop/mobile constraints explicit via `isDesktopOnly`.
- Follow Obsidian privacy/security guidance (no hidden telemetry, explicit disclosures).

## Troubleshooting

`notebooklm-mcp` or `nlm` not found:

```bash
which notebooklm-mcp
which nlm
```

If missing, reinstall globally.

Authentication issues:

```bash
nlm login
nlm login --check
```

Then use `Refresh Auth` in plugin settings.

General diagnostics:

```bash
nlm doctor --verbose
```
