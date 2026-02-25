const WORD_TOKEN_PATTERN = /[\p{L}\p{N}]+/gu;
const ASCII_WORD_PATTERN = /^[a-z0-9]+$/u;
const CJK_OR_HANGUL_PATTERN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

const MIN_TOKEN_LENGTH = 1;
const MAX_TOKEN_LENGTH = 80;
const MAX_CJK_BIGRAM_TOKEN_LENGTH = 40;

function normalizeInput(text: string): string {
	return text.normalize("NFKC").toLocaleLowerCase();
}

function isAsciiWord(token: string): boolean {
	return ASCII_WORD_PATTERN.test(token);
}

function includesCjkOrHangul(token: string): boolean {
	return CJK_OR_HANGUL_PATTERN.test(token);
}

function cleanToken(token: string): string {
	return token.trim();
}

function isTokenLengthValid(token: string): boolean {
	return token.length >= MIN_TOKEN_LENGTH && token.length <= MAX_TOKEN_LENGTH;
}

function toWordTokens(text: string): string[] {
	const normalized = normalizeInput(text);
	const matches = normalized.match(WORD_TOKEN_PATTERN) ?? [];
	return matches.map(cleanToken).filter(isTokenLengthValid);
}

function createAsciiCompoundTokens(tokens: string[]): string[] {
	const compounds: string[] = [];
	for (let index = 0; index < tokens.length - 1; index += 1) {
		const left = tokens[index];
		const right = tokens[index + 1];
		if (!left || !right) {
			continue;
		}
		if (!isAsciiWord(left) || !isAsciiWord(right)) {
			continue;
		}
		if (left.length < 2 || right.length < 2) {
			continue;
		}
		const combined = `${left}${right}`;
		if (isTokenLengthValid(combined)) {
			compounds.push(combined);
		}
	}
	return compounds;
}

function createCjkBigrams(tokens: string[]): string[] {
	const bigrams: string[] = [];
	for (const token of tokens) {
		if (!includesCjkOrHangul(token)) {
			continue;
		}
		if (token.length < 2 || token.length > MAX_CJK_BIGRAM_TOKEN_LENGTH) {
			continue;
		}
		for (let index = 0; index < token.length - 1; index += 1) {
			bigrams.push(token.slice(index, index + 2));
		}
	}
	return bigrams;
}

export function tokenizeForBm25(text: string): string[] {
	const baseTokens = toWordTokens(text);
	if (baseTokens.length === 0) {
		return [];
	}

	const result = [...baseTokens];
	result.push(...createAsciiCompoundTokens(baseTokens));
	result.push(...createCjkBigrams(baseTokens));
	return result;
}

export function tokenizePathForBm25(path: string): string[] {
	const normalizedPath = path.replace(/\.md$/iu, "").replace(/[\\/._-]+/g, " ");
	return tokenizeForBm25(normalizedPath);
}
