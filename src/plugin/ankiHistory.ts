import type { AnkiArtifactType } from "../anki/generateAndImport";

export interface AnkiHistorySuccessParams {
	type: AnkiArtifactType;
	sourceTitles: string[];
	sourceCount: number;
	generatedCards: number;
	createdCards: number;
	skippedDuplicates: number;
	deck: string;
}

export interface AnkiHistoryFailureParams {
	type: AnkiArtifactType;
	sourceTitles: string[];
	sourceCount: number;
	error: string;
}

function artifactLabel(type: AnkiArtifactType): string {
	return type === "flashcards" ? "Flashcards" : "Quiz";
}

function sourceScope(sourceTitles: string[], sourceCount: number): string {
	const titles = [...new Set(sourceTitles.map((title) => title.trim()).filter(Boolean))];
	const count = Math.max(sourceCount, titles.length);
	if (titles.length === 0) {
		return count > 1 ? `선택한 ${count}개 소스` : "선택한 소스";
	}

	if (count <= 1) {
		return `${titles[0]} 소스`;
	}

	return `${titles[0]} 외 ${count - 1} 소스`;
}

function deckDestination(deck: string): string {
	const segments = deck
		.split("::")
		.map((segment) => segment.trim())
		.filter(Boolean);
	if (segments.length <= 1) {
		return `ANKI의 ${segments[0] ?? deck} 덱에`;
	}

	return `ANKI의 ${segments[0]} 덱 하위에 ${segments.slice(1).join("::")}로`;
}

export function buildAnkiHistorySuccessMessage(params: AnkiHistorySuccessParams): string {
	const summary = `${sourceScope(params.sourceTitles, params.sourceCount)}에 대한 ${artifactLabel(params.type)} ${params.generatedCards}개를 생성해 ${deckDestination(params.deck)}`;
	if (params.createdCards === params.generatedCards && params.skippedDuplicates === 0) {
		return `${summary} 추가하였습니다.`;
	}

	return `${summary} ${params.createdCards}개를 추가했으며, 중복 ${params.skippedDuplicates}개는 건너뛰었습니다.`;
}

export function buildAnkiHistoryFailureMessage(params: AnkiHistoryFailureParams): string {
	return `${sourceScope(params.sourceTitles, params.sourceCount)}에 대한 ${artifactLabel(params.type)} 생성에 실패했습니다: ${params.error}`;
}
