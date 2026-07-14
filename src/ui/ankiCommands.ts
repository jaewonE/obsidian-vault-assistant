import type { AnkiCommandOptions, AnkiCommandParseResult } from "../types";

function tokenizeArguments(value: string): string[] | null {
	const tokens: string[] = [];
	let token = "";
	let quote: "\"" | "'" | null = null;
	let escaped = false;

	for (const character of value) {
		if (escaped) {
			token += character;
			escaped = false;
			continue;
		}
		if (quote !== null) {
			if (character === "\\") {
				escaped = true;
			} else if (character === quote) {
				quote = null;
			} else {
				token += character;
			}
			continue;
		}
		if (character === "\"" || character === "'") {
			quote = character;
		} else if (/\s/u.test(character)) {
			if (token.length > 0) {
				tokens.push(token);
				token = "";
			}
		} else {
			token += character;
		}
	}

	if (quote !== null || escaped) {
		return null;
	}
	if (token.length > 0) {
		tokens.push(token);
	}
	return tokens;
}

function parsePositiveInteger(value: string): number | null {
	const numeric = Number(value);
	if (!Number.isSafeInteger(numeric) || numeric < 1) {
		return null;
	}
	return numeric;
}

function parseInvalidSourceRatio(value: string): number | null {
	const trimmed = value.trim();
	const isPercent = trimmed.endsWith("%");
	const numeric = Number(isPercent ? trimmed.slice(0, -1) : trimmed);
	const ratio = isPercent ? numeric / 100 : numeric;
	if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1) {
		return null;
	}
	return ratio;
}

function setDefined<K extends keyof AnkiCommandOptions>(
	options: AnkiCommandOptions,
	key: K,
	value: AnkiCommandOptions[K] | undefined,
): void {
	if (value !== undefined) {
		options[key] = value;
	}
}

function parseAnkiOptions(tokens: string[]): AnkiCommandOptions | { error: string } {
	const named: AnkiCommandOptions = {};
	const bare: string[] = [];

	for (const token of tokens) {
		const separator = token.indexOf("=");
		if (separator < 0) {
			bare.push(token);
			continue;
		}

		const key = token.slice(0, separator).toLocaleLowerCase();
		const value = token.slice(separator + 1).trim();
		switch (key) {
			case "max-count":
			case "max-counts":
			case "count":
			case "counts": {
				const maxCount = parsePositiveInteger(value);
				if (maxCount === null) {
					return { error: `${key} must be a positive integer.` };
				}
				named.maxCount = maxCount;
				break;
			}
			case "invalid-source-ratio": {
				const invalidSourceRatio = parseInvalidSourceRatio(value);
				if (invalidSourceRatio === null) {
					return { error: "invalid-source-ratio must be between 0 and 1 (or a percentage such as 10%)." };
				}
				named.invalidSourceRatio = invalidSourceRatio;
				break;
			}
			case "anki-deck":
			case "deck":
				if (value.length === 0) {
					return { error: `${key} must not be empty.` };
				}
				named.ankiDeck = value;
				break;
			case "deck-root":
			case "root":
				if (value.length === 0) {
					return { error: `${key} must not be empty.` };
				}
				named.deckRoot = value;
				break;
			default:
				// Unknown key-value pairs are intentionally ignored and never become positional values.
				break;
		}
	}

	const positional: AnkiCommandOptions = {};
	if (bare.length === 1 && bare[0] !== undefined) {
		const onlyBare = bare[0];
		const maxCount = parsePositiveInteger(onlyBare);
		if (maxCount === null) {
			positional.deckRoot = onlyBare;
		} else {
			positional.maxCount = maxCount;
		}
	} else if (bare.length === 2 && bare[0] !== undefined && bare[1] !== undefined) {
		const firstBare = bare[0];
		const secondBare = bare[1];
		const firstMaxCount = parsePositiveInteger(firstBare);
		const secondMaxCount = parsePositiveInteger(secondBare);
		if ((firstMaxCount === null) !== (secondMaxCount === null)) {
			positional.maxCount = firstMaxCount ?? secondMaxCount ?? undefined;
			positional.deckRoot = firstMaxCount === null ? firstBare : secondBare;
		}
	}

	const options: AnkiCommandOptions = { ...positional };
	setDefined(options, "maxCount", named.maxCount);
	setDefined(options, "invalidSourceRatio", named.invalidSourceRatio);
	setDefined(options, "ankiDeck", named.ankiDeck);
	setDefined(options, "deckRoot", named.deckRoot);
	return options;
}

export function parseAnkiCommand(input: string): AnkiCommandParseResult {
	const trimmed = input.trim();
	const command = /^\/anki(?:\s+|$)/iu.exec(trimmed);
	if (!command) {
		return { kind: "none" };
	}

	const tokens = tokenizeArguments(trimmed.slice(command[0].length));
	if (tokens === null) {
		return { kind: "invalid", error: "Anki command has an unterminated quoted value." };
	}
	const artifact = tokens.shift()?.toLocaleLowerCase();
	if (artifact !== "flashcards" && artifact !== "quiz") {
		return { kind: "invalid", error: "Usage: /Anki flashcards or /Anki quiz" };
	}
	const options = parseAnkiOptions(tokens);
	if ("error" in options) {
		return { kind: "invalid", error: options.error };
	}
	return { kind: artifact, options };
}
