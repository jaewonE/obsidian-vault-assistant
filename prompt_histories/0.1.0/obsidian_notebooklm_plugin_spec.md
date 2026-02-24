# Obsidian NotebookLM Plugin — Technical Specification (MVP)

This spec describes the MVP implementation of an Obsidian Desktop plugin that:

- Searches the vault using BM25
- Uploads selected notes into a single NotebookLM notebook as sources (up to 300 sources)
- Queries NotebookLM using **subset source selection** (`source_ids`)
- Stores chat history as JSON with metadata
- Provides minimal UI in the **right sidebar** with a chat interface

The plugin integrates with the globally installed executables from `notebooklm-mcp-cli`:
- `notebooklm-mcp` (MCP server)
- `nlm` (CLI, for auth check/troubleshooting)

---

## 0. Scope & Constraints

### Desktop-only
- The plugin will be Desktop-only (Electron/Node available).
- It may spawn subprocesses via Node’s `child_process`.

### External dependency assumption
- The end user has installed `notebooklm-mcp-cli` globally.
- `nlm` and `notebooklm-mcp` are on PATH.

### MVP focus
- No manual source selection UI yet (drag/drop, link parsing, attachment uploads are deferred).
- No explicit citation parsing/labeling yet.
- Focus on end-to-end “ask → retrieve → upload-if-needed → query → record”.

---

## 1. UI Requirements (Right Sidebar Chat)

### Chat view
- Render as a right sidebar view.
- Components:
  - Scrollable message list
  - Input box + Send button
  - “New” button: clears chat and starts a new conversation (new NotebookLM conversation)
  - “History” button (icon): opens a modal to load past conversations

### Debug
- Do NOT show a Debug panel in the chat UI.
- Provide a **Settings checkbox**: “Debug Mode”.
  - When enabled, write detailed logs to the console:
    - MCP server lifecycle (spawn, connect, restart)
    - every tool call name + params (sanitized/truncated)
    - every tool response (sanitized/truncated)
    - BM25 scoring stats (top score, threshold, selected docs, elapsed ms)

### Refresh auth
- Do NOT show an auth button in the chat UI.
- Provide a **Settings button**: “Refresh Auth”.
  - Behavior:
    1. Try MCP tool `refresh_auth()`
    2. Optionally run a cheap tool call (e.g., `notebook_list`) to verify it works
    3. If still failing: show instructions: run `nlm login` in a terminal

---

## 2. Conversation Model (Single tab only)

### Single active conversation
- The plugin operates a single “active conversation” state.
- Pressing “New”:
  - Clears the UI message list
  - Creates a new local conversation record
  - Clears the active NotebookLM `conversation_id` so the next query starts a new conversation

### History system
- Conversations are stored in plugin data as JSON.
- The History modal shows a list of prior conversations (date/time + first user message snippet + number of sources).
- Selecting a conversation:
  - Loads its messages into the chat UI
  - Ensures the sources referenced by that conversation are uploaded to the notebook
  - Sets active conversation context:
    - Recommended MVP behavior: keep using the stored `conversation_id` if present, but be aware that the MCP server’s internal conversation cache is process-local and may not survive restarts.

**Note on limitations:**  
NotebookLM follow-ups rely on `conversation_id` and server-side (or client cached) history. If the MCP server restarts or Obsidian restarts, continuing a historical conversation may not preserve context. The plugin should still:
- restore the conversation transcript for the user to read
- re-upload sources used in that conversation
- allow continuing with new questions (even if context becomes “fresh” on NotebookLM’s side)

---

## 3. Data Persistence (Plugin saveData)

### Settings (persisted)
- `debugMode: boolean` (default: false)
- `notebookId: string | null` (created once, stored)
- BM25 parameters:
  - `bm25TopN: number` (default: 15)
  - `bm25CutoffRatio: number` (default: 0.40)
  - `bm25MinSourcesK: number` (default: 3)
  - `bm25k1: number` (default: 1.2)
  - `bm25b: number` (default: 0.75)
- Query:
  - `queryTimeoutSeconds: number` (default: 120)

### Operational state (persisted)
- `sourceRegistry` (mapping between Obsidian files and NotebookLM sources)
  - `byPath[path] -> { sourceId, title, addedAt, lastUsedAt, useCount, contentHash? }`
  - `bySourceId[sourceId] -> { path, ... }`
- `conversationHistory[]`
  - Each entry includes:
    - `id` (uuid)
    - `createdAt`, `updatedAt` (ISO string)
    - `notebookId`
    - `notebookConversationId` (optional)
    - `messages[]` (role=user|assistant, text, at)
    - `bm25Selection`:
      - `query`
      - `topN`
      - `cutoffRatio`
      - `minK`
      - `top15[]`: [{ path, score }]
      - `selected[]`: [{ path, score, sourceId? }]
    - `selectedSourceIds[]` (final list used for the query)
    - `errors[]` (optional)

---

## 4. NotebookLM Integration (via MCP)

### Server lifecycle
- On plugin load:
  1. Spawn `notebooklm-mcp --transport stdio` as a subprocess.
  2. Connect via MCP TypeScript client.
  3. If Debug Mode: spawn with `--debug` and enable verbose console logs in plugin.

- On plugin unload:
  - cleanly terminate the subprocess

### Notebook selection
- Use **one notebook** for the whole vault (MVP).
- If `notebookId` missing:
  - call `notebook_create(title="Obsidian Vault Notebook")`
  - persist returned `notebook_id`
- On each start:
  - call `notebook_get(notebookId)` and reconcile local registry:
    - if a `sourceId` no longer exists, mark mapping as stale so it can be re-uploaded later

### Source upload strategy (MVP)
- Upload Obsidian markdown notes as `source_type="text"`:
  - `source_add(notebookId, "text", text=<note content>, title=<vault path>, wait=True)`
- Do not upload duplicates:
  - if `sourceRegistry.byPath[path]` exists AND its `sourceId` still exists in `notebook_get` sources list → reuse it
  - if mapping exists but sourceId is missing remotely → re-upload and update mapping

### Query strategy (subset selection)
- For each user question:
  - compute BM25 candidates
  - select final K sources (see BM25 section)
  - upload if needed, producing `selectedSourceIds[]`
  - call `notebook_query(notebookId, queryText, source_ids=selectedSourceIds, conversation_id=currentConversationId, timeout=queryTimeoutSeconds)`
  - save returned `conversation_id` as `currentConversationId` (for follow-ups)
  - append assistant response to UI and store conversation record

---

## 5. Source Pool Capacity Management (300 sources)

NotebookLM supports ~300 sources per notebook (subject to change). For an evergreen vault, the plugin needs an eviction policy when adding new sources.

### Recommended MVP policy: 2Q / Segmented LRU (SLRU) with optional pinning
Why:
- BM25 retrieval produces a mix of “one-off” sources and “frequently reused” sources.
- Plain LRU is prone to cache pollution.

#### Data structures
- `probation` queue (recently added, not yet proven reusable)
- `protected` queue (promoted after reuse)
- (optional later) `pinned` set: never evict automatically

#### Rules
- New source → insert into probation (front)
- When a source is selected for a query:
  - if in probation → promote to protected (front)
  - if in protected → move to front (refresh)
- Eviction:
  - if source_count >= (maxSources - headroom), evict from probation (tail)
  - if probation empty, demote protected tail into probation then evict
- Eviction action:
  - MCP tool `source_delete(source_id, confirm=True)`
  - Update registry (remove mappings)

#### Parameters
- `maxSources = 300`
- `headroom = 10` (avoid evicting on every query)
- `target = maxSources - headroom = 290`
- `protectedCap ≈ 70% of target`

**Important:** deletion is irreversible on NotebookLM side; the plugin should:
- log every eviction in Debug Mode
- store evicted sources in history metadata so they can be re-uploaded if needed

---

## 6. BM25 Retrieval Requirements (Exact)

Given a natural language user query:

1. Compute BM25 scores for all vault markdown notes.
2. Select the **top N** notes by score:
   - `N = 15` (default)
3. Apply dynamic threshold filtering:
   - Let `topScore` be the highest score (100% baseline).
   - Keep notes where `score >= topScore * cutoffRatio`.
   - `cutoffRatio = 0.40` (default)
4. If the filtered set has fewer than `K` notes:
   - Force select **K notes** using the highest scores from the original Top N list
   - `K = 3` (default)
5. Final selected notes become the NotebookLM subset sources for the query.
6. If a selected note is already uploaded, do not re-upload.

### Implementation notes
- Only index `.md` files returned by `app.vault.getMarkdownFiles()`.
- Exclude `.obsidian/` and optionally exclude templates/daily notes by folder rules (MVP can keep it simple).
- Tokenization: simple normalization is acceptable for MVP:
  - lower-case
  - replace punctuation with spaces
  - split on whitespace
- Default BM25 parameters:
  - `k1 = 1.2`
  - `b = 0.75`

---

## 7. Deliverables & Acceptance Criteria

### Must-have behaviors
- Plugin compiles in the Obsidian sample plugin environment.
- Right sidebar chat UI works; no debug panel in UI.
- Debug Mode causes verbose console output.
- Refresh Auth exists in Settings; uses MCP `refresh_auth()` and verifies.
- New conversation clears UI and resets conversation context.
- History modal loads stored conversation transcripts and re-uploads sources used.
- BM25 search + selection rules exactly as specified.
- NotebookLM query uses `source_ids` subset.

### Nice-to-have (still MVP-safe)
- settings for BM25 parameters
- settings for notebook title
- a “Reset Notebook ID” option (dangerous, requires confirmation)

---

## 8. Deferred Features (explicitly out of scope now)
- Drag & drop file sources
- Parsing note links to automatically include linked notes
- Uploading embedded attachments (png/pdf) referenced inside notes
- Citation parsing + label injection into notes
