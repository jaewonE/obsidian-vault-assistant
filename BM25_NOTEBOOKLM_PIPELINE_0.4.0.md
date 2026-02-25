# BM25 + NotebookLM Pipeline Requirements Traceability (v0.4.0)

## 1. Scope

This document defines the `v0.4.0` end-to-end behavior with explicit file/path additions (`@`, `@@`) integrated into the existing BM25 -> source preparation -> NotebookLM query pipeline.

## 2. Pipeline stages

1. User enters query text in chat composer.
2. Optional explicit selections are added via `@`/`@@`.
3. BM25 runs on markdown notes.
4. BM25 paths and explicit paths are merged and deduplicated.
5. Merged paths are prepared/uploaded as NotebookLM sources.
6. Current query source IDs are merged with bounded history source IDs.
7. NotebookLM query executes with merged `source_ids`.
8. Conversation/query metadata is persisted.

## 3. Requirement-to-implementation mapping

| Requirement | Implementation |
| --- | --- |
| Typing `@` triggers Add File/Path search for markdown files only | `src/ui/pathMention.ts` (`mode=markdown`) + `src/plugin/ExplicitSourceSelectionService.ts` (`vault.getMarkdownFiles`) |
| Typing `@@` triggers Add File/Path search for all files | `src/ui/pathMention.ts` (`mode=all`) + `src/plugin/ExplicitSourceSelectionService.ts` (`vault.getFiles`) |
| Live search updates as user input changes | `src/ui/ChatView.ts` (`handleComposerInputChanged`) |
| Empty search state message when no match | `src/ui/ChatView.ts` (`No more files found.` row) |
| Search list shows icon, filename (with extension), muted path with overflow handling | `src/ui/ChatView.ts` + `styles.css` mention item styles |
| Path result uses folder icon + path | `src/ui/ChatView.ts` (`kind=path`) |
| Only one file/path can be selected per search token | `src/ui/pathMention.ts` token replacement + single candidate selection in `ChatView` |
| Path selection includes all descendant files | `src/plugin/ExplicitSourceSelectionService.ts` (`getDescendantPaths`) |
| Path > 15 descendants shows time-cost warning | `PATH_SELECTION_WARNING_SUBFILE_THRESHOLD = 15` in `ExplicitSourceSelectionService` + `Notice` in `ChatView` |
| Path > 200 descendants is rejected with notification | `PATH_SELECTION_REJECT_SUBFILE_THRESHOLD = 200` in `ExplicitSourceSelectionService` + `Notice` in `ChatView` |
| Selected items visible above query input | `src/ui/ChatView.ts` composer chips |
| Path chip shows descendant count `(N)` | `src/ui/ChatView.ts` chip label formatting |
| Each selected item removable via `x` | `src/ui/ChatView.ts` chip remove button |
| Clicking selected file opens note | `src/plugin/NotebookLMPlugin.ts` (`openComposerSelectionInNewTab`) |
| Clicking selected path opens folder note only if exists (`.md`, `.canvas`, `.base`) | `ExplicitSourceSelectionService.resolveFolderNotePath` + `NotebookLMPlugin.openComposerSelectionInNewTab` |
| Explicit selections are added in addition to BM25 selections | `src/plugin/explicitSelectionMerge.ts` + `NotebookLMPlugin.handleUserQuery` |
| Non-overlap BM25 15 + explicit 4 produces 19 prepared files | dedupe-union merge behavior in `mergeSelectionPaths` |

## 4. Persistence/metadata requirements

`ConversationQueryMetadata` persists:

- BM25 selection metadata (existing behavior)
- `explicitSelections` (new in v0.4.0):
  - `kind`, `mode`, `path`, `resolvedPaths`, `subfileCount`
- merged `selectedSourceIds`
- source summary with optional `explicitSelectedCount`

Normalization and backward compatibility:

- implemented in `src/storage/PluginDataStore.ts`
- old `v0.3.x` records without explicit fields remain valid.

## 5. Non-functional requirements

- Uses Obsidian internal vault APIs for search/resolve.
- No additional external network dependency for explicit search logic.
- Existing source capacity/eviction policy is preserved.
- Existing retry/idempotency policy is preserved.

## 6. Validation matrix

Automated:

- `test/ui/pathMention.test.ts`
- `test/plugin/ExplicitSourceSelectionService.test.ts`
- `test/plugin/explicitSelectionMerge.test.ts`
- `test/storage/PluginDataStore.test.ts` (explicit metadata normalization)
- existing source-preparation and integration tests (`test/plugin/*`, `test/integration/PipelineSmoke.test.ts`)

Build/type checks:

- `npm run build`

## 7. Out of scope for v0.4.0

- Slash command execution runtime (command action dispatch)
- Multi-select from a single mention search session
- MOC-tag based automatic path expansion policies
