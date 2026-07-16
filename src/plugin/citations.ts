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

/**
 * Reassigns NotebookLM's passage-based citation numbers to source-based numbers.
 *
 * NotebookLM gives every cited passage an index, so one source can appear under
 * several numbers. The chat UI only opens sources, not individual passages, so
 * each source receives one stable number for the rendered answer instead.
 */
export function normalizeQueryCitations(
	answer: string,
	citations: QueryCitation[],
): { answer: string; citations: QueryCitation[] } {
	const citationsByNumber = new Map(citations.map((citation) => [citation.citationNumber, citation]));
	const citationNumberBySourceId = new Map<string, number>();
	const normalizedCitations: QueryCitation[] = [];

	const normalizedAnswer = answer.replace(/\[(\d+(?:\s*,\s*\d+)*)\]/gu, (marker) => {
		const originalCitationNumbers = parseCitationMarker(marker);
		const sourceCitations: QueryCitation[] = [];
		for (const citationNumber of originalCitationNumbers) {
			const citation = citationsByNumber.get(citationNumber);
			if (!citation) {
				return marker;
			}
			sourceCitations.push(citation);
		}

		const normalizedCitationNumbers: number[] = [];
		for (const citation of sourceCitations) {
			let citationNumber = citationNumberBySourceId.get(citation.sourceId);
			if (!citationNumber) {
				citationNumber = normalizedCitations.length + 1;
				citationNumberBySourceId.set(citation.sourceId, citationNumber);
				normalizedCitations.push({
					citationNumber,
					sourceId: citation.sourceId,
					...(citation.citedText ? { citedText: citation.citedText } : {}),
				});
			}
			if (!normalizedCitationNumbers.includes(citationNumber)) {
				normalizedCitationNumbers.push(citationNumber);
			}
		}

		return `[${normalizedCitationNumbers.join(",")}]`;
	});

	return { answer: normalizedAnswer, citations: normalizedCitations };
}

export function getLocalCitationSourceKind(path: string): CitationSourceKind {
	const extension = path.split(".").pop()?.trim().toLocaleLowerCase() ?? "";
	return IMAGE_SOURCE_EXTENSIONS.has(extension) ? "image" : "document";
}

/**
 * Parses the source-level citation marker shown inside a rendered answer.
 * Multiple source numbers can appear in one marker (for example, `[1,2]`).
 */
export function parseCitationMarker(marker: string): number[] {
	const match = marker.match(/^\[(\d+(?:\s*,\s*\d+)*)\]$/u);
	if (!match?.[1]) {
		return [];
	}

	const citationNumbers = match[1].split(",").map((value) => Number(value.trim()));
	return citationNumbers.every((citationNumber) => Number.isSafeInteger(citationNumber) && citationNumber > 0)
		? citationNumbers
		: [];
}
