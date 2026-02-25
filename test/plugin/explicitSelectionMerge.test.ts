import assert from "node:assert/strict";
import test from "node:test";
import { collectExplicitSelectionPaths, mergeSelectionPaths } from "../../src/plugin/explicitSelectionMerge";

test("collectExplicitSelectionPaths flattens and deduplicates selected file paths", () => {
	const paths = collectExplicitSelectionPaths([
		{
			id: "1",
			kind: "file",
			mode: "markdown",
			path: "docs/a.md",
			label: "a.md",
			filePaths: ["docs/a.md"],
			subfileCount: 1,
		},
		{
			id: "2",
			kind: "path",
			mode: "markdown",
			path: "docs/topic",
			label: "docs/topic",
			filePaths: ["docs/topic/t1.md", "docs/topic/t2.md", "docs/a.md"],
			subfileCount: 3,
		},
	]);

	assert.deepEqual(paths.sort(), ["docs/a.md", "docs/topic/t1.md", "docs/topic/t2.md"]);
});

test("mergeSelectionPaths combines BM25 and explicit paths without duplication", () => {
	const merged = mergeSelectionPaths(
		["bm25/a.md", "shared.md", "bm25/b.md"],
		["shared.md", "explicit/x.md", "explicit/y.md"],
	);

	assert.deepEqual(merged.sort(), [
		"bm25/a.md",
		"bm25/b.md",
		"explicit/x.md",
		"explicit/y.md",
		"shared.md",
	]);
});
