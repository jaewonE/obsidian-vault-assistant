import assert from "node:assert/strict";
import test from "node:test";
import { parseAnkiCommand } from "../../src/ui/ankiCommands";

test("parses Anki artifact commands case-insensitively", () => {
	assert.deepEqual(parseAnkiCommand("/Anki flashcards"), { kind: "flashcards" });
	assert.deepEqual(parseAnkiCommand("  /anki   QUIZ  "), { kind: "quiz" });
});

test("does not claim unrelated slash commands", () => {
	assert.deepEqual(parseAnkiCommand("/ankify flashcards"), { kind: "none" });
	assert.deepEqual(parseAnkiCommand("/research Kafka"), { kind: "none" });
});

test("explains the required Anki command form", () => {
	const parsed = parseAnkiCommand("/anki cards");
	assert.equal(parsed.kind, "invalid");
	if (parsed.kind === "invalid") {
		assert.match(parsed.error, /\/Anki flashcards/);
	}
});
