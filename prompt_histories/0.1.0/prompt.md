You are GPT5.3-Codex-extrahigh.

Your task is to implement an Obsidian Desktop plugin in the **Obsidian sample plugin** codebase that integrates with Google NotebookLM via the community package `notebooklm-mcp-cli`.

**Important constraint:** the Codex workspace does NOT include the `notebooklm-mcp-cli` Python package.(Package Code is not needed for developering) You must implement integration by spawning the globally installed executables on the user's machine:

- `notebooklm-mcp` (MCP server)
- `nlm` (CLI)

Use these reference documents (provided in the workspace / prompt context):
- `notebooklm-mcp-cli_for_obsidian_plugin.md`
- `obsidian_notebooklm_plugin_spec.md`
- `notebooklm-mcp-cli_for_obsidian_plugin.md`

---

## 0) What you must build (MVP)

Implement a right-sidebar **Chat View** that lets the user type a question. When they send:

1. Run BM25 search over all markdown files in the vault.
2. Select sources using the exact rule:
   - Score all docs
   - Take Top N=15
   - Dynamic threshold filter: keep docs >= topScore * cutoffRatio (default 0.40)
   - If fewer than K=3 remain, force take top K from the Top N list
3. Ensure each selected note is uploaded to NotebookLM (as a text source) if not already uploaded.
4. Run `notebook_query` with `source_ids` restricted to the selected sources.
5. Display the answer.
6. Store conversation history to JSON with metadata (time, selected files, scores, source IDs, etc.).

Additional requirements:
- Single-tab operation only.
- “New” button clears the chat and starts a new NotebookLM conversation.
- “History” button opens a modal listing prior conversations; selecting one loads it into the chat UI and re-uploads its files to NotebookLM if needed.
- No Debug panel in UI.
- Settings panel must contain:
  - Debug Mode checkbox: when enabled, log all activities to `console.*`
  - Refresh Auth button: call MCP `refresh_auth()` then verify connectivity; if it fails, instruct user to run `nlm login`

---

## 1) External Tool Integration Requirements

### 1.1 Start MCP server as a subprocess
- Spawn: `notebooklm-mcp --transport stdio`
- When Debug Mode is enabled, spawn with `--debug`.
- Keep it running for the plugin lifetime.
- On plugin unload: kill the process.
- If the binary is missing (ENOENT), show a Notice explaining the user must install `notebooklm-mcp-cli` globally.

### 1.2 MCP Client
- Use the official MCP TypeScript SDK (add dependency):
  - `@modelcontextprotocol/sdk`
  - plus any peer deps (e.g., `zod`) if required by the SDK
- Use the stdio transport to connect to the spawned server.
- Implement a thin wrapper:
  - `callTool(name, args)` that returns parsed JSON
  - auto-reconnect if the server crashes

### 1.3 MCP tools you must call
- `server_info()`
- `refresh_auth()`
- `notebook_create(title)`
- `notebook_get(notebook_id)`
- `source_add(notebook_id, source_type="text", text, title, wait=True)`
- `source_delete(source_id, confirm=True)` (for eviction)
- `notebook_query(notebook_id, query, source_ids=[...], conversation_id?, timeout?)`

---

## 2) Notebook + Source Pool Rules

- Use exactly **one NotebookLM notebook** for the whole plugin.
- Persist `notebookId` in plugin settings/data.
- If it doesn’t exist yet:
  - create it with `notebook_create("Obsidian Vault Notebook")`
- Maintain a source registry mapping:
  - `Obsidian path -> sourceId`
- If the source does not exist remotely anymore (evicted or removed):
  - re-upload when needed.

### Source capacity
- Treat max sources as 300.
- Use headroom (10) and target capacity 290.
- Implement eviction policy (2Q/SLRU):
  - probation/protected segments
  - evict from probation tail first
  - use `source_delete(confirm=True)` for eviction

Log evictions in Debug Mode and record them in conversation metadata.

---

## 3) BM25 Implementation Requirements (Exact)

Implement a BM25 engine:

- Index all markdown files (`app.vault.getMarkdownFiles()`).
- Build an inverted index for performance.
- Tokenization (MVP):
  - lowercase
  - replace punctuation with spaces
  - split whitespace
- BM25 formula (Okapi BM25):
  - defaults: `k1=1.2`, `b=0.75`
- For each query:
  - compute scores
  - pick Top N=15
  - apply cutoffRatio 0.40 relative to topScore
  - enforce minK=3
- Return selected files in descending score order and preserve scores for metadata.

---

## 4) UI & UX Implementation Details

### Chat view (right sidebar)
- Implement as a custom view registered by the plugin and attached to the right leaf.
- UI elements:
  - Message list (user + assistant bubbles)
  - Input box + Send
  - New button (clears)
  - History button (opens modal)

### History modal
- Shows list of prior conversations (reverse chronological).
- Selecting:
  - loads messages
  - ensures its selected files are uploaded (re-upload if needed)
  - sets active conversationId to the stored one if present (best effort)

### Settings tab
- Use Obsidian `PluginSettingTab`.
- Add:
  - Debug Mode checkbox
  - Refresh Auth button
  - BM25 parameters (TopN, cutoffRatio, K, k1, b) as numeric settings

### Debug logging
- No UI debug panel.
- If debugMode:
  - log start/stop of MCP server
  - log each tool call and response (truncate large blobs)
  - log BM25 selection stats

---

## 5) Error Handling Requirements

- If MCP server cannot start:
  - show Notice explaining how to install:
    - `pip install notebooklm-mcp-cli` (or uv/pipx)
- If auth fails:
  - show Notice: “Run `nlm login` in a terminal, then click Refresh Auth in settings.”
- For timeouts:
  - surface a user-friendly error and keep the chat responsive

---

## 6) Code Organization Requirements

Create clear modules (suggested):

- `src/mcp/NotebookLMMcpClient.ts`
- `src/search/BM25.ts`
- `src/storage/PluginDataStore.ts`
- `src/ui/ChatView.ts`
- `src/ui/HistoryModal.ts`
- `src/ui/SettingsTab.ts`
- `src/logging/logger.ts`

No external UI frameworks required; use vanilla DOM.

---

## 7) Deliverable

Modify the Obsidian sample plugin project such that:

- `npm run build` succeeds
- Plugin can be installed into Obsidian and used on a real machine where `notebooklm-mcp-cli` is installed
- Core workflow works end-to-end per spec

Provide concise README instructions in the repo for:
- prerequisites (`nlm login`, verifying with `nlm login --check`)
- enabling Debug Mode
- common troubleshooting steps (`nlm doctor`)