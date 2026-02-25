import assert from "node:assert/strict";
import test from "node:test";
import { getActiveAddFilePathMention, replaceMentionToken } from "../../src/ui/pathMention";

test("detects markdown add-path mention token", () => {
	const text = "Explain @algorithms/heap";
	const context = getActiveAddFilePathMention(text, text.length);
	assert.ok(context);
	assert.equal(context?.mode, "markdown");
	assert.equal(context?.trigger, "@");
	assert.equal(context?.term, "algorithms/heap");
});

test("detects all-files add-path mention token", () => {
	const text = "Analyze @@assets/images";
	const context = getActiveAddFilePathMention(text, text.length);
	assert.ok(context);
	assert.equal(context?.mode, "all");
	assert.equal(context?.trigger, "@@");
	assert.equal(context?.term, "assets/images");
});

test("does not parse @ inside a normal token", () => {
	const text = "contact email@test.com";
	const context = getActiveAddFilePathMention(text, text.length);
	assert.equal(context, null);
});

test("keeps mention active when term contains spaces", () => {
	const text = "Explain @word1 word2";
	const context = getActiveAddFilePathMention(text, text.length);
	assert.ok(context);
	assert.equal(context?.mode, "markdown");
	assert.equal(context?.term, "word1 word2");
});

test("replaceMentionToken removes the active token from text", () => {
	const text = "question @docs/topic now";
	const cursor = "question @docs/topic".length;
	const context = getActiveAddFilePathMention(text, cursor);
	assert.ok(context);
	if (!context) {
		return;
	}

	const replaced = replaceMentionToken(text, context, "");
	assert.equal(replaced.value, "question  now");
	assert.equal(replaced.cursorIndex, "question ".length);
});
