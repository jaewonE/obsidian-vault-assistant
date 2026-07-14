import type { AnkiCommandParseResult } from "../types";

function normalizeWhitespace(value: string): string {
	return value.replace(/\s+/gu, " ").trim();
}

export function parseAnkiCommand(input: string): AnkiCommandParseResult {
	const normalized = normalizeWhitespace(input);
	const lowered = normalized.toLocaleLowerCase();
	if (lowered !== "/anki" && !lowered.startsWith("/anki ")) {
		return { kind: "none" };
	}

	const artifact = normalized.slice("/anki".length).trim().toLocaleLowerCase();
	if (artifact === "flashcards" || artifact === "quiz") {
		return { kind: artifact };
	}

	return {
		kind: "invalid",
		error: "Usage: /Anki flashcards or /Anki quiz",
	};
}
