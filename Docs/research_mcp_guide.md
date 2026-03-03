# MCP Research Guide (Self-Contained)

This guide is intentionally self-contained.
Use this single file to implement and operate NotebookLM MCP research workflows with:
- `research_start`
- `research_status`
- `research_import`

No other local guide is required.

---

## 1. Purpose

This document explains how to reliably run research workflows for both `fast` and `deep` modes, including:
1. How to start research
2. How to track status safely
3. How to import results correctly
4. How to handle `deep`-mode `task_id` changes
5. How to run multiple deep jobs concurrently

---

## 2. Core Behavior You Must Know

1. In `deep` mode, the `task_id` returned by `research_start` can differ from the `task_id` later returned by `research_status`.
2. Because of this, `task_id` alone is not a stable tracking key for deep research.
3. You must track with both:
- `task_id` (mutable pointer)
- `query` (stable identifier; include a unique run token)

Recommended query pattern:
- `"Model Context Protocol best practices [run-2-a1b2c3d4]"`

### Why `task_id` Mutation Happens (Code Evidence)

This repository explicitly implements deep-task fallback behavior:
1. `research_status` accepts `query` as a fallback key for deep tracking.
2. If `task_id` does not match, core logic falls back to exact query matching.

Code references in this repository:
- `src/notebooklm_tools/mcp/tools/research.py:48-50` (`task_id`, `query` args)
- `src/notebooklm_tools/mcp/tools/research.py:60` (docstring note about task_id changes)
- `src/notebooklm_tools/core/research.py:199-209` (`target_task_id` mismatch -> `target_query` fallback)

Operational meaning:
- `deep` task_id mutation is an expected runtime behavior, not an exception case.
- Your tracker should treat `query` as the stable identity and `task_id` as mutable.

---

## 3. Function Contracts

## `research_start`

Purpose: Start a research task.

Input (typical):
```json
{
  "query": "Model Context Protocol TypeScript best practices [run-1-ab12cd34]",
  "source": "web",
  "mode": "deep",
  "notebook_id": "<notebook-id>"
}
```

Output (typical):
```json
{
  "status": "success",
  "task_id": "b00763fc-9fd6-4f1c-a39f-6cbb834f9e61",
  "notebook_id": "e0c761b6-8dca-4a4b-a498-3baf48516c66",
  "query": "Model Context Protocol TypeScript best practices [run-1-ab12cd34]",
  "source": "web",
  "mode": "deep",
  "message": "Research started. Use research_status to check progress."
}
```

## `research_status`

Purpose: Poll task progress.

Input (recommended):
```json
{
  "notebook_id": "<notebook-id>",
  "task_id": "<current-task-id>",
  "query": "<exact-query-with-run-token>",
  "compact": false
}
```

Output (in progress):
```json
{
  "status": "in_progress",
  "notebook_id": "<notebook-id>",
  "task_id": "06688eb8-7a1e-4d92-b63e-23fdab83a629",
  "sources_found": 0,
  "sources": [],
  "report": "",
  "message": null
}
```

Output (completed):
```json
{
  "status": "completed",
  "notebook_id": "<notebook-id>",
  "task_id": "06688eb8-7a1e-4d92-b63e-23fdab83a629",
  "sources_found": 52,
  "sources": [
    {
      "index": 0,
      "url": "",
      "title": "Advanced Architectural Paradigms and Technical Best Practices for MCP...",
      "result_type": 5,
      "result_type_name": "deep_report"
    }
  ],
  "report": "# ... long markdown report ...",
  "message": "Use research_import to add sources to notebook."
}
```

## `research_import`

Purpose: Import discovered sources into the notebook.

Input:
```json
{
  "notebook_id": "<notebook-id>",
  "task_id": "<latest-task-id-from-status>",
  "source_indices": [1]
}
```

Success output:
```json
{
  "status": "success",
  "notebook_id": "<notebook-id>",
  "imported_count": 1,
  "imported_sources": [
    {
      "id": "bb2f9aef-5350-46eb-81da-bc213ce7721a",
      "title": "skills/.../node_mcp_server.md at main - GitHub"
    }
  ],
  "message": "Imported 1 sources."
}
```

Failure output (common deep top-result mistake):
```json
{
  "status": "error",
  "error": "Failed to import sources — no confirmation from API."
}
```

---

## 4. Fast vs Deep: Practical Differences

| Item | fast | deep |
|---|---|---|
| Typical completion time | short | longer |
| `task_id` stability | usually stable | may change |
| `sources_found` pattern | appears quickly | can stay 0 until late |
| `report` field | often empty | usually large markdown report |
| Top source importability | usually importable web source | index 0 may be `deep_report` (not importable) |

---

## 5. Reliable Tracking Strategy (Required)

Use a Run Map per research run.

```json
{
  "run_id": "run-2-a1b2c3d4",
  "query": "... [run-2-a1b2c3d4]",
  "start_task_id": "b1fdc32f-f4ae-4aff-85c6-5813728d55a6",
  "current_task_id": "a7503a22-e7f5-4f26-9618-55e32ca08492",
  "status": "in_progress",
  "transient_error_count": 0,
  "polls": []
}
```

Rules:
1. Start each run with a unique query token.
2. Poll with both `task_id` and `query`.
3. If `response.task_id` changes, replace `current_task_id` immediately.
4. Use the latest status task id for `research_import`.

---

## 6. Concurrent Deep Research Strategy

If running multiple deep jobs concurrently:

1. Start all runs with unique query tokens.
2. Keep one run map per run.
3. Stagger `research_start` calls by `0.5-1.0s` to reduce request collisions.
4. Poll all pending runs in a loop.
5. Treat transient `status=error` (for example, timeout) as retryable up to a threshold.
6. Mark a run terminal only on:
- `completed`
- hard `error` (after retry threshold)
- `timeout`

Recommended defaults:
- Poll interval: 15-30s
- Retry threshold for transient poll errors: 6-8
- `compact=false` for deep diagnostics

Deep "successful completion" criteria (recommended):
1. `status === "completed"`
2. `sources_found > 0`
3. `report.length > 0`

Queueing/sequential tendency (how to interpret):
1. Multiple deep tasks can start in parallel.
2. Completion times may appear staircase-shaped.
3. This indicates probable internal partial queueing/serialization.
4. Plan operations as "parallel submission + variable completion order."

---

## 7. Import Selection Rules for Deep

Do not assume `sources[0]` is importable.

For deep mode, select an import candidate with:
1. `result_type_name == "web"`
2. non-empty `url`

Skip items like:
- `result_type_name == "deep_report"`
- empty `url`

---

## 8. Timeout and Stability Notes

When default timeout is short (for example 60s):
1. Avoid long single blocking calls.
2. Use repeated short polls with checkpoints.
3. Persist raw JSON after each poll round.

This prevents losing state if a process/session is interrupted.

---

## 9. Asynchronous Polling Scheduler Policy

`research_status` is polling-based, but your scheduler can be fully asynchronous (non-blocking).

- Blocking model: `sleep()` in one synchronous worker blocks that worker/thread.
- Async model: `await delay(ms)` + background polling task. Your app can keep doing other work.

### Measured Baseline Used in This Guide

From completed deep runs in prior tests, the measured deep duration average is:
- `282.99s` -> **`282s` (floored)**

This guide uses `AVG_DEEP_SEC = 282`.

### Polling Policy (Requested)

## Fast mode
- First poll: `t + 1s`
- Then fixed interval: `5s`

## Deep mode
- First poll: `t + 2s` (quick task_id mutation detection)
- Until elapsed time reaches `AVG_DEEP_SEC` (`282s`): every `20s`
- After `282s`: every `10s` for `90s`
- After that: every `5s` until terminal state

### Error/Timeout Backoff

If a poll returns `status=error`/`status=timeout` or throws timeout/network error:
1. Increase `consecutiveErrors`
2. Apply backoff to next delay:
- `nextDelay = min(baseDelay * 2^consecutiveErrors, 60s)`
3. Add jitter (recommended): `0-1s`
4. Reset `consecutiveErrors=0` after a successful poll

---

## 10. TypeScript Async Status Tracker Template

```ts
type MCPCall = (tool: string, args: Record<string, unknown>) => Promise<any>;
type ResearchMode = "fast" | "deep";
type RunStatus = "pending" | "in_progress" | "completed" | "error" | "timeout" | "no_research";

const AVG_DEEP_SEC = 282; // floored from measured test history in this guide

type ResearchRun = {
  runId: string;
  mode: ResearchMode;
  notebookId: string;
  query: string;
  startTaskId: string | null;
  currentTaskId: string | null;
  status: RunStatus;
  consecutiveErrors: number;
  maxConsecutiveErrors: number;
  startedAtMs: number;
  startedAt: string;
  finishedAt?: string;
  sourcesFound: number;
  reportLength: number;
  polls: Array<{
    timestamp: string;
    request: Record<string, unknown>;
    response: Record<string, unknown>;
  }>;
};

type TrackerOptions = {
  compact?: boolean;
  maxWaitMs?: number;
  maxConsecutiveErrors?: number;
  onUpdate?: (run: ResearchRun, response: any) => void;
};

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function jitterMs(max = 1000): number {
  return Math.floor(Math.random() * max);
}

function buildRun(
  mode: ResearchMode,
  notebookId: string,
  query: string,
  startTaskId: string | null,
  opts?: TrackerOptions,
): ResearchRun {
  return {
    runId: query.match(/\\[(.*?)\\]$/)?.[1] ?? `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    mode,
    notebookId,
    query,
    startTaskId,
    currentTaskId: startTaskId,
    status: "pending",
    consecutiveErrors: 0,
    maxConsecutiveErrors: opts?.maxConsecutiveErrors ?? 8,
    startedAtMs: Date.now(),
    startedAt: new Date().toISOString(),
    sourcesFound: 0,
    reportLength: 0,
    polls: [],
  };
}

function baseIntervalMs(mode: ResearchMode, elapsedMs: number, pollCount: number): number {
  if (mode === "fast") {
    if (pollCount === 0) return 1000; // first poll at t+1s
    return 5000;                      // fixed 5s thereafter
  }

  // deep mode
  if (pollCount === 0) return 2000; // first poll at t+2s

  const avgMs = AVG_DEEP_SEC * 1000; // 282s
  if (elapsedMs < avgMs) return 20000;                 // until average: 20s
  if (elapsedMs < avgMs + 90_000) return 10000;        // next 90s: 10s
  return 5000;                                          // then 5s
}

function withBackoff(baseMs: number, consecutiveErrors: number): number {
  if (consecutiveErrors <= 0) return baseMs;
  return Math.min(baseMs * 2 ** consecutiveErrors, 60_000);
}

async function pollOnce(callTool: MCPCall, run: ResearchRun, compact: boolean): Promise<any> {
  const request = {
    notebook_id: run.notebookId,
    task_id: run.currentTaskId,
    query: run.query,  // critical fallback key for deep task_id mutation
    compact,
  };

  const response = await callTool("research_status", request);

  run.polls.push({
    timestamp: new Date().toISOString(),
    request,
    response: response ?? {},
  });

  // deep task_id mutation handling
  if (response?.task_id && response.task_id !== run.currentTaskId) {
    run.currentTaskId = response.task_id;
  }

  return response;
}

export async function trackResearchAsync(
  callTool: MCPCall,
  mode: ResearchMode,
  notebookId: string,
  query: string,
  startTaskId: string | null,
  opts: TrackerOptions = {},
): Promise<ResearchRun> {
  const compact = opts.compact ?? false;
  const maxWaitMs = opts.maxWaitMs ?? 30 * 60 * 1000;
  const onUpdate = opts.onUpdate;

  const run = buildRun(mode, notebookId, query, startTaskId, opts);
  const deadline = run.startedAtMs + maxWaitMs;

  while (Date.now() < deadline) {
    const elapsedMs = Date.now() - run.startedAtMs;
    const baseMs = baseIntervalMs(run.mode, elapsedMs, run.polls.length);
    const sleepMs = withBackoff(baseMs, run.consecutiveErrors) + jitterMs(1000);

    // Wait first, then poll: enforces t+1/t+2 first poll behavior.
    await delay(sleepMs);

    let response: any;
    try {
      response = await pollOnce(callTool, run, compact);
    } catch {
      run.consecutiveErrors += 1;
      if (run.consecutiveErrors >= run.maxConsecutiveErrors) {
        run.status = "error";
        run.finishedAt = new Date().toISOString();
        return run;
      }
      continue;
    }

    const st = response?.status as string | undefined;
    if (st === "error" || st === "timeout") {
      run.consecutiveErrors += 1;
      if (run.consecutiveErrors >= run.maxConsecutiveErrors) {
        run.status = "error";
        run.finishedAt = new Date().toISOString();
        return run;
      }
      continue;
    }

    run.consecutiveErrors = 0;
    run.status = (st as RunStatus) ?? "in_progress";
    run.sourcesFound = Number(response?.sources_found ?? 0);
    run.reportLength = String(response?.report ?? "").length;

    onUpdate?.(run, response);

    if (run.status === "completed" || run.status === "no_research") {
      run.finishedAt = new Date().toISOString();
      return run;
    }
  }

  run.status = "timeout";
  run.finishedAt = new Date().toISOString();
  return run;
}
```

---

## 11. Async Usage Example (Fast + Concurrent Deep)

```ts
// callTool is your MCP wrapper, e.g. callTool("research_start", {...})

const notebookId = "<notebook-id>";
const base = "Model Context Protocol TypeScript best practices";

// Fast run (t+1s first poll, then 5s fixed interval)
const fastQuery = `${base} [fast-run-${crypto.randomUUID().slice(0, 8)}]`;
const fastStart = await callTool("research_start", {
  query: fastQuery,
  source: "web",
  mode: "fast",
  notebook_id: notebookId,
});
const fastRunPromise = trackResearchAsync(
  callTool,
  "fast",
  notebookId,
  fastQuery,
  fastStart?.task_id ?? null,
  {
    compact: false,
    maxWaitMs: 8 * 60 * 1000,
    maxConsecutiveErrors: 8,
  },
);

// Deep runs (t+2s first poll, then 20s -> 10s -> 5s, plus backoff on errors)
const deepRunPromises = [1, 2, 3].map(async (i) => {
  const token = crypto.randomUUID().slice(0, 8);
  const query = `${base} [deep-run-${i}-${token}]`;

  const start = await callTool("research_start", {
    query,
    source: "web",
    mode: "deep",
    notebook_id: notebookId,
  });

  return trackResearchAsync(callTool, "deep", notebookId, query, start?.task_id ?? null, {
    compact: false,
    maxWaitMs: 25 * 60 * 1000,
    maxConsecutiveErrors: 8,
  });
});

const [fastRun, ...deepRuns] = await Promise.all([
  fastRunPromise,
  ...deepRunPromises,
]);

const runs = [fastRun, ...deepRuns];

console.log(runs.map((r) => ({
  runId: r.runId,
  mode: r.mode,
  status: r.status,
  taskChanged: r.startTaskId !== r.currentTaskId,
  sourcesFound: r.sourcesFound,
  reportLength: r.reportLength,
})));
```

---

## 12. Sample Raw Dataset Fragment (Real Pattern)

```json
{
  "run_index": 2,
  "research_start": {
    "status": "success",
    "task_id": "b1fdc32f-f4ae-4aff-85c6-5813728d55a6"
  },
  "status_polls": [
    {
      "response": {
        "status": "in_progress",
        "task_id": "a7503a22-e7f5-4f26-9618-55e32ca08492",
        "sources_found": 0
      }
    },
    {
      "response": {
        "status": "completed",
        "task_id": "a7503a22-e7f5-4f26-9618-55e32ca08492",
        "sources_found": 53,
        "report": "# ..."
      }
    }
  ],
  "final": {
    "status": "completed",
    "task_id": "a7503a22-e7f5-4f26-9618-55e32ca08492"
  }
}
```

This is the expected deep pattern:
- start task id changed
- status still tracked correctly through query + task id update
- final completion confirmed with report and sources

---

## 13. Measured Results (From This Repository)

### Case A: Three deep runs started at 10-second intervals

Verification result:
```json
{
  "all_three_completed": true,
  "all_three_have_report": true,
  "all_three_have_sources": true,
  "all_three_answers_received_correctly": true
}
```

Observed task_id mutation on all three runs:
- run1: `b00763fc-... -> 06688eb8-...`
- run2: `b1fdc32f-... -> a7503a22-...`
- run3: `e80aa93f-... -> 58ea67c7-...`

### Case B: Six deep runs started concurrently (upper test bound)

Status distribution:
```json
{
  "n": 6,
  "run_count": 6,
  "status_counts": [
    { "key": "completed", "count": 6 }
  ]
}
```

Batch summary:
```json
{
  "max_successful_n_within_constraint": 6,
  "first_failed_n_within_constraint": null,
  "tested": [6],
  "conclusion": "At least 6 concurrent deep researches succeeded (constraint <=6)"
}
```

Interpretation:
1. At least 6 concurrent deep runs succeeded under the tested constraint.
2. Practical completion order remains variable; queue-like completion is still possible.

---

## 14. Recommended JSON Artifacts

For production runs, persist both files:
1. `research_runs_raw.json`
- Every raw request/response for `research_start`, `research_status`, `research_import`
2. `research_runs_summary.json`
- Per-run final status and quality indicators

Recommended summary schema:
```json
{
  "notebook_id": "....",
  "batch_size": 6,
  "all_completed": true,
  "runs": [
    {
      "run_id": "run-1-....",
      "start_task_id": "....",
      "final_task_id": "....",
      "task_id_changed": true,
      "status": "completed",
      "sources_found": 52,
      "report_length": 36899,
      "duration_sec": 303.1
    }
  ]
}
```

---

## 15. Operational Checklist

1. Unique token in every run query
2. Poll with both `task_id` and `query`
3. Update `current_task_id` when response task id changes
4. Retry transient poll errors with threshold
5. For deep import, skip `deep_report` and empty-url items
6. Persist raw JSON at every polling round
7. Decide batch size with your own SLA (latency vs throughput)

---

## 16. Final Recommendation

For deep research, treat `task_id` as mutable and `query` as the stable identity.
For concurrency, use a run map and checkpointed raw JSON logging.
This is the most reliable pattern for production-grade NotebookLM MCP research pipelines.
