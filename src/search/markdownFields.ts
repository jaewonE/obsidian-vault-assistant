const HEADING_PATTERN = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/u;

export function extractMarkdownHeadings(markdown: string): string {
	const headingLines: string[] = [];
	for (const rawLine of markdown.split(/\r?\n/u)) {
		const match = rawLine.match(HEADING_PATTERN);
		if (!match) {
			continue;
		}

		const heading = match[1]?.trim();
		if (!heading) {
			continue;
		}
		headingLines.push(heading);
	}

	return headingLines.join("\n");
}
