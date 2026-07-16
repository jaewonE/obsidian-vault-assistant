import assert from "node:assert/strict";
import test from "node:test";
import { parseAnkiCommand } from "../../src/ui/ankiCommands";

test("parses Anki artifact commands case-insensitively", () => {
	assert.deepEqual(parseAnkiCommand("/Anki flashcards"), { kind: "flashcards", options: {} });
	assert.deepEqual(parseAnkiCommand("  /anki   QUIZ  "), { kind: "quiz", options: {} });
});

test("parses named Anki options, aliases, and quoted values", () => {
	assert.deepEqual(
		parseAnkiCommand('/Anki quiz max-counts=30 deck="hello world" root=study invalid-source-ratio=10%'),
		{
			kind: "quiz",
			options: {
				maxCount: 30,
				ankiDeck: "hello world",
				deckRoot: "study",
				invalidSourceRatio: 0.1,
			},
		},
	);
	assert.deepEqual(parseAnkiCommand("/Anki flashcards counts=12 anki-deck='Root Deck'"), {
		kind: "flashcards",
		options: { maxCount: 12, ankiDeck: "Root Deck" },
	});
});

test("maps one or two positional Anki values to a direct deck after excluding key-value pairs", () => {
	assert.deepEqual(parseAnkiCommand("/Anki flashcards 10"), {
		kind: "flashcards",
		options: { maxCount: 10 },
	});
	assert.deepEqual(parseAnkiCommand("/Anki flashcards hello"), {
		kind: "flashcards",
		options: { ankiDeck: "hello" },
	});
	assert.deepEqual(parseAnkiCommand("/Anki quiz hello 10 invalid-source-ratio=0.1"), {
		kind: "quiz",
		options: { maxCount: 10, ankiDeck: "hello", invalidSourceRatio: 0.1 },
	});
	assert.deepEqual(parseAnkiCommand("/anki quiz 30 DE.kafka"), {
		kind: "quiz",
		options: { maxCount: 30, ankiDeck: "DE.kafka" },
	});
});

test("uses explicit values over positional values and the last named alias", () => {
	assert.deepEqual(parseAnkiCommand("/Anki flashcards deck-root=hello world root=everyone 10 count=20"), {
		kind: "flashcards",
		options: { maxCount: 20, ankiDeck: "world", deckRoot: "everyone" },
	});
	assert.deepEqual(parseAnkiCommand("/Anki quiz root-deck=DE.kafka"), {
		kind: "quiz",
		options: { deckRoot: "DE.kafka" },
	});
	assert.deepEqual(parseAnkiCommand("/Anki quiz root=DE.kafka"), {
		kind: "quiz",
		options: { deckRoot: "DE.kafka" },
	});
	assert.deepEqual(parseAnkiCommand("/Anki quiz max-count=8 count=12"), {
		kind: "quiz",
		options: { maxCount: 12 },
	});
});

test("ignores unknown options and unsupported positional shapes", () => {
	assert.deepEqual(parseAnkiCommand("/Anki quiz unknown=value 10 hello extra"), {
		kind: "quiz",
		options: {},
	});
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

test("rejects malformed recognized values and unterminated quotes", () => {
	const malformedCount = parseAnkiCommand("/Anki flashcards count=0");
	assert.equal(malformedCount.kind, "invalid");
	const unterminatedQuote = parseAnkiCommand('/Anki quiz deck="hello');
	assert.equal(unterminatedQuote.kind, "invalid");
});
