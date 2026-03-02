# BM25 + NotebookLM Algorithms and Implementation (v0.5.0)

## 1. Purpose

This document specifies the production algorithms used in `v0.5.0` for:

1. Existing BM25 retrieval + source preparation pipeline from `v0.3.2`.
2. New explicit source selection pipeline via composer `@` / `@@`.
3. Merge semantics between BM25-selected sources and explicitly selected files/paths.
4. Query metadata persistence updates for explicit selections.
5. Slash command and subcommand autocomplete in composer (`/source`, `/create`, `/setting`, `/source add`, `/source get`).

`v0.5.0` keeps BM25 scoring/indexing behavior unchanged, preserves explicit-source pre-upload behavior from `v0.4.4`, and adds slash-command/subcommand autocomplete behavior in composer mention UX.

---

## 2. Runtime architecture (v0.5.0)

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
  - `src/plugin/sourceUploadPolicy.ts`
- Persistence/state:
  - `src/storage/PluginDataStore.ts`
- UI:
  - `src/ui/ChatView.ts`
  - `src/ui/slashCommands.ts`
- MCP transport/retry:
  - `src/mcp/NotebookLMMcpClient.ts`

---

## 3. Composer mention parsing algorithm (`@` / `@@` / `/`)

Implementation: `src/ui/pathMention.ts`, `src/ui/slashCommands.ts`, `src/ui/ChatView.ts`

### 3.1 Active explicit-source token detection (`@`, `@@`)

Given textarea value and cursor position:

1. Scan backward from cursor to token start (whitespace boundary).
2. Reject if token does not start with `@`.
3. Reject if token is embedded in another token (non-whitespace prefix).
4. Parse:
   - `@term` -> mode `markdown`
   - `@@term` -> mode `all`
5. Return token bounds (`tokenStart`, `tokenEnd`) and search `term`.

### 3.2 Explicit-source token replacement on selection

When user selects one search result:

1. Replace only the active mention token span with empty replacement.
2. Restore cursor at the replaced token start.
3. Keep the remaining query text unchanged.

This enforces one selected file/path per single mention token.

### 3.3 Active slash-command token detection (`/`)

Given textarea value and cursor position:

1. Scan backward from cursor to whitespace boundary.
2. Detect `/` token start only when prefix is start-of-line or whitespace.
3. Keep token active while term contains spaces, so subcommand input remains in same token (for example `source ad`).
4. Reject only on line-break boundaries.
5. Return slash token bounds and term.

### 3.4 Slash command candidate generation and completion

1. For empty slash term, return root commands: `/source`, `/create`, `/setting`.
2. For partial root term (for example `s`), return root commands with `startsWith` match.
3. If root command is fully typed and followed by space (for example `source `), return supported subcommands for that root:
   - `/source add`
   - `/source get`
4. Apply `startsWith` filtering on subcommand input (for example `source ad` -> `/source add`).
5. If slash token has zero candidates, hide command suggestion panel for that token.
6. On `Enter` while panel is visible, select hovered/keyboard-active candidate; if none active, select top candidate.
7. Replace slash token with full selected command text and keep focus in composer.
8. If panel is hidden (no candidates), `Enter` executes normal query submission.

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

4. Explicit paths are queued for immediate sequential pre-upload as soon as they are selected in composer.
5. During query execution, explicit paths reuse/wait for the same pre-upload queue state.
6. BM25-only paths are prepared during query upload stage.
7. Build current source IDs from prepared BM25 + explicit paths.
8. Build exclusion sets from composer deselections:
   - path exclusions
   - resolved source ID exclusions
9. Merge with historical reusable source IDs (carry-over) after applying exclusions.
10. Query NotebookLM with merged source IDs.

If BM25 selects zero documents but explicit paths exist, query still proceeds with explicit sources.

---

## 8. Source preparation upload strategy update

Implementation: `src/plugin/SourcePreparationService.ts`, `src/plugin/NotebookLMPlugin.ts`, `src/plugin/sourceUploadPolicy.ts`

Source preparation now builds an upload plan per selected path:

1. Validate extension against allowlist.
2. Select upload method by extension:
   - text upload (`source_type=text`) for `.md` / `.txt`
   - file upload (`source_type=file`) for other allowed extensions
3. Build a single-part upload plan (with future-ready part structure for subdivision/splitting).
4. Hash content by method:
   - text hash for text uploads
   - binary hash for file uploads
5. Reuse/replace/rename detection still uses `contentHash` as before.

Disallowed extensions are excluded before source preparation and surfaced to users via notice.

Read/path-resolution failures are handled as skip/null with warning logs to preserve query stability.

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
4. Path chips render `last-folder-name (count)` (for example `topic (23)`).
5. Each chip has `x` removal control.
6. Explicit chips persist after send and remain visible above composer.
7. Chip removal contributes deselected descendants to excluded paths and excluded source IDs for subsequent queries.
8. During in-flight query processing, composer remains interactive (input, mentions, chip controls, search toggle); only action buttons (`Send`, `New`, `History`) are disabled.
9. Selecting an explicit file/path immediately enqueues sequential background source uploads.
10. Query Step 2 upload progress is synchronized with this background state (completed/in-progress counts are reused).
11. While explicit upload is in progress, chip remove control shows a circular loading indicator; after completion it reverts to `x`.
12. Hovering an uploading chip switches its remove control to `x`, and multi-file chips show upload completion percentage text inside the loading indicator.
13. Chip labels keep ellipsis overflow handling, and hovering a chip shows full source text via tooltip.
14. Removing an uploading path chip interrupts that path’s queue: current in-flight file completes, remaining queued files for that path are skipped.
15. If the same path is selected again, progress starts from already prepared files because status computation counts existing prepared source IDs.
16. Typing `/` triggers command suggestion panel for root commands and, where applicable, subcommands.
17. Slash command suggestions are filtered live and rendered with command-specific visual styling (accent pill + blur/glow).
18. `Enter` on partial slash command/subcommand input autocompletes to selected (or first) candidate.
19. If no slash candidate exists, command panel is hidden and `Enter` falls back to normal query submission.

---

## 11. Verification

Added/updated tests:

- `test/ui/pathMention.test.ts`
- `test/ui/slashCommands.test.ts`
- `test/plugin/ExplicitSourceSelectionService.test.ts`
- `test/plugin/explicitSelectionMerge.test.ts`
- `test/storage/PluginDataStore.test.ts` (explicit selection normalization)
- `test/plugin/NotebookLMPlugin.sources.test.ts` (non-text extension uploads as `source_type=file`)
- `test/plugin/historySourceIds.test.ts` (deselected source ID exclusion from carry-over)
- existing source preparation + integration tests remain green.
