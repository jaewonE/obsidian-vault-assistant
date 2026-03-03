import assert from "node:assert/strict";
import test from "node:test";
import { getResearchImportIndices, trackResearchStatus } from "../../src/plugin/researchTracking";

test("getResearchImportIndices returns all indices for fast mode", () => {
	const indices = getResearchImportIndices("fast", [
		{ index: 1, title: "A", url: "https://a.example.com" },
		{ index: 2, title: "B", url: "https://b.example.com" },
	]);
	assert.deepEqual(indices, [1, 2]);
});

test("getResearchImportIndices filters deep mode to web sources with url", () => {
	const indices = getResearchImportIndices("deep", [
		{ index: 0, title: "Deep report", result_type_name: "deep_report", url: "" },
		{ index: 1, title: "Web A", result_type_name: "web", url: "https://a.example.com" },
		{ index: 2, title: "Web B", result_type_name: "web", url: "" },
		{ index: 3, title: "Web C", result_type_name: "web", url: "https://c.example.com" },
	]);
	assert.deepEqual(indices, [1, 3]);
});

test("trackResearchStatus updates task id when deep status response changes it", async () => {
	const responses = [
		{ status: "in_progress", task_id: "task-updated" },
		{ status: "completed", task_id: "task-updated", sources_found: 3, sources: [] },
	];
	let callIndex = 0;
	const result = await trackResearchStatus({
		mode: "deep",
		notebookId: "nb-1",
		query: "deep query",
		startTaskId: "task-start",
		pollStatus: async () => responses[callIndex++] ?? responses[responses.length - 1],
		delay: async () => {},
		jitterMs: () => 0,
		maxWaitMs: 60_000,
	});

	assert.equal(result.status, "completed");
	assert.equal(result.taskId, "task-updated");
	assert.equal(result.taskIdChanged, true);
	assert.equal(result.pollCount, 2);
});

test("trackResearchStatus stops after repeated transient errors", async () => {
	const result = await trackResearchStatus({
		mode: "fast",
		notebookId: "nb-1",
		query: "fast query",
		startTaskId: "task-start",
		pollStatus: async () => ({ status: "error", task_id: "task-start" }),
		delay: async () => {},
		jitterMs: () => 0,
		maxConsecutiveErrors: 3,
		maxWaitMs: 60_000,
	});

	assert.equal(result.status, "error");
	assert.equal(result.pollCount, 3);
});
