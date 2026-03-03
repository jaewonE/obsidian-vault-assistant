# BM25 + NotebookLM Pipeline Requirements Traceability (v0.6.0)

## 1. Scope

This document defines the `v0.6.0` end-to-end behavior for:

1. Existing BM25 + explicit `@`/`@@` source selection.
2. Slash command autocomplete (`/source`, `/create`, `/setting`, `/research`).
3. Executable `/research` command flows (`link`, `links`, `research-fast`, `research-deep`).
4. NotebookLM-only research source lifecycle (metadata-only local persistence, no raw source body persistence).
5. Query-time source merge including active research source IDs.

## 2. Pipeline stages

1. User edits composer text.
2. Mention parser resolves active token type: `@`, `@@`, `/`, or none.
3. Slash suggestions are shown and autocompleted as needed.
4. If send input is `/research ...`, normal chat send is skipped (no user/assistant history message append).
5. `/research` input is parsed into one of:
   - `link`
   - `links`
   - `research-fast`
   - `research-deep`
   - `invalid`
6. Background research operation is created and shown as a non-local composer chip.
7. Notebook readiness is ensured (`notebook_id` + source reconciliation).
8. Operation execution:
   - `link`: `source_add(wait=true)` for one URL using `source_type=url` (applies to both normal web and YouTube URLs).
   - `links`: sequential `source_add(wait=true)` over all URLs with progress `%`.
   - `research-fast` / `research-deep`: `research_start`, then polling `research_status`.
9. Research polling always sends both stable `query` and mutable `task_id`; if status response returns a new `task_id`, it is promoted to current tracker task ID.
10. Poll terminal states:
   - `completed`: continue to import stage.
   - `no_research`: mark chip non-usable.
   - repeated/transient failure or timeout: mark chip error.
11. Import stage (`research-fast`/`research-deep`):
   - fast imports all returned source indices.
   - deep imports only `web` entries with non-empty URLs.
12. Imported sources are registered as active NotebookLM source IDs; research metadata is persisted locally (source IDs, title/url/query/report/task metadata only).
13. Chip remove (`x`) during loading dismisses UI/query inclusion only; operation continues in background and still persists final metadata.
14. Normal (non-slash) query send path runs BM25 + explicit source merge and uploads/reuses local sources as before.
15. Query source merge includes active, non-dismissed, ready research source IDs (`manualSourceIds`) in final `source_ids`.
16. `no_research`/`error` research chips are excluded from query source scope and rendered with light-red background.
17. Query metadata and research metadata are saved with compaction/normalization safeguards.

## 3. Requirement-to-implementation mapping

| Requirement | Implementation |
| --- | --- |
| `/research` root command and subcommands are suggested in slash autocomplete | `src/ui/slashCommands.ts`, `test/ui/slashCommands.test.ts`, `test/ui/pathMention.test.ts` |
| `/research` parser classifies `link`, `links`, `research-fast`, `research-deep`, `invalid` | `src/ui/researchCommands.ts`, `test/ui/researchCommands.test.ts` |
| `/research <single-http-url>` is treated as direct link source add | `ChatView.sendMessage` -> `NotebookLMPlugin.executeResearchCommand` -> `runSingleLinkResearchOperation` |
| `/research <non-url>` is treated as fast research query | `src/ui/researchCommands.ts` (`research-fast`) + `NotebookLMPlugin.runFastOrDeepResearchOperation(mode=fast)` |
| `/research links <url...>` adds links sequentially | `NotebookLMPlugin.runMultiLinkResearchOperation` |
| URL add uses `source_type=url` for both normal links and YouTube links | `NotebookLMPlugin.addLinkSourceToNotebook` |
| Research runs use a unique tracking query token (`[run-...]`) instead of `force=true` start retry semantics | `NotebookLMPlugin.runFastOrDeepResearchOperation`, `src/plugin/researchQuery.ts` |
| Deep tracking supports mutable `task_id` across status polls | `src/plugin/researchTracking.ts` (`trackResearchStatus`) + `NotebookLMPlugin.runFastOrDeepResearchOperation` |
| Research polling terminal states are handled (`in_progress`, `completed`, `no_research`, `error`) | `src/plugin/researchTracking.ts` + `NotebookLMPlugin.runFastOrDeepResearchOperation` |
| Fast polling cadence is 1s first then 5s | `researchTracking.baseIntervalMs(mode=fast)` |
| Deep polling cadence is 2s first then 20s/10s/5s with error backoff | `researchTracking.baseIntervalMs(mode=deep)` + `withBackoff(...)` |
| Fast import policy imports all indices | `researchTracking.getResearchImportIndices(mode=fast)` |
| Deep import policy imports only web sources with non-empty URL | `researchTracking.getResearchImportIndices(mode=deep)` |
| `/research` execution does not append chat history messages | `src/ui/ChatView.ts` (`sendMessage` early-return branch for parsed research command) |
| Research operations run asynchronously and do not block normal composer usage | `NotebookLMPlugin.executeResearchCommand` (fire-and-forget `runResearchOperation`) + `ChatView` |
| Research chips use dedicated non-local icons (url-link, youtube-link, links, fast, deep) | `ChatView.getResearchOperationIconName` |
| Chip label policy uses title/query and counts; long text is ellipsized | `ChatView.getResearchChipDisplayText` + shared chip CSS (`.nlm-chat-composer-selection-label`) |
| Loading UI uses circular progress; `links` shows percentage in spinner center | `ChatView.getResearchUploadStatus` + `renderComposerSelectionRemoveControl` + `styles.css` |
| Hover `x` is shown on loading chips; clicking `x` dismisses chip only (no cancel) | `ChatView.renderResearchComposerSelectionChip` + `NotebookLMPlugin.dismissResearchOperation` |
| `no_research` and `error` chips are light-red and not query-usable | `ChatView` error class + `styles.css` + `NotebookLMPlugin.getActiveResearchSourceIds` |
| Link chip click opens URL in default browser | `ChatView.handleOpenResearchOperation` / `openResearchSourceItem` (`window.open`) |
| Links / fast click opens URL-picker modal (title + muted URL text) | `src/ui/ResearchLinksModal.ts`, `ChatView.handleOpenResearchOperation`, `ChatView.openResearchSourceItem` |
| Deep click opens Markdown report modal (no file write) | `src/ui/DeepResearchReportModal.ts` (`MarkdownRenderer.render`) |
| Query pipeline merges manual research source IDs into final `source_ids` | `NotebookLMPlugin.handleUserQuery` (`manualSourceIds`) |
| Local persistence stores NotebookLM source metadata, not source body text | `src/types.ts` (`NotebookResearchRecord`) + `src/storage/PluginDataStore.ts` |
| Research source index and reconciliation are maintained in local store | `PluginDataStore.researchSourceIndex`, `upsertResearchRecord`, `reconcileResearchRecords`, `rebuildResearchSourceIndex` |

## 4. Persistence/metadata requirements

`NotebookLMPluginData` includes:

- `researchRecords: NotebookResearchRecord[]`
- `researchSourceIndex: Record<sourceId, recordId>`

`NotebookResearchRecord` stores:

- `kind`, `status`, `query`
- `links[]`
- `sourceItems[]` (`sourceId`, `title`, optional `url`, optional `sourceType`)
- optional deep `report`
- optional `error`
- `notebookId`, `startTaskId`, mutable `taskId`
- timestamps

Explicit policy:

- Source body/content is not persisted locally for `/research`.
- Persisted data is metadata used for source selection, click/open UX, and query `source_ids` merge.

Compaction/normalization:

- malformed research records are dropped during load normalization.
- research records are bounded (`MAX_RESEARCH_RECORDS`).
- research source index is rebuilt from normalized records.

## 5. Non-functional requirements

- Existing BM25/index/sync algorithm and explicit `@`/`@@` upload behavior remain unchanged.
- Existing retry/idempotency and source eviction policies for local file sources are preserved.
- Research operations are resilient to chip dismissal and continue in background to avoid partial cancellation side effects.
- UI remains interactive during both query progress and research background operations.

## 6. Validation matrix

Automated:

- `test/ui/researchCommands.test.ts`
- `test/ui/slashCommands.test.ts`
- `test/ui/pathMention.test.ts`
- `test/plugin/researchTracking.test.ts`
- `test/storage/PluginDataStore.test.ts`
- existing query/source pipeline tests (`test/plugin/*`, `test/integration/PipelineSmoke.test.ts`)

Build/type checks:

- `npm run build`
- `npm test`

Manual E2E target flow (new notebook):

- `/research https://codingtoday.tistory.com/104`
- `/research https://www.youtube.com/watch?v=qt572Ysw3sc`
- `/research links https://codingtoday.tistory.com/104 https://www.youtube.com/watch?v=qt572Ysw3sc`
- `/research 민주주의에서 자유는 어디까지 허용되어야 하는가`
- `/research deep 민주주의에서 자유는 어디까지 허용되며 혐오 또한 자유인가`

## 7. Out of scope for v0.6.0

- Automatic local download of NotebookLM research source bodies.
- Mid-flight remote cancellation API for research/background operations.
- Retrieval/import of arbitrary pre-existing NotebookLM sources not created by this plugin flow.
