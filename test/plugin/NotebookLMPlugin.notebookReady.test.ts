import assert from "node:assert/strict";
import test from "node:test";
import { isNotebookMissingError } from "../../src/plugin/notebookErrors";

test("recognizes NotebookLM NOT_FOUND errors as missing notebooks", () => {
	assert.equal(
		isNotebookMissingError(
			new Error("notebook_get failed: Failed to get notebook: API error (code 5): NOT_FOUND"),
		),
		true,
	);
	assert.equal(isNotebookMissingError(new Error("Failed to get notebook: not found")), true);
	assert.equal(isNotebookMissingError(new Error("Failed to get notebook: missing")), true);
	assert.equal(isNotebookMissingError(new Error("Failed to get notebook: API error 404")), true);
	assert.equal(isNotebookMissingError(new Error("Authentication failed")), false);
});
