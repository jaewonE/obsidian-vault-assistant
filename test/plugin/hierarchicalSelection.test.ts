import assert from "node:assert/strict";
import test from "node:test";
import { resolveHierarchicalMarkdownPaths } from "../../src/plugin/hierarchicalSelection";

interface FakeFile {
	path: string;
}

function createApp(frontmatterByPath: Record<string, Record<string, unknown> | undefined>) {
	const files = Object.keys(frontmatterByPath).map<FakeFile>((path) => ({ path }));
	const filesByName = new Map(
		files.map((file) => [file.path.replace(/\.md$/u, "").split("/").pop() ?? file.path, file]),
	);
	return {
		vault: {
			getMarkdownFiles: () => files,
		},
		metadataCache: {
			getFileCache: (file: FakeFile) => {
				const frontmatter = frontmatterByPath[file.path];
				return frontmatter ? { frontmatter } : null;
			},
			getFirstLinkpathDest: (linkpath: string) => filesByName.get(linkpath.replace(/\.md$/u, "")) ?? null,
		},
	} as never;
}

test("includes the selected document and every descendant in breadth-first order", () => {
	const app = createApp({
		"A.md": { parents: null },
		"B.md": { parents: "[[A]]" },
		"C.md": { parents: ["[[B]]"] },
		"D.md": { parents: "[[B]]" },
		"E.md": { parents: "[[D]]" },
	});
	const result = resolveHierarchicalMarkdownPaths({
		app,
		rootPath: "B.md",
		parentProperty: "parents",
		limit: -1,
	});
	assert.deepEqual(result, { paths: ["B.md", "C.md", "D.md", "E.md"] });
});

test("applies the document limit to the selected document and descendants", () => {
	const app = createApp({
		"B.md": { parents: "[[A]]" },
		"C.md": { parents: "[[B]]" },
		"D.md": { parents: "[[B]]" },
		"E.md": { parents: "[[D]]" },
	});
	const result = resolveHierarchicalMarkdownPaths({
		app,
		rootPath: "B.md",
		parentProperty: "parents",
		limit: 3,
	});
	assert.deepEqual(result.paths, ["B.md", "C.md", "D.md"]);
});

test("does not proceed when the selected document has no frontmatter", () => {
	const app = createApp({ "B.md": undefined });
	const result = resolveHierarchicalMarkdownPaths({
		app,
		rootPath: "B.md",
		parentProperty: "parents",
		limit: -1,
	});
	assert.deepEqual(result.paths, []);
	assert.match(result.error ?? "", /no YAML property/u);
});

test("does not proceed when the selected document lacks the configured key", () => {
	const app = createApp({ "B.md": { aliases: ["B"] } });
	const result = resolveHierarchicalMarkdownPaths({
		app,
		rootPath: "B.md",
		parentProperty: "parents",
		limit: -1,
	});
	assert.deepEqual(result.paths, []);
	assert.match(result.error ?? "", /parents/u);
});

test("ignores descendants without YAML or the configured key and guards cycles", () => {
	const app = createApp({
		"B.md": { parents: "[[D]]" },
		"C.md": undefined,
		"D.md": { parents: "[[B]]" },
		"E.md": { aliases: ["E"] },
	});
	const result = resolveHierarchicalMarkdownPaths({
		app,
		rootPath: "B.md",
		parentProperty: "parents",
		limit: -1,
	});
	assert.deepEqual(result.paths, ["B.md", "D.md"]);
});
