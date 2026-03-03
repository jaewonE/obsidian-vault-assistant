import assert from "node:assert/strict";
import test from "node:test";
import { isYouTubeUrl, parseResearchCommand } from "../../src/ui/researchCommands";

test("returns none for non-research input", () => {
	assert.deepEqual(parseResearchCommand("hello world"), { kind: "none" });
});

test("parses single URL as link command", () => {
	const parsed = parseResearchCommand("/research https://codingtoday.tistory.com/104");
	assert.equal(parsed.kind, "link");
	if (parsed.kind !== "link") {
		return;
	}
	assert.equal(parsed.url, "https://codingtoday.tistory.com/104");
	assert.equal(parsed.isYouTube, false);
});

test("parses youtube URL as link command with youtube flag", () => {
	const parsed = parseResearchCommand("/research https://www.youtube.com/watch?v=qt572Ysw3sc");
	assert.equal(parsed.kind, "link");
	if (parsed.kind !== "link") {
		return;
	}
	assert.equal(parsed.isYouTube, true);
});

test("parses links subcommand with multiple URLs", () => {
	const parsed = parseResearchCommand(
		"/research links https://a.example.com/x https://b.example.com/y",
	);
	assert.equal(parsed.kind, "links");
	if (parsed.kind !== "links") {
		return;
	}
	assert.deepEqual(parsed.urls, ["https://a.example.com/x", "https://b.example.com/y"]);
});

test("rejects links subcommand when a token is not a URL", () => {
	const parsed = parseResearchCommand("/research links https://a.example.com/x not-a-url");
	assert.equal(parsed.kind, "invalid");
});

test("parses deep subcommand query", () => {
	const parsed = parseResearchCommand("/research deep 민주주의에서 자유는 어디까지 허용되는가");
	assert.equal(parsed.kind, "research-deep");
	if (parsed.kind !== "research-deep") {
		return;
	}
	assert.equal(parsed.query, "민주주의에서 자유는 어디까지 허용되는가");
});

test("parses default non-url arg as fast research query", () => {
	const parsed = parseResearchCommand("/research 민주주의에서 자유는 어디까지 허용되어야 하는가");
	assert.equal(parsed.kind, "research-fast");
	if (parsed.kind !== "research-fast") {
		return;
	}
	assert.equal(parsed.query, "민주주의에서 자유는 어디까지 허용되어야 하는가");
});

test("trims repeated whitespace", () => {
	const parsed = parseResearchCommand("  /research   deep   test query   ");
	assert.equal(parsed.kind, "research-deep");
	if (parsed.kind !== "research-deep") {
		return;
	}
	assert.equal(parsed.query, "test query");
});

test("isYouTubeUrl handles youtube and non-youtube URLs", () => {
	assert.equal(isYouTubeUrl("https://www.youtube.com/watch?v=abc"), true);
	assert.equal(isYouTubeUrl("https://youtu.be/abc"), true);
	assert.equal(isYouTubeUrl("https://example.com/article"), false);
});
