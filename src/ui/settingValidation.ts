export function normalizeYamlPropertyKey(value: string): {
	value: string;
	discardedExtraWords: boolean;
} {
	const words = value.trim().split(/\s+/u).filter((word) => word.length > 0);
	return {
		value: words[0] ?? "",
		discardedExtraWords: words.length > 1,
	};
}
