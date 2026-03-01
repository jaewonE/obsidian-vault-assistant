import type { ConversationRecord } from "../types";

export function buildReusableSourceIds(params: {
	queryMetadata: ConversationRecord["queryMetadata"];
	resolveSourceId: (sourceId: string) => string;
	remoteSourceIds: Set<string>;
	maxCount: number;
	excludedSourceIds?: Set<string>;
}): string[] {
	const { queryMetadata, resolveSourceId, remoteSourceIds, maxCount, excludedSourceIds } = params;
	const reusableSourceIds: string[] = [];
	const seen = new Set<string>();

	for (let index = queryMetadata.length - 1; index >= 0; index -= 1) {
		const metadata = queryMetadata[index];
		if (!metadata) {
			continue;
		}

		for (const rawSourceId of metadata.selectedSourceIds) {
			const sourceId = resolveSourceId(rawSourceId);
			if (!sourceId || seen.has(sourceId)) {
				continue;
			}
			if (!remoteSourceIds.has(sourceId)) {
				continue;
			}
			if (excludedSourceIds?.has(sourceId)) {
				continue;
			}
			seen.add(sourceId);
			reusableSourceIds.push(sourceId);
			if (reusableSourceIds.length >= maxCount) {
				return reusableSourceIds;
			}
		}
	}

	return reusableSourceIds;
}
