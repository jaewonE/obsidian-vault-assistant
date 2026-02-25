import assert from "node:assert/strict";
import test from "node:test";
import {
	ExplicitSourceSelectionService,
	PATH_SELECTION_REJECT_SUBFILE_THRESHOLD,
	PATH_SELECTION_WARNING_SUBFILE_THRESHOLD,
} from "../../src/plugin/ExplicitSourceSelectionService";

interface FakeFile {
	path: string;
	name: string;
	extension: string;
}

interface FakeFolder {
	path: string;
	name: string;
}

function getNameFromPath(path: string): string {
	const parts = path.split("/");
	return parts[parts.length - 1] ?? path;
}

function createHarness(params: { files: FakeFile[]; folders: string[] }) {
	const filesByPath = new Map(params.files.map((file) => [file.path, file]));
	const folders = params.folders.map<FakeFolder>((path) => ({
		path,
		name: getNameFromPath(path),
	}));
	const folderByPath = new Map(folders.map((folder) => [folder.path, folder]));
	const markdownFiles = params.files.filter((file) => file.extension.toLocaleLowerCase() === "md");
	const allLoadedFiles = [...params.files, ...folders];
	const service = new ExplicitSourceSelectionService({
		vault: {
			getMarkdownFiles: () => markdownFiles,
			getFiles: () => params.files,
			getAllLoadedFiles: () => allLoadedFiles,
			getAbstractFileByPath: (path: string) => filesByPath.get(path) ?? folderByPath.get(path) ?? null,
		},
	} as never);

	return {
		service,
	};
}

test("search uses markdown-only scope for @ mode", () => {
	const harness = createHarness({
		files: [
			{ path: "docs/guide.md", name: "guide.md", extension: "md" },
			{ path: "docs/spec.canvas", name: "spec.canvas", extension: "canvas" },
			{ path: "assets/image.png", name: "image.png", extension: "png" },
		],
		folders: ["docs", "assets"],
	});

	const results = harness.service.search("doc", "markdown");
	assert.equal(results.some((item) => item.kind === "file" && item.path.endsWith(".canvas")), false);
	assert.equal(results.some((item) => item.kind === "path" && item.path === "docs"), true);
});

test("search uses all files for @@ mode", () => {
	const harness = createHarness({
		files: [
			{ path: "docs/guide.md", name: "guide.md", extension: "md" },
			{ path: "docs/spec.canvas", name: "spec.canvas", extension: "canvas" },
			{ path: "assets/image.png", name: "image.png", extension: "png" },
		],
		folders: ["docs", "assets"],
	});

	const results = harness.service.search("spec", "all");
	assert.equal(results.some((item) => item.kind === "file" && item.path === "docs/spec.canvas"), true);
});

test("search term with underscore matches filenames with spaces", () => {
	const harness = createHarness({
		files: [{ path: "docs/word1 word2.md", name: "word1 word2.md", extension: "md" }],
		folders: ["docs"],
	});

	const results = harness.service.search("word1_word2", "markdown");
	assert.equal(results.some((item) => item.kind === "file" && item.path === "docs/word1 word2.md"), true);
});

test("path selection warns when descendant file count exceeds warning threshold", () => {
	const files: FakeFile[] = [];
	for (let index = 0; index < PATH_SELECTION_WARNING_SUBFILE_THRESHOLD + 1; index += 1) {
		files.push({
			path: `big/file-${index}.md`,
			name: `file-${index}.md`,
			extension: "md",
		});
	}
	const harness = createHarness({
		files,
		folders: ["big"],
	});

	const resolved = harness.service.resolveSelection({
		kind: "path",
		path: "big",
		mode: "markdown",
	});
	assert.ok(resolved.selection);
	assert.ok(resolved.warning);
	assert.equal(resolved.selection?.subfileCount, PATH_SELECTION_WARNING_SUBFILE_THRESHOLD + 1);
});

test("path selection rejects when descendant file count exceeds hard limit", () => {
	const files: FakeFile[] = [];
	for (let index = 0; index < PATH_SELECTION_REJECT_SUBFILE_THRESHOLD + 1; index += 1) {
		files.push({
			path: `huge/file-${index}.md`,
			name: `file-${index}.md`,
			extension: "md",
		});
	}
	const harness = createHarness({
		files,
		folders: ["huge"],
	});

	const resolved = harness.service.resolveSelection({
		kind: "path",
		path: "huge",
		mode: "markdown",
	});
	assert.equal(resolved.selection, null);
	assert.ok(resolved.error?.includes("only up to"));
});

test("folder note resolution supports md/canvas/base extensions", () => {
	const harness = createHarness({
		files: [
			{ path: "path1/path2/path2.canvas", name: "path2.canvas", extension: "canvas" },
		],
		folders: ["path1", "path1/path2"],
	});

	const folderNotePath = harness.service.resolveFolderNotePath("path1/path2");
	assert.equal(folderNotePath, "path1/path2/path2.canvas");
});

test("file selection rejects non-markdown in @ mode", () => {
	const harness = createHarness({
		files: [{ path: "assets/image.png", name: "image.png", extension: "png" }],
		folders: ["assets"],
	});

	const resolved = harness.service.resolveSelection({
		kind: "file",
		path: "assets/image.png",
		mode: "markdown",
	});
	assert.equal(resolved.selection, null);
	assert.equal(resolved.error, "Only markdown files can be added with @.");
});
