import assert from "node:assert/strict";
import test from "node:test";
import { tokenizeForBm25, tokenizePathForBm25 } from "../../src/search/tokenization";

test("tokenizes latin, korean, japanese, and greek symbols", () => {
	const tokens = tokenizeForBm25("Heapsort 힙정렬 ヒープソート α β");

	assert.ok(tokens.includes("heapsort"));
	assert.ok(tokens.includes("힙정렬"));
	assert.ok(tokens.includes("ヒープソート"));
	assert.ok(tokens.includes("α"));
	assert.ok(tokens.includes("β"));
});

test("extracts latex command words", () => {
	const tokens = tokenizeForBm25(String.raw`\alpha + \beta = \gamma`);

	assert.ok(tokens.includes("alpha"));
	assert.ok(tokens.includes("beta"));
	assert.ok(tokens.includes("gamma"));
});

test("creates compound ascii tokens from adjacent words", () => {
	const tokens = tokenizeForBm25("heap sort");

	assert.ok(tokens.includes("heap"));
	assert.ok(tokens.includes("sort"));
	assert.ok(tokens.includes("heapsort"));
});

test("creates cjk/hangul bigram tokens for inflected text", () => {
	const tokens = tokenizeForBm25("힙정렬은");

	assert.ok(tokens.includes("힙정"));
	assert.ok(tokens.includes("정렬"));
});

test("tokenizes file path words and drops extension", () => {
	const tokens = tokenizePathForBm25("algorithms/heap_sort/heapsort.md");

	assert.ok(tokens.includes("algorithms"));
	assert.ok(tokens.includes("heap"));
	assert.ok(tokens.includes("sort"));
	assert.ok(tokens.includes("heapsort"));
	assert.equal(tokens.includes("md"), false);
});
