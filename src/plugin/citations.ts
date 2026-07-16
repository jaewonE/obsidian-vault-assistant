import type { CitationSourceKind, QueryCitation } from "../types";

type JsonRecord = Record<string, unknown>;

const IMAGE_SOURCE_EXTENSIONS = new Set([
	"avif",
	"bmp",
	"gif",
	"heic",
	"heif",
	"ico",
	"jp2",
	"jpe",
	"jpeg",
	"jpg",
	"png",
	"tif",
	"tiff",
	"webp",
]);

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null;
}

function getNonEmptyString(value: unknown): string | undefined {
	if (typeof value !== "string") {
		return undefined;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function getCitationNumber(value: unknown): number | null {
	const numberValue = typeof value === "number" ? value : Number(value);
	if (!Number.isSafeInteger(numberValue) || numberValue < 1) {
		return null;
	}
	return numberValue;
}

function getQueryResultRecord(toolResult: unknown): JsonRecord | null {
	if (!isRecord(toolResult)) {
		return null;
	}
	if (isRecord(toolResult.citations) || Array.isArray(toolResult.references)) {
		return toolResult;
	}
	return isRecord(toolResult.data) ? toolResult.data : toolResult;
}

/**
 * Extract the NotebookLM citation-number-to-source mapping from a query response.
 * `citations` is authoritative for the mapping, while `references` contributes
 * the quoted evidence passage and supplies a fallback for partial responses.
 */
export function extractQueryCitations(toolResult: unknown): QueryCitation[] {
	const result = getQueryResultRecord(toolResult);
	if (!result) {
		return [];
	}

	const citationsByNumber = new Map<number, QueryCitation>();
	if (isRecord(result.citations)) {
		for (const [rawCitationNumber, rawSourceId] of Object.entries(result.citations)) {
			const citationNumber = getCitationNumber(rawCitationNumber);
			const sourceId = getNonEmptyString(rawSourceId);
			if (!citationNumber || !sourceId) {
				continue;
			}
			citationsByNumber.set(citationNumber, { citationNumber, sourceId });
		}
	}

	if (Array.isArray(result.references)) {
		for (const reference of result.references) {
			if (!isRecord(reference)) {
				continue;
			}
			const citationNumber = getCitationNumber(reference.citation_number ?? reference.citationNumber);
			const sourceId = getNonEmptyString(reference.source_id ?? reference.sourceId);
			if (!citationNumber || !sourceId) {
				continue;
			}
			const citedText = getNonEmptyString(reference.cited_text ?? reference.citedText);
			const existing = citationsByNumber.get(citationNumber);
			citationsByNumber.set(citationNumber, {
				citationNumber,
				sourceId: existing?.sourceId ?? sourceId,
				citedText: citedText ?? existing?.citedText,
			});
		}
	}

	return [...citationsByNumber.values()].sort((left, right) => left.citationNumber - right.citationNumber);
}

export function getLocalCitationSourceKind(path: string): CitationSourceKind {
	const extension = path.split(".").pop()?.trim().toLocaleLowerCase() ?? "";
	return IMAGE_SOURCE_EXTENSIONS.has(extension) ? "image" : "document";
}
