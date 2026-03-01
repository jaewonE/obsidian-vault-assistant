import assert from "node:assert/strict";
import test from "node:test";
import {
	filterAllowedUploadPaths,
	getUploadMethodForPath,
} from "../../src/plugin/sourceUploadPolicy";

test("getUploadMethodForPath selects text/file by allowed extension", () => {
	assert.equal(getUploadMethodForPath("notes/doc.md"), "text");
	assert.equal(getUploadMethodForPath("notes/readme.txt"), "text");
	assert.equal(getUploadMethodForPath("assets/image.png"), "file");
	assert.equal(getUploadMethodForPath("media/clip.mp4"), "file");
	assert.equal(getUploadMethodForPath("docs/report.pdf"), "file");
	assert.equal(getUploadMethodForPath("bin/tool.exe"), null);
	assert.equal(getUploadMethodForPath("no-extension"), null);
});

test("filterAllowedUploadPaths drops unsupported files and reports ignored extensions", () => {
	const result = filterAllowedUploadPaths([
		"docs/a.md",
		"docs/a.md",
		"assets/image.png",
		"archive/data.zip",
		"no-extension",
		"scripts/run.sh",
	]);

	assert.deepEqual(result.allowedPaths, ["docs/a.md", "assets/image.png"]);
	assert.equal(result.ignoredCount, 3);
	assert.deepEqual(result.ignoredExtensions, ["(no-extension)", "sh", "zip"]);
});
