# BM25 + NotebookLM Pipeline Requirements Traceability (v0.4.4)

## 1. Scope

This document defines the `v0.4.4` end-to-end behavior with explicit file/path additions (`@`, `@@`) integrated into the existing BM25 -> source preparation -> NotebookLM query pipeline.

## 2. Pipeline stages

1. User enters query text in chat composer.
2. Optional explicit selections are added via `@`/`@@` and remain visible as chips.
3. Explicit selections are queued for immediate sequential background source upload.
4. Uploading chips show circular loading UI in place of `x`; completed chips show `x`.
5. Hovering an uploading chip switches the loading UI to `x` so the source can still be removed.
6. Optional chip deselection (`x`) records excluded paths/source IDs.
7. BM25 runs on markdown notes.
8. BM25 paths and explicit paths are merged/deduplicated with deselected paths removed.
9. Explicit paths reuse/wait for in-flight background upload state; BM25-only paths are uploaded in query stage.
10. Current query source IDs are merged with bounded history source IDs after excluded source IDs are removed.
11. NotebookLM query executes with merged `source_ids`.
12. Conversation/query metadata is persisted.

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
| Path chip shows last folder name and descendant count `(N)` | `src/ui/ChatView.ts` chip label formatting |
| Truncated chip text can be inspected via hover tooltip with full source text | `src/ui/ChatView.ts` (`title`/`aria-label` on chip button) |
| Each selected item removable via `x` | `src/ui/ChatView.ts` chip remove button |
| Explicit chips remain visible after send in the same tab | `src/ui/ChatView.ts` (`sendMessage` no longer clears `composerSelections`) |
| Explicit selections start immediate sequential source upload before query submit | `src/ui/ChatView.ts` (`selectMentionCandidate`) + `NotebookLMPlugin.enqueueExplicitSourceUploads` |
| Query upload stage reuses/synchronizes explicit pre-upload progress (`2/5`-style mid-flight continuity) | `NotebookLMPlugin.waitForExplicitUploads` + `NotebookLMPlugin.handleUserQuery` |
| Uploading chips show circular loading UI and completed chips show `x` | `src/ui/ChatView.ts` (`renderComposerSelectionRemoveControl`) + `styles.css` |
| Hovering an uploading chip displays `x` (removal remains available during upload) | `styles.css` (`.nlm-chat-composer-selection-uploading` hover/focus rules) |
| Multi-file chip loading UI shows upload completion percent in center | `src/plugin/NotebookLMPlugin.ts` (`getComposerSelectionUploadStatus`) + `src/ui/ChatView.ts` + `styles.css` |
| Removing an uploading path chip cancels remaining queued files for that path while letting current file finish | `src/ui/ChatView.ts` (`removeComposerSelection`) + `NotebookLMPlugin.cancelExplicitSourceUploads` |
| Re-adding an interrupted path resumes progress from already prepared files | `NotebookLMPlugin.getComposerSelectionUploadStatus` + existing source registry lookup (`getPreparedSourceIdForPath`) |
| During in-flight query processing, composer input and selection controls remain interactive | `src/ui/ChatView.ts` (`setBusy`, `handleComposerInputChanged`, `renderMentionPanel`, search toggle rendering) |
| Only `Send`, `New`, and `History` are disabled while busy | `src/ui/ChatView.ts` (`setBusy`) |
| Deselecting chip excludes selected descendants from subsequent source selection scope | `src/ui/ChatView.ts` (`excludeDeselectedSelection`) + `NotebookLMPlugin.handleUserQuery` (`excludedPaths`) |
| Deselecting chip excludes resolved source IDs from final query `source_ids` (including history carry-over) | `src/ui/ChatView.ts` (`excludedSourceIds`) + `src/plugin/historySourceIds.ts` + `NotebookLMPlugin.handleUserQuery` |
| Clicking selected file opens note | `src/plugin/NotebookLMPlugin.ts` (`openComposerSelectionInNewTab`) |
| Clicking selected path opens folder note only if exists (`.md`, `.canvas`, `.base`) | `ExplicitSourceSelectionService.resolveFolderNotePath` + `NotebookLMPlugin.openComposerSelectionInNewTab` |
| Explicit selections are added in addition to BM25 selections | `src/plugin/explicitSelectionMerge.ts` + `NotebookLMPlugin.handleUserQuery` |
| Explicitly selected paths are filtered by allowed upload extensions before source preparation | `src/plugin/sourceUploadPolicy.ts` + `NotebookLMPlugin.handleUserQuery` |
| Disallowed selected file types are ignored with a notice showing ignored count and extensions | `NotebookLMPlugin.handleUserQuery` (`Notice: Ignored N files due to unallowed extensions ...`) |
| Upload method is selected by extension (`source_type=text` vs `source_type=file`) | `src/plugin/sourceUploadPolicy.ts` + `src/plugin/SourcePreparationService.ts` |
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
- File uploads resolve vault-relative paths to full local paths before MCP file upload.

## 6. Validation matrix

Automated:

- `test/ui/pathMention.test.ts`
- `test/plugin/ExplicitSourceSelectionService.test.ts`
- `test/plugin/explicitSelectionMerge.test.ts`
- `test/plugin/historySourceIds.test.ts` (excluded source IDs removed from carry-over)
- `test/plugin/NotebookLMPlugin.sources.test.ts` (file upload args for non-text extensions)
- `test/storage/PluginDataStore.test.ts` (explicit metadata normalization)
- existing source-preparation and integration tests (`test/plugin/*`, `test/integration/PipelineSmoke.test.ts`)

Build/type checks:

- `npm run build`

## 7. Out of scope for v0.4.4

- Slash command execution runtime (command action dispatch)
- Multi-select from a single mention search session
- MOC-tag based automatic path expansion policies
