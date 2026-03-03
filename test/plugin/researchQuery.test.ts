import assert from "node:assert/strict";
import test from "node:test";
import { buildResearchTrackingQuery } from "../../src/plugin/researchQuery";

test("buildResearchTrackingQuery appends run token suffix", () => {
	const result = buildResearchTrackingQuery("deep research query", "abc123");
	assert.equal(result, "deep research query [run-abc123]");
});

test("buildResearchTrackingQuery preserves existing run suffix", () => {
	const result = buildResearchTrackingQuery("deep research query [run-existing]");
	assert.equal(result, "deep research query [run-existing]");
});

test("buildResearchTrackingQuery trims input before suffix append", () => {
	const result = buildResearchTrackingQuery("  deep research query  ", "abc123");
	assert.equal(result, "deep research query [run-abc123]");
});

test("buildResearchTrackingQuery sanitizes provided run token", () => {
	const result = buildResearchTrackingQuery("deep research query", "A B*C@1");
	assert.equal(result, "deep research query [run-abc1]");
});
