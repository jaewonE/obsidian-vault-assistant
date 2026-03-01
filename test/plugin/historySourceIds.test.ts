import assert from "node:assert/strict";
import test from "node:test";
import { buildReusableSourceIds } from "../../src/plugin/historySourceIds";

test("buildReusableSourceIds uses recency, dedupe, and max cap", () => {
	const queryMetadata = [
		{ selectedSourceIds: ["a", "b"] },
		{ selectedSourceIds: ["b", "c", "d"] },
		{ selectedSourceIds: ["e", "a", "f"] },
	] as never;
	const aliases: Record<string, string> = {
		a: "a-new",
		f: "f-new",
	};
	const remoteSourceIds = new Set(["a-new", "e", "d", "c", "f-new"]);

	const result = buildReusableSourceIds({
		queryMetadata,
		resolveSourceId: (sourceId: string) => aliases[sourceId] ?? sourceId,
		remoteSourceIds,
		maxCount: 4,
	});

	assert.deepEqual(result, ["e", "a-new", "f-new", "c"]);
});

test("buildReusableSourceIds excludes deselected source ids", () => {
	const queryMetadata = [{ selectedSourceIds: ["a", "b"] }, { selectedSourceIds: ["c", "d"] }] as never;
	const remoteSourceIds = new Set(["a", "b", "c", "d"]);

	const result = buildReusableSourceIds({
		queryMetadata,
		resolveSourceId: (sourceId: string) => sourceId,
		remoteSourceIds,
		maxCount: 10,
		excludedSourceIds: new Set(["d", "b"]),
	});

	assert.deepEqual(result, ["c", "a"]);
});
