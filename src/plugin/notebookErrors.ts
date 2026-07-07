function getErrorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}

export function isNotebookMissingError(error: unknown): boolean {
	const message = getErrorMessage(error).toLowerCase();
	const normalized = message.replace(/[_-]+/gu, " ");
	return (
		normalized.includes("not found") ||
		normalized.includes("notfound") ||
		normalized.includes("missing") ||
		message.includes("404")
	);
}
