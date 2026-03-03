import type { ResearchCommandParseResult } from "../types";

function normalizeWhitespace(value: string): string {
	return value.replace(/\s+/gu, " ").trim();
}

function isHttpUrl(value: string): boolean {
	if (!/^https?:\/\//iu.test(value)) {
		return false;
	}
	if (/\s/u.test(value)) {
		return false;
	}
	try {
		const parsed = new URL(value);
		return parsed.protocol === "http:" || parsed.protocol === "https:";
	} catch {
		return false;
	}
}

export function isYouTubeUrl(value: string): boolean {
	if (!isHttpUrl(value)) {
		return false;
	}
	const lowered = value.toLocaleLowerCase();
	return lowered.includes("www.youtube.com") || lowered.includes("youtube.com") || lowered.includes("youtu.be");
}

export function parseResearchCommand(input: string): ResearchCommandParseResult {
	const normalized = normalizeWhitespace(input);
	if (!normalized.toLocaleLowerCase().startsWith("/research")) {
		return {
			kind: "none",
		};
	}

	const rawArg = normalized.slice("/research".length).trim();
	if (rawArg.length === 0) {
		return {
			kind: "invalid",
			error: "Usage: /research <url|query>, /research links <url ...>, /research deep <query>",
		};
	}

	const loweredArg = rawArg.toLocaleLowerCase();
	if (loweredArg === "links") {
		return {
			kind: "invalid",
			error: "Usage: /research links <url ...>",
		};
	}
	if (loweredArg.startsWith("links ")) {
		const urls = rawArg.slice("links".length).trim().split(/\s+/u).filter((item) => item.length > 0);
		if (urls.length === 0) {
			return {
				kind: "invalid",
				error: "Usage: /research links <url ...>",
			};
		}
		if (urls.some((url) => !isHttpUrl(url))) {
			return {
				kind: "invalid",
				error: "The /research links command accepts only http(s) URLs.",
			};
		}
		return {
			kind: "links",
			urls,
		};
	}

	if (loweredArg === "deep") {
		return {
			kind: "invalid",
			error: "Usage: /research deep <query>",
		};
	}
	if (loweredArg.startsWith("deep ")) {
		const query = rawArg.slice("deep".length).trim();
		if (query.length === 0) {
			return {
				kind: "invalid",
				error: "Usage: /research deep <query>",
			};
		}
		return {
			kind: "research-deep",
			query,
		};
	}

	if (isHttpUrl(rawArg)) {
		return {
			kind: "link",
			url: rawArg,
			isYouTube: isYouTubeUrl(rawArg),
		};
	}

	return {
		kind: "research-fast",
		query: rawArg,
	};
}
