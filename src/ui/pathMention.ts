import type { AddFilePathMode } from "../types";

export interface AddFilePathMentionContext {
	mode: AddFilePathMode;
	term: string;
	tokenStart: number;
	tokenEnd: number;
	trigger: "@" | "@@";
}

function isWhitespace(value: string): boolean {
	return /\s/u.test(value);
}

export function getActiveAddFilePathMention(
	text: string,
	cursorIndex: number,
): AddFilePathMentionContext | null {
	const safeCursor = Math.max(0, Math.min(cursorIndex, text.length));
	const lineStart = text.lastIndexOf("\n", Math.max(0, safeCursor - 1)) + 1;

	let tokenStart = -1;
	let trigger: "@" | "@@" | null = null;
	for (let index = safeCursor - 1; index >= lineStart; index -= 1) {
		if (text[index] !== "@") {
			continue;
		}

		const prefix = index > 0 ? text[index - 1] : "";
		if (prefix && !isWhitespace(prefix)) {
			continue;
		}

		if (text[index + 1] === "@") {
			tokenStart = index;
			trigger = "@@";
			break;
		}

		tokenStart = index;
		trigger = "@";
		break;
	}

	if (tokenStart < 0 || !trigger) {
		return null;
	}

	const tokenBodyStart = tokenStart + (trigger === "@@" ? 2 : 1);
	if (tokenBodyStart > safeCursor) {
		return null;
	}

	const term = text.slice(tokenBodyStart, safeCursor);
	if (term.includes("\n") || term.includes("\r")) {
		return null;
	}

	return {
		mode: trigger === "@@" ? "all" : "markdown",
		term,
		tokenStart,
		tokenEnd: safeCursor,
		trigger,
	};
}

export function replaceMentionToken(
	text: string,
	context: AddFilePathMentionContext,
	replacement = "",
): { value: string; cursorIndex: number } {
	const nextValue =
		text.slice(0, context.tokenStart) + replacement + text.slice(context.tokenEnd);
	const nextCursorIndex = context.tokenStart + replacement.length;
	return {
		value: nextValue,
		cursorIndex: nextCursorIndex,
	};
}
