import type { ComposerSelectionItem } from "../types";

export function collectExplicitSelectionPaths(selections: ComposerSelectionItem[]): string[] {
	const deduped = new Set<string>();
	for (const selection of selections) {
		for (const filePath of selection.filePaths) {
			if (!filePath) {
				continue;
			}
			deduped.add(filePath);
		}
	}
	return [...deduped];
}

export function mergeSelectionPaths(bm25Paths: string[], explicitPaths: string[]): string[] {
	const merged = new Set<string>();
	for (const path of bm25Paths) {
		if (path) {
			merged.add(path);
		}
	}
	for (const path of explicitPaths) {
		if (path) {
			merged.add(path);
		}
	}
	return [...merged];
}
