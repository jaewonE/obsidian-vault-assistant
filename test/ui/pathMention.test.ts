import assert from "node:assert/strict";
import test from "node:test";
import {
	getActiveAddFilePathMention,
	getActiveComposerMention,
	getActiveSlashCommandMention,
	replaceMentionToken,
} from "../../src/ui/pathMention";

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

test("detects slash command mention token", () => {
	const text = "Use /so";
	const context = getActiveSlashCommandMention(text, text.length);
	assert.ok(context);
	assert.equal(context?.kind, "command");
	assert.equal(context?.trigger, "/");
	assert.equal(context?.term, "so");
});

test("detects slash command mention with empty term", () => {
	const text = "/";
	const context = getActiveSlashCommandMention(text, text.length);
	assert.ok(context);
	assert.equal(context?.term, "");
});

test("does not parse slash inside a normal token", () => {
	const text = "folder/source";
	const context = getActiveSlashCommandMention(text, text.length);
	assert.equal(context, null);
});

test("keeps slash mention active when typing a subcommand", () => {
	const text = "/source ad";
	const context = getActiveSlashCommandMention(text, text.length);
	assert.ok(context);
	assert.equal(context?.term, "source ad");
});

test("keeps slash mention active for research deep subcommand", () => {
	const text = "/research deep 민주주의";
	const context = getActiveSlashCommandMention(text, text.length);
	assert.ok(context);
	assert.equal(context?.term, "research deep 민주주의");
});

test("composer mention picks nearest active trigger", () => {
	const text = "@docs/path /se";
	const context = getActiveComposerMention(text, text.length);
	assert.ok(context);
	assert.equal(context?.kind, "command");
	assert.equal(context?.term, "se");
});
