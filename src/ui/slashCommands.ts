export interface SlashCommandSuggestion {
	kind: "command";
	text: string;
	rootCommand: string;
	subcommand: string | null;
}

interface SlashCommandDefinition {
	command: string;
	subcommands: string[];
}

const COMMAND_DEFINITIONS: SlashCommandDefinition[] = [
	{ command: "create", subcommands: [] },
	{ command: "research", subcommands: ["links", "deep"] },
];

function toRootSuggestion(command: string): SlashCommandSuggestion {
	return {
		kind: "command",
		text: `/${command}`,
		rootCommand: command,
		subcommand: null,
	};
}

function toSubcommandSuggestion(command: string, subcommand: string): SlashCommandSuggestion {
	return {
		kind: "command",
		text: `/${command} ${subcommand}`,
		rootCommand: command,
		subcommand,
	};
}

export function searchSlashCommandSuggestions(term: string): SlashCommandSuggestion[] {
	const normalized = term.toLocaleLowerCase().replace(/\s+/gu, " ").trimStart();
	if (normalized.length === 0) {
		return COMMAND_DEFINITIONS.map((item) => toRootSuggestion(item.command));
	}

	const normalizedTrimmedEnd = normalized.trimEnd();
	const hasTrailingSpace = normalized.endsWith(" ");
	const parts = normalizedTrimmedEnd.length > 0 ? normalizedTrimmedEnd.split(" ") : [];
	const rootInput = parts[0] ?? "";
	if (rootInput.length === 0) {
		return COMMAND_DEFINITIONS.map((item) => toRootSuggestion(item.command));
	}

	const rootCandidates = COMMAND_DEFINITIONS.filter((item) =>
		item.command.startsWith(rootInput),
	);
	const expectsSubcommand = parts.length > 1 || hasTrailingSpace;
	if (!expectsSubcommand) {
		return rootCandidates.map((item) => toRootSuggestion(item.command));
	}

	if (rootCandidates.length !== 1 || rootCandidates[0]?.command !== rootInput) {
		return [];
	}

	const root = rootCandidates[0];
	if (!root || root.subcommands.length === 0) {
		return [];
	}

	const subcommandInput = parts.slice(1).join(" ");
	const filteredSubcommands =
		subcommandInput.length === 0
			? root.subcommands
			: root.subcommands.filter((subcommand) =>
				subcommand.startsWith(subcommandInput),
			);

	return filteredSubcommands.map((subcommand) =>
		toSubcommandSuggestion(root.command, subcommand),
	);
}
