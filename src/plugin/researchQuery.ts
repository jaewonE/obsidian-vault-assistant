const RUN_TOKEN_SUFFIX_PATTERN = /\s\[run-[^\]]+\]\s*$/iu;

function createRawRunToken(): string {
	if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
		return crypto.randomUUID().split("-")[0] ?? crypto.randomUUID();
	}
	return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeRunToken(token: string): string {
	const normalized = token.toLocaleLowerCase().replace(/[^a-z0-9-]/gu, "").slice(0, 24);
	if (normalized.length > 0) {
		return normalized;
	}
	return createRawRunToken();
}

export function buildResearchTrackingQuery(query: string, runToken?: string): string {
	const trimmed = query.trim();
	if (RUN_TOKEN_SUFFIX_PATTERN.test(trimmed)) {
		return trimmed;
	}
	const token = normalizeRunToken(runToken ?? createRawRunToken());
	if (trimmed.length === 0) {
		return `[run-${token}]`;
	}
	return `${trimmed} [run-${token}]`;
}
