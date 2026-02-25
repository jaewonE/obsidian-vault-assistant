# BM25 + NotebookLM Algorithms and Implementation (v0.4.0)

## 1. Purpose

This document specifies the production algorithms used in `v0.4.0` for:

1. Existing BM25 retrieval + source preparation pipeline from `v0.3.2`.
2. New explicit source selection pipeline via composer `@` / `@@`.
3. Merge semantics between BM25-selected sources and explicitly selected files/paths.
4. Query metadata persistence updates for explicit selections.

`v0.4.0` keeps BM25 scoring/indexing behavior unchanged and adds an orthogonal user-driven source inclusion flow.

---

## 2. Runtime architecture (v0.4.0)

Main components:

- Search/index:
  - `src/search/BM25.ts`
  - `src/search/tokenization.ts`
  - `src/search/markdownFields.ts`
- Explicit path selection:
  - `src/ui/pathMention.ts`
  - `src/plugin/ExplicitSourceSelectionService.ts`
  - `src/plugin/explicitSelectionMerge.ts`
- Source sync/orchestration:
  - `src/plugin/SourcePreparationService.ts`
  - `src/plugin/NotebookLMPlugin.ts`
  - `src/plugin/historySourceIds.ts`
- Persistence/state:
  - `src/storage/PluginDataStore.ts`
- UI:
  - `src/ui/ChatView.ts`
- MCP transport/retry:
  - `src/mcp/NotebookLMMcpClient.ts`

---

## 3. Composer mention parsing algorithm (`@` / `@@`)

Implementation: `src/ui/pathMention.ts`

### 3.1 Active token detection

Given textarea value and cursor position:

1. Scan backward from cursor to token start (whitespace boundary).
2. Reject if token does not start with `@`.
3. Reject if token is embedded in another token (non-whitespace prefix).
4. Parse:
   - `@term` -> mode `markdown`
   - `@@term` -> mode `all`
5. Return token bounds (`tokenStart`, `tokenEnd`) and search `term`.

### 3.2 Token replacement on selection

When user selects one search result:

1. Replace only the active mention token span with empty replacement.
2. Restore cursor at the replaced token start.
3. Keep the remaining query text unchanged.

This enforces one selected file/path per single mention token.

---

## 4. Explicit source search algorithm

Implementation: `src/plugin/ExplicitSourceSelectionService.ts`

### 4.1 Mode-specific file universe

- `@` (`markdown` mode): file universe is `vault.getMarkdownFiles()`.
- `@@` (`all` mode): file universe is `vault.getFiles()`.

### 4.2 Candidate types

Search returns two candidate kinds:

1. `file`: single file candidate (path + extension + parent path)
2. `path`: folder candidate (folder path + descendant file count)

Folder candidates are included only if descendant file count in current mode is > 0.

### 4.3 Ranking

Candidates are ranked by lexical match score over file/folder name and full path:

- exact/startsWith/contains boosts
- path-level boosts
- deterministic tie-break by kind then path

If the active mention has no matches, UI renders `No more files found.`

---

## 5. Path expansion and thresholds

Implementation: `src/plugin/ExplicitSourceSelectionService.ts`

When a `path` candidate is selected:

1. Resolve descendants recursively by path prefix.
2. Apply mode filter (`markdown` vs `all`).
3. Compute `subfileCount`.

Threshold policy:

- `subfileCount > 15`: selection allowed, warning notice emitted.
- `subfileCount > 200`: selection rejected with notice.

This policy is applied before query execution.

---

## 6. Folder note resolution algorithm

Implementation: `src/plugin/ExplicitSourceSelectionService.ts`, `src/plugin/NotebookLMPlugin.ts`

When user clicks a selected `path` chip in composer:

1. Let selected path be `a/b`.
2. Compute folder name `b`.
3. Probe candidates in order:
   - `a/b/b.md`
   - `a/b/b.canvas`
   - `a/b/b.base`
4. Open first existing candidate in a new tab.
5. If none exist, show notice and do not navigate.

---

## 7. BM25 + explicit selection merge algorithm

Implementation: `src/plugin/explicitSelectionMerge.ts`, `src/plugin/NotebookLMPlugin.ts`

For each query:

1. Run BM25 as before and obtain selected markdown paths.
2. Flatten all explicit composer selections into explicit file paths.
3. Build preparation set:

`preparedPaths = dedupe(BM25Paths ∪ ExplicitPaths)`

4. Prepare sources for `preparedPaths` via `ensureSourcesForPaths`.
5. Build current source IDs from prepared BM25 + explicit paths.
6. Merge with historical reusable source IDs (carry-over).
7. Query NotebookLM with merged source IDs.

If BM25 selects zero documents but explicit paths exist, query still proceeds with explicit sources.

---

## 8. Source preparation content-read update

Implementation: `src/plugin/SourcePreparationService.ts`, `src/plugin/NotebookLMPlugin.ts`

`SourcePreparationDependencies.readMarkdown` was generalized to:

`readSourceContent(path): Promise<string | null>`

This allows `@@` mode to route non-markdown vault files through the same source preparation pipeline.

Read failures are handled as skip/null with warning logs to preserve query stability.

---

## 9. Persistence schema update

Implementation: `src/types.ts`, `src/storage/PluginDataStore.ts`

`ConversationQueryMetadata` now optionally stores `explicitSelections[]`:

- `kind`: `file | path`
- `mode`: `markdown | all`
- `path`: selected file/folder path
- `resolvedPaths[]`: concrete file paths included in this query
- `subfileCount`: resolved file count for the selected item

`QuerySourceSummary` now optionally stores `explicitSelectedCount`.

Normalization is backward-compatible for older records without these fields.

---

## 10. UI/UX algorithmic behavior

Implementation: `src/ui/ChatView.ts`, `styles.css`

1. Typing `@` / `@@` triggers live suggestion panel.
2. Search list rows include:
   - extension-based icon (or folder icon for paths)
   - filename with extension (or folder name)
   - muted path line with ellipsis overflow
3. Selection creates composer chip above input.
4. Path chips render `path (count)`.
5. Each chip has `x` removal control.
6. Send flow clears draft chips and passes resolved explicit selections to query execution.

---

## 11. Verification

Added/updated tests:

- `test/ui/pathMention.test.ts`
- `test/plugin/ExplicitSourceSelectionService.test.ts`
- `test/plugin/explicitSelectionMerge.test.ts`
- `test/storage/PluginDataStore.test.ts` (explicit selection normalization)
- existing source preparation + integration tests remain green.
