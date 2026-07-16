import type { CitationOpenLocation } from "../types";

export type CitationSplitSide = "left" | "right";

export interface CitationPane<T> {
	value: T;
	left: number;
	right: number;
}

export function getCitationSplitSide(location: CitationOpenLocation): CitationSplitSide | null {
	if (location === "left-split") {
		return "left";
	}
	if (location === "right-split") {
		return "right";
	}
	return null;
}

/**
 * Chooses the visible edge pane only when the workspace already has at least
 * two split panes. Tabs in one pane are grouped before this helper is called.
 */
export function selectCitationEdgePane<T>(
	panes: readonly CitationPane<T>[],
	side: CitationSplitSide,
): T | null {
	if (panes.length < 2) {
		return null;
	}

	let edgePane = panes[0];
	if (!edgePane) {
		return null;
	}
	for (const pane of panes.slice(1)) {
		if (
			(side === "left" && pane.left < edgePane.left) ||
			(side === "right" && pane.right > edgePane.right)
		) {
			edgePane = pane;
		}
	}
	return edgePane.value;
}
