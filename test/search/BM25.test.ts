import assert from "node:assert/strict";
import test from "node:test";
import { BM25 } from "../../src/search/BM25";

class SilentLogger {
	debug(): void {}
	info(): void {}
	warn(): void {}
	error(): void {}
}

interface MockFile {
	path: string;
	stat: {
		mtime: number;
		size: number;
	};
}

function createBm25(documents: Record<string, string>): BM25 {
	const files: MockFile[] = Object.entries(documents).map(([path, content]) => ({
		path,
		stat: {
			mtime: 1,
			size: content.length,
		},
	}));
	const app = {
		vault: {
			getMarkdownFiles(): MockFile[] {
				return files;
			},
			async cachedRead(file: MockFile): Promise<string> {
				return documents[file.path] ?? "";
			},
		},
	};

	return new BM25(app as never, new SilentLogger() as never);
}

async function search(
	documents: Record<string, string>,
	query: string,
): Promise<Awaited<ReturnType<BM25["search"]>>>
{
	const bm25 = createBm25(documents);
	return bm25.search(query, {
		topN: 15,
		cutoffRatio: 0.4,
		minK: 3,
		k1: 1.2,
		b: 0.75,
	});
}

test("retrieves heapsort.md for heapsort query", async () => {
	const result = await search(
		{
			"algorithms/heapsort.md": "Heapsort is an in-place comparison sorting algorithm.",
			"algorithms/quicksort.md": "Quicksort uses divide-and-conquer partitioning.",
			"notes/random.md": "A daily note without sorting details.",
		},
		"explain heapsort",
	);

	assert.ok(result.selected.some((item) => item.path === "algorithms/heapsort.md"));
	assert.equal(result.topResults[0]?.path, "algorithms/heapsort.md");
});

test("does not force arbitrary documents when there is no lexical match", async () => {
	const result = await search(
		{
			"notes/a.md": "apple banana orange",
			"notes/b.md": "graph trees shortest path",
		},
		"nonexistenttokenxyz",
	);

	assert.equal(result.queryTokens.length > 0, true);
	assert.equal(result.matchedTokens.length, 0);
	assert.equal(result.nonZeroScoreCount, 0);
	assert.equal(result.topResults.length, 0);
	assert.equal(result.selected.length, 0);
});

test("uses path boost to prioritize direct filename hits", async () => {
	const result = await search(
		{
			"algorithms/heapsort.md": "Heap sort implementation details and complexity notes.",
			"algorithms/sorting-guide.md": "Heap sort is introduced with practical examples.",
		},
		"heapsort",
	);

	assert.equal(result.topResults[0]?.path, "algorithms/heapsort.md");
});

test("matches heapsort query against 'heap sort' phrase via compound token expansion", async () => {
	const result = await search(
		{
			"algorithms/sorting-overview.md": "Heap sort is a comparison-based sorting algorithm.",
			"algorithms/merge.md": "Merge sort uses divide and conquer.",
		},
		"heapsort",
	);

	assert.equal(result.topResults[0]?.path, "algorithms/sorting-overview.md");
	assert.ok(result.matchedTokens.includes("heapsort"));
});

test("supports Korean and Japanese token matching", async () => {
	const docs = {
		"algorithms/multilingual.md": "힙정렬은 O(n log n) 성능을 갖습니다. ヒープソートは二分ヒープを使います。",
		"algorithms/other.md": "퀵정렬과 병합정렬 소개",
	};

	const koreanResult = await search(docs, "힙정렬 설명");
	assert.equal(koreanResult.topResults[0]?.path, "algorithms/multilingual.md");

	const japaneseResult = await search(docs, "ヒープソート를 설명해줘");
	assert.equal(japaneseResult.topResults[0]?.path, "algorithms/multilingual.md");
});

test("supports latex-friendly query terms", async () => {
	const result = await search(
		{
			"math/formulas.md": String.raw`# Heap proof
\[
\alpha + \beta = \gamma,\quad \sum_{i=1}^{n} i = \frac{n(n+1)}{2}
\]`,
			"math/other.md": "basic arithmetic notes",
		},
		"alpha beta gamma sum",
	);

	assert.equal(result.topResults[0]?.path, "math/formulas.md");
});

test("uses heading boost to rank heading hits above plain body mentions", async () => {
	const result = await search(
		{
			"algorithms/heading-heavy.md": "# Heapsort\nOverview only.",
			"algorithms/body-only.md": "heapsort",
		},
		"heapsort",
	);

	assert.equal(result.topResults[0]?.path, "algorithms/heading-heavy.md");
});

test("returns empty when query has no indexable text", async () => {
	const result = await search(
		{
			"notes/a.md": "heapsort",
		},
		"!!! ... ---",
	);

	assert.equal(result.queryTokens.length, 0);
	assert.equal(result.topResults.length, 0);
	assert.equal(result.selected.length, 0);
});

test("can hydrate cached index without re-reading unchanged files", async () => {
	const state = {
		"algorithms/heapsort.md": { content: "heapsort algorithm", mtime: 10 },
		"algorithms/quicksort.md": { content: "quicksort algorithm", mtime: 10 },
	};
	let readCount = 0;

	const files: MockFile[] = Object.entries(state).map(([path, file]) => ({
		path,
		stat: {
			mtime: file.mtime,
			size: file.content.length,
		},
	}));

	const app = {
		vault: {
			getMarkdownFiles(): MockFile[] {
				return files;
			},
			async cachedRead(file: MockFile): Promise<string> {
				readCount += 1;
				return state[file.path as keyof typeof state].content;
			},
		},
	};

	const first = new BM25(app as never, new SilentLogger() as never);
	await first.search("heapsort", {
		topN: 15,
		cutoffRatio: 0.4,
		minK: 3,
		k1: 1.2,
		b: 0.75,
	});
	assert.equal(readCount, 2);

	const cachedIndex = first.exportCachedIndex();
	readCount = 0;

	const second = new BM25(app as never, new SilentLogger() as never);
	second.loadCachedIndex(cachedIndex);
	await second.search("heapsort", {
		topN: 15,
		cutoffRatio: 0.4,
		minK: 3,
		k1: 1.2,
		b: 0.75,
	});
	assert.equal(readCount, 0);
});

test("updates only modified files when index is dirty", async () => {
	const state = {
		"algorithms/heapsort.md": { content: "heapsort algorithm", mtime: 10 },
		"algorithms/quicksort.md": { content: "quicksort algorithm", mtime: 10 },
	};
	let readCount = 0;

	const files: MockFile[] = Object.entries(state).map(([path, file]) => ({
		path,
		stat: {
			mtime: file.mtime,
			size: file.content.length,
		},
	}));

	const app = {
		vault: {
			getMarkdownFiles(): MockFile[] {
				return files;
			},
			async cachedRead(file: MockFile): Promise<string> {
				readCount += 1;
				return state[file.path as keyof typeof state].content;
			},
		},
	};

	const bm25 = new BM25(app as never, new SilentLogger() as never);
	await bm25.search("heapsort", {
		topN: 15,
		cutoffRatio: 0.4,
		minK: 3,
		k1: 1.2,
		b: 0.75,
	});
	readCount = 0;

	state["algorithms/heapsort.md"] = {
		content: "updated heapsort explanation",
		mtime: 11,
	};
	files[0].stat = {
		mtime: 11,
		size: state["algorithms/heapsort.md"].content.length,
	};
	bm25.markDirty();

	await bm25.search("updated heapsort", {
		topN: 15,
		cutoffRatio: 0.4,
		minK: 3,
		k1: 1.2,
		b: 0.75,
	});
	assert.equal(readCount, 1);
});

test("handles path-level deleted files without re-reading unchanged files", async () => {
	const state: Record<string, { content: string; mtime: number }> = {
		"notes/a.md": { content: "alpha heapsort", mtime: 10 },
		"notes/b.md": { content: "beta quicksort", mtime: 10 },
	};
	let readCount = 0;

	const files: MockFile[] = Object.entries(state).map(([path, file]) => ({
		path,
		stat: {
			mtime: file.mtime,
			size: file.content.length,
		},
	}));

	const app = {
		vault: {
			getMarkdownFiles(): MockFile[] {
				return files;
			},
			async cachedRead(file: MockFile): Promise<string> {
				readCount += 1;
				return state[file.path]?.content ?? "";
			},
		},
	};

	const bm25 = new BM25(app as never, new SilentLogger() as never);
	await bm25.search("heapsort", {
		topN: 15,
		cutoffRatio: 0.4,
		minK: 3,
		k1: 1.2,
		b: 0.75,
	});
	readCount = 0;

	delete state["notes/a.md"];
	files.splice(
		files.findIndex((file) => file.path === "notes/a.md"),
		1,
	);
	bm25.markPathDeleted("notes/a.md");

	const result = await bm25.search("heapsort", {
		topN: 15,
		cutoffRatio: 0.4,
		minK: 3,
		k1: 1.2,
		b: 0.75,
	});

	assert.equal(readCount, 0);
	assert.equal(result.topResults.some((item) => item.path === "notes/a.md"), false);
});

test("handles path-level rename as delete+modify", async () => {
	const state: Record<string, { content: string; mtime: number }> = {
		"docs/old.md": { content: "rename token", mtime: 1 },
	};
	let readCount = 0;

	const files: MockFile[] = Object.entries(state).map(([path, file]) => ({
		path,
		stat: {
			mtime: file.mtime,
			size: file.content.length,
		},
	}));

	const app = {
		vault: {
			getMarkdownFiles(): MockFile[] {
				return files;
			},
			async cachedRead(file: MockFile): Promise<string> {
				readCount += 1;
				return state[file.path]?.content ?? "";
			},
		},
	};

	const bm25 = new BM25(app as never, new SilentLogger() as never);
	await bm25.search("rename", {
		topN: 15,
		cutoffRatio: 0.4,
		minK: 3,
		k1: 1.2,
		b: 0.75,
	});
	readCount = 0;

	state["docs/new.md"] = { content: "rename token", mtime: 2 };
	delete state["docs/old.md"];
	files.splice(
		files.findIndex((file) => file.path === "docs/old.md"),
		1,
		{
			path: "docs/new.md",
			stat: {
				mtime: 2,
				size: state["docs/new.md"]?.content.length ?? 0,
			},
		},
	);

	bm25.markPathDeleted("docs/old.md");
	bm25.markPathModified("docs/new.md");

	const result = await bm25.search("rename", {
		topN: 15,
		cutoffRatio: 0.4,
		minK: 3,
		k1: 1.2,
		b: 0.75,
	});

	assert.equal(readCount, 1);
	assert.equal(result.topResults[0]?.path, "docs/new.md");
	assert.equal(result.topResults.some((item) => item.path === "docs/old.md"), false);
});
