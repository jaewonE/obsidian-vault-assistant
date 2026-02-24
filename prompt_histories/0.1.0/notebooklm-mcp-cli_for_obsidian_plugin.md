# notebooklm-mcp-cli (nlm + notebooklm-mcp) — Practical Notes for Building an Obsidian Plugin

This document is written for an Obsidian plugin developer (TypeScript) who needs to drive **Google NotebookLM** programmatically using the community package **`notebooklm-mcp-cli`**.

It provides:

- A concise explanation of what the package is and how it works
- The **minimum CLI commands** you’ll use for troubleshooting and manual testing
- The **MCP server** entry point and the **tool surface** (names + parameters) needed for the plugin workflow
- End-to-end **examples that mirror the plugin behavior**

Assumptions (per the project requirements):

- The end user is on **Obsidian Desktop only** (Electron/Node available).
- The end user installed `notebooklm-mcp-cli` globally (e.g., `pip install notebooklm-mcp-cli` / `uv tool install notebooklm-mcp-cli`).
- Therefore, the following executables are available on the user's PATH:
  - `nlm` (CLI)
  - `notebooklm-mcp` (MCP server)
- Authentication can be verified via: `nlm login --check`.

---

## 1. What `notebooklm-mcp-cli` is (and what it is not)

### What it is
`notebooklm-mcp-cli` is a Python package that provides two user-facing executables:

- **`nlm`**: a command-line interface for NotebookLM operations
- **`notebooklm-mcp`**: an MCP server exposing NotebookLM operations as MCP tools (for any MCP client)

Under the hood, it uses NotebookLM’s **internal (undocumented) endpoints**, authenticated via **browser cookies** extracted from Chrome (via Chrome DevTools Protocol). There is no official public API.

### What it is not
- Not an official Google API.
- Not a long-term stable API surface (internal endpoints can change).

---

## 2. Authentication: required before CLI or MCP usage

### One-time login (recommended)
```bash
nlm login
```

This opens Chrome, you sign in, and tokens/cookies are cached locally.

### Verify current auth (the plugin will rely on this pattern)
```bash
nlm login --check
```

If it fails, re-run:
```bash
nlm login
```

### Useful troubleshooting options
Increase devtools connect timeout if Chrome is slow to respond:
```bash
nlm login --devtools-timeout 15
```

Multi-profile support (optional):
```bash
nlm login --profile work
nlm login --profile personal
nlm login profile list
nlm login switch personal
```

### Where auth is stored (important for debugging)
Auth tokens and profiles are stored under:
- `~/.notebooklm-mcp-cli/`

---

## 3. MCP Server: `notebooklm-mcp`

### Start server (stdio transport — recommended for desktop apps)
```bash
notebooklm-mcp --transport stdio
```

`stdio` is the default transport, so this also works:
```bash
notebooklm-mcp
```

### Debug logging
```bash
notebooklm-mcp --debug
```

Environment variable alternative:
```bash
NOTEBOOKLM_MCP_DEBUG=true notebooklm-mcp
```

### Other options (not needed for Obsidian)
- `--transport http --port 8000` (streamable HTTP)
- `--transport sse` (legacy)

---

## 4. MCP Tool Surface (names + key parameters)

The Obsidian plugin can treat MCP tools as “RPC methods”.

Below are the **minimum tools** you’ll need for the MVP:

### Notebooks
- `notebook_list(max_results=100)`
- `notebook_create(title="")`
- `notebook_get(notebook_id)`
  - returns: notebook metadata and `sources[]` with `{id, title}`

### Sources
- `source_add(notebook_id, source_type, url?, text?, title?, file_path?, document_id?, doc_type="doc", wait=False, wait_timeout=120.0)`
  - for Obsidian markdown notes, you’ll typically use:
    - `source_type="text"`
    - `text=<note content>`
    - `title=<obsidian path or display title>`
    - `wait=True`
- `source_delete(source_id, confirm=False)`
  - for automated eviction you must set `confirm=True`
  - **IRREVERSIBLE**
- (Optional later)
  - `source_get_content(source_id)`
  - `source_list_drive(notebook_id)`
  - `source_sync_drive(source_ids, confirm=True)`

### Querying
- `notebook_query(notebook_id, query, source_ids=None, conversation_id=None, timeout=None)`
  - `source_ids`: **subset query** (the key feature enabling a single notebook + 300-source pool)
  - `conversation_id`: continue within one conversation
  - if `conversation_id=None`, a new conversation is started

### Auth management
- `refresh_auth()`
  - reloads auth tokens from disk cache or attempts headless refresh if possible
  - if no tokens exist, it returns an error advising to run `nlm login`

### Server info
- `server_info()`

---

## 5. CLI commands for manual testing (mirror the plugin)

Even if the plugin uses MCP, the CLI is extremely useful for:

- verifying auth
- sanity-checking notebook IDs and source IDs
- reproducing failures outside Obsidian

### 5.1 Quick checks
```bash
nlm login --check
nlm doctor --verbose
```

### 5.2 Create (or identify) the notebook to be used by the plugin
List notebooks:
```bash
nlm notebook list --json
```

Create a notebook:
```bash
nlm notebook create "Obsidian Vault Notebook"
```

Get notebook details (including sources list/count):
```bash
nlm notebook get <notebook-id> --json
```

### 5.3 Add an Obsidian note as a TEXT source
```bash
nlm source add <notebook-id> --text "Your pasted markdown text here" --title "vault/path/to/note.md" --wait
```

(For local files like PDFs — future feature)
```bash
nlm source add <notebook-id> --file /absolute/path/to/document.pdf --wait
```

### 5.4 List sources (and capture IDs)
```bash
nlm source list <notebook-id> --json
```

### 5.5 Query with subset selection (critical feature)
The CLI supports selecting a subset of sources using `--source-ids` (comma-separated).

Example:
```bash
nlm notebook query <notebook-id> "What does this note say about X?" --source-ids <sourceIdA>,<sourceIdB>,<sourceIdC> --json
```

⚠️ Note: The CLI splits on commas and does not trim whitespace. Avoid spaces after commas.

### 5.6 Follow-up queries in the same conversation
Capture the `conversation_id` from the first response, then:

```bash
nlm notebook query <notebook-id> "Follow-up question..." --conversation-id <conversation-id> --source-ids <sourceIdA>,<sourceIdB> --json
```

### 5.7 Delete sources (IRREVERSIBLE)
```bash
nlm source delete <source-id> --confirm
```

---

## 6. How the Obsidian plugin should use this package (summary)

In the Obsidian plugin:

1. Spawn `notebooklm-mcp --transport stdio` as a background subprocess.
2. Connect to it via an MCP TypeScript client.
3. Ensure the user is authenticated:
   - Option A (recommended): call `refresh_auth()` and then run a cheap check like `notebook_list`.
   - If it fails: show instructions to run `nlm login` in a terminal.
4. Ensure one notebook exists (create it once, save `notebook_id`).
5. Maintain a 300-source pool:
   - add new Obsidian markdown notes as `text` sources
   - query via `notebook_query(..., source_ids=[...])` so each question uses only the selected subset

---

## 7. Known limitation for “source citations / sources used”
The service layer expects `sources_used`, but the current core query implementation may not populate it reliably.

Therefore, in the MVP plugin:
- Treat “sources used” as the **sources you selected** (BM25-selected subset).
- Save that subset in your own history metadata.
