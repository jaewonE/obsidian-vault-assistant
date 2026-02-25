# BM25 + NotebookLM Algorithms and Implementation (v0.3.2)

## 1. Purpose

This document specifies the production algorithms used in `v0.3.2` for:

1. BM25 indexing and retrieval over markdown notes.
2. Incremental index synchronization and persistence.
3. Source upload/reuse/replace/eviction for NotebookLM.
4. Source ID alias continuity across updates and restarts.
5. Conversation source carry-over and bounded context reuse.

The goal is to provide implementation-level traceability from behavior to code.

---

## 2. Runtime architecture

Main components:

- Search:
  - `src/search/BM25.ts`
  - `src/search/tokenization.ts`
  - `src/search/markdownFields.ts`
- Source sync:
  - `src/plugin/SourcePreparationService.ts`
- Orchestration:
  - `src/plugin/NotebookLMPlugin.ts`
  - `src/plugin/historySourceIds.ts`
- Persistence/state:
  - `src/storage/PluginDataStore.ts`
- MCP transport/retry:
  - `src/mcp/NotebookLMMcpClient.ts`

---

## 3. BM25 retrieval algorithm

## 3.1 Tokenization and normalization

Implementation: `src/search/tokenization.ts`

Rules:

1. Normalize text with `NFKC` and lowercase.
2. Extract base tokens with `/[\p{L}\p{N}]+/gu`.
3. Keep tokens with length in `[1, 80]`.
4. Generate adjacent ASCII compound tokens (`heap` + `sort` -> `heapsort`).
5. Generate CJK/Hangul bigrams for mixed-language matching.
6. Path tokenization removes `.md` and splits path separators.

Result:

- Better multilingual matching (English/Korean/Japanese).
- Better query matching for split/merged words and formula text.

## 3.2 Field-weighted document representation

Implementation: `src/search/BM25.ts`

For each markdown file:

- Body tokens weight: `1.0`
- Heading tokens weight: `2.5`
- Path tokens weight: `4.0`

Weighted term frequency map:

`tf_w(t, d) = tf_body + 2.5 * tf_heading + 4.0 * tf_path`

Weighted document length:

`|d|_w = |body| + 2.5 * |heading| + 4.0 * |path|`

## 3.3 Scoring and candidate selection

Implementation: `src/search/BM25.ts`

For query terms:

1. Compute term frequencies in query.
2. Use BM25 with parameters `k1` and `b`.
3. Rank non-zero score docs by:
   - score desc
   - matched term count desc
   - path asc (stable tie-break)

Selection rule:

1. `topResults = ranked.slice(0, topN)`
2. `threshold = topScore * cutoffRatio`
3. `selected = topResults where score >= threshold`
4. If `selected.length < minK`, fallback to top `minK` from `topResults`

---

## 4. Incremental index synchronization algorithm

Implementation: `src/search/BM25.ts`

## 4.1 Dirty model

BM25 supports path-level dirty operations:

- `markPathModified(path)`
- `markPathDeleted(path)`
- `markFullRescanNeeded()`
- `markDirty()` as compatibility alias to full rescan.

## 4.2 Sync behavior on query

When `search()` runs and index is dirty:

1. Load markdown file list from vault.
2. Hydrate from cached index when index is empty and cache exists.
3. Choose sync mode:
   - Full rescan if explicitly requested or periodic safeguard threshold reached.
   - Path-level incremental otherwise.
4. Full rescan:
   - Remove missing indexed docs.
   - Upsert new/changed docs (using `mtime`/`size`).
5. Path-level incremental:
   - Remove pending deleted paths.
   - Reindex pending modified paths.
6. Recompute average weighted document length.
7. Clear dirty state and pending path sets.

## 4.3 Periodic consistency safeguard

To avoid long-term drift from event ordering edge cases, BM25 triggers periodic full rescans after a bounded number of dirty incremental sync cycles.

---

## 5. Source preparation and synchronization algorithm

Implementation: `src/plugin/SourcePreparationService.ts`

Entry:

`ensureSourcesForPaths({ notebookId, paths, evictions, protectedCapacity, onProgress }, deps)`

For each selected path:

1. Read markdown content.
2. Compute content hash.
3. Load existing source mapping and resolve alias chain.
4. Execute one branch.

## 5.1 Branch A: Reuse

Conditions:

- Existing mapping present.
- Resolved source ID exists remotely and not stale.
- Stored hash equals current hash.

Actions:

- Reuse source ID.
- Canonicalize stored source ID if alias-resolved.

## 5.2 Branch B: Replace changed content

Conditions:

- Existing reusable source found.
- Hash mismatch.

Actions:

1. Upload new source first (`source_add`).
2. Update registry and alias mapping (`old -> new`).
3. Delete previous source best-effort (`source_delete`), without breaking success path.

This add-first sequence prevents temporary source loss when delete succeeds but add fails.

## 5.3 Branch C: Rename/move reuse by hash

Conditions:

- Same hash exists in registry.
- Candidate old path no longer exists locally.
- Candidate source ID still exists remotely.

Actions:

- Rebind new path to existing source ID.
- Avoid re-upload.

## 5.4 Branch D: New upload

Conditions:

- No reusable or rename candidate.

Actions:

1. Enforce capacity by eviction loop.
2. Add new source.
3. Upsert path/source mapping.
4. Register alias if replacing prior local mapping.

## 5.5 Usage marking

Only paths that actually produced a `sourceId` are marked used for queue promotion and eviction policy.

---

## 6. Capacity and eviction algorithm

Implementation: `src/plugin/SourcePreparationService.ts`

Key policy:

- Capacity is enforced against `remoteSourceIds.size` (actual known remote occupancy), not only local active registry count.

Eviction loop:

1. While remote size >= target capacity:
   - Request managed eviction candidate path from store queue.
2. If no candidate is available:
   - Throw controlled error: capacity reached without managed candidate.
3. Delete candidate remote source (strict mode, not best-effort).
4. Remove local mapping.
5. Append eviction record.

---

## 7. Alias-chain and canonicalization algorithm

Implementation: `src/storage/PluginDataStore.ts`

## 7.1 Alias resolution

`resolveSourceId(sourceId)` follows transitive alias links until fixed point, cycle-safe with a `seen` set.

## 7.2 Alias registration

`registerSourceAlias(previous, current)`:

1. Resolves current ID first.
2. Stores direct alias `previous -> resolvedCurrent`.
3. Rewrites aliases that pointed to `previous` to point to `resolvedCurrent`.

## 7.3 Reconciliation canonicalization

During remote reconciliation:

1. Resolve each entry's source ID before remote membership check.
2. If resolved ID exists remotely:
   - Mark active.
   - Rewrite stored source ID to canonical resolved ID.
3. If not present remotely:
   - Mark stale.

This prevents false stale-marking when entry IDs are historical aliases.

---

## 8. Conversation source carry-over algorithm

Implementation:

- `src/plugin/historySourceIds.ts`
- `src/plugin/NotebookLMPlugin.ts`

Rules:

1. Walk query metadata from newest to oldest.
2. Resolve each source ID via alias chain.
3. Keep only currently remote-valid IDs.
4. Deduplicate with first-seen precedence (newest first).
5. Stop at cap (`40` source IDs).

This bounds growth and keeps context recent.

---

## 9. Persistence and compaction algorithm

Implementation: `src/storage/PluginDataStore.ts`

Persisted state includes:

- Settings
- Source registry + aliases + queues
- BM25 cached index
- Conversation history + query metadata

Compaction rules:

1. Keep newest bounded conversation records.
2. Bound message count per conversation.
3. Bound query metadata count per conversation.
4. Prune alias entries not reachable from active/history-referenced IDs.
5. Keep alias map within hard upper bound to avoid pathological growth.

---

## 10. MCP retry policy algorithm

Implementation: `src/mcp/NotebookLMMcpClient.ts`

`callTool(name, args, opts)` behavior:

1. Execute once.
2. On failure, retry only if all are true:
   - connection issue detected,
   - `opts.idempotent === true`,
   - `opts.retryOnConnectionIssue !== false`.
3. Mutating calls remain non-retried by default to avoid duplicate side effects.

Used in plugin:

- Read-only calls (`server_info`, `notebook_get`) pass `idempotent: true`.
- Mutating calls (`source_add`, `source_delete`, `notebook_create`, `notebook_query`) do not request idempotent retries.

---

## 11. Vault event mapping

Implementation: `src/plugin/NotebookLMPlugin.ts`

- `modify(md)` -> `bm25.markPathModified(path)`
- `create(md)` -> `bm25.markPathModified(path)`
- `delete(md)` -> `bm25.markPathDeleted(path)`
- `rename(old, new)`:
  - old `.md` -> mark old deleted
  - new `.md` -> mark new modified
  - old `.md` to non-`.md` -> remove source registry mapping
  - old `.md` to new `.md` -> rename source registry mapping

---

## 12. Deterministic validation coverage

Primary test coverage:

- Search/tokenization/incremental sync:
  - `test/search/BM25.test.ts`
  - `test/search/tokenization.test.ts`
- Store, aliases, compaction:
  - `test/storage/PluginDataStore.test.ts`
- Source lifecycle branches:
  - `test/plugin/NotebookLMPlugin.sources.test.ts`
- MCP retry policy:
  - `test/mcp/NotebookLMMcpClient.test.ts`
- Conversation source carry-over cap:
  - `test/plugin/historySourceIds.test.ts`
- Pipeline smoke:
  - `test/integration/PipelineSmoke.test.ts`

---

## 13. Practical constraints and non-goals

1. This pipeline targets markdown files only.
2. Hash algorithm remains lightweight by design for current scope.
3. No behavioral change to user-facing workflow; hardening focuses on consistency and reliability.

