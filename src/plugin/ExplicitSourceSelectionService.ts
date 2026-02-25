import { App } from "obsidian";
import type {
	AddFilePathMode,
	AddFilePathSearchItem,
	AddFilePathSelectionKind,
	ComposerSelectionItem,
	ResolveComposerSelectionResult,
} from "../types";

export const PATH_SELECTION_WARNING_SUBFILE_THRESHOLD = 15;
export const PATH_SELECTION_REJECT_SUBFILE_THRESHOLD = 200;
export const FOLDER_NOTE_EXTENSIONS = ["md", "canvas", "base"] as const;
const DEFAULT_SEARCH_RESULT_LIMIT = 60;

interface RankedSearchItem {
	item: AddFilePathSearchItem;
	score: number;
}

function isVaultFile(value: unknown): value is { path: string; name: string; extension: string } {
	if (!value || typeof value !== "object") {
		return false;
	}
	const record = value as Record<string, unknown>;
	return (
		typeof record.path === "string" &&
		typeof record.name === "string" &&
		typeof record.extension === "string"
	);
}

function isVaultFolder(value: unknown): value is { path: string; name: string } {
	if (!value || typeof value !== "object") {
		return false;
	}
	const record = value as Record<string, unknown>;
	return (
		typeof record.path === "string" &&
		typeof record.name === "string" &&
		typeof record.extension !== "string"
	);
}

function generateSelectionId(): string {
	if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
		return crypto.randomUUID();
	}
	return `sel-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function normalizeText(value: string): string {
	return value
		.normalize("NFKC")
		.toLocaleLowerCase()
		.replace(/_/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function splitPath(path: string): string[] {
	return path.split("/").filter((part) => part.length > 0);
}

function getNameFromPath(path: string): string {
	const parts = splitPath(path);
	return parts[parts.length - 1] ?? path;
}

function getParentPath(path: string): string {
	const parts = splitPath(path);
	parts.pop();
	return parts.join("/");
}

function scoreMatch(name: string, path: string, normalizedTerm: string): number | null {
	if (!normalizedTerm) {
		return 1;
	}

	const normalizedName = normalizeText(name);
	const normalizedPath = normalizeText(path);
	let score = 0;
	if (normalizedName === normalizedTerm) {
		score += 600;
	}
	if (normalizedName.startsWith(normalizedTerm)) {
		score += 300;
	}
	if (normalizedName.includes(normalizedTerm)) {
		score += 180;
	}
	if (normalizedPath.startsWith(normalizedTerm)) {
		score += 120;
	}
	if (normalizedPath.includes(normalizedTerm)) {
		score += 80;
	}
	if (score === 0) {
		return null;
	}

	return score - Math.min(path.length, 100) / 1000;
}

function buildFolderSubfileCount(filePaths: string[]): Map<string, number> {
	const counts = new Map<string, number>();
	for (const filePath of filePaths) {
		const parts = splitPath(filePath);
		for (let index = 0; index < parts.length - 1; index += 1) {
			const folderPath = parts.slice(0, index + 1).join("/");
			const previous = counts.get(folderPath) ?? 0;
			counts.set(folderPath, previous + 1);
		}
	}
	return counts;
}

export class ExplicitSourceSelectionService {
	private readonly app: App;

	constructor(app: App) {
		this.app = app;
	}

	search(term: string, mode: AddFilePathMode, limit = DEFAULT_SEARCH_RESULT_LIMIT): AddFilePathSearchItem[] {
		const files = mode === "markdown" ? this.app.vault.getMarkdownFiles() : this.app.vault.getFiles();
		const normalizedTerm = normalizeText(term);
		const ranked: RankedSearchItem[] = [];

		for (const file of files) {
			const score = scoreMatch(file.name, file.path, normalizedTerm);
			if (score === null) {
				continue;
			}
			ranked.push({
				score,
				item: {
					kind: "file",
					path: file.path,
					name: file.name,
					parentPath: getParentPath(file.path),
					extension: file.extension.toLocaleLowerCase(),
					subfileCount: 1,
				},
			});
		}

		const folderSubfileCount = buildFolderSubfileCount(files.map((file) => file.path));
		const allLoaded = this.app.vault.getAllLoadedFiles();
		for (const abstractFile of allLoaded) {
			if (!isVaultFolder(abstractFile) || !abstractFile.path) {
				continue;
			}
			const subfileCount = folderSubfileCount.get(abstractFile.path) ?? 0;
			if (subfileCount === 0) {
				continue;
			}
			const score = scoreMatch(abstractFile.name, abstractFile.path, normalizedTerm);
			if (score === null) {
				continue;
			}
			ranked.push({
				score,
				item: {
					kind: "path",
					path: abstractFile.path,
					name: abstractFile.name,
					parentPath: getParentPath(abstractFile.path),
					subfileCount,
				},
			});
		}

		ranked.sort((left, right) => {
			if (left.score !== right.score) {
				return right.score - left.score;
			}
			if (left.item.kind !== right.item.kind) {
				return left.item.kind === "file" ? -1 : 1;
			}
			return left.item.path.localeCompare(right.item.path);
		});

		return ranked.slice(0, Math.max(1, limit)).map((entry) => entry.item);
	}

	resolveSelection(params: {
		kind: AddFilePathSelectionKind;
		path: string;
		mode: AddFilePathMode;
	}): ResolveComposerSelectionResult {
		const { kind, mode, path } = params;
		if (kind === "file") {
			return this.resolveFileSelection(path, mode);
		}
		return this.resolvePathSelection(path, mode);
	}

	resolveFolderNotePath(path: string): string | null {
		const folderName = getNameFromPath(path);
		if (!folderName) {
			return null;
		}

		for (const extension of FOLDER_NOTE_EXTENSIONS) {
			const candidatePath = `${path}/${folderName}.${extension}`;
			const file = this.app.vault.getAbstractFileByPath(candidatePath);
			if (isVaultFile(file)) {
				return file.path;
			}
		}

		return null;
	}

	private resolveFileSelection(path: string, mode: AddFilePathMode): ResolveComposerSelectionResult {
		const abstractFile = this.app.vault.getAbstractFileByPath(path);
		if (!isVaultFile(abstractFile)) {
			return {
				selection: null,
				error: `File not found: ${path}`,
			};
		}

		if (mode === "markdown" && abstractFile.extension.toLocaleLowerCase() !== "md") {
			return {
				selection: null,
				error: "Only markdown files can be added with @.",
			};
		}

		return {
			selection: {
				id: generateSelectionId(),
				kind: "file",
				mode,
				path: abstractFile.path,
				label: abstractFile.name,
				filePaths: [abstractFile.path],
				subfileCount: 1,
			},
		};
	}

	private resolvePathSelection(path: string, mode: AddFilePathMode): ResolveComposerSelectionResult {
		const abstractFile = this.app.vault.getAbstractFileByPath(path);
		if (!isVaultFolder(abstractFile)) {
			return {
				selection: null,
				error: `Path not found: ${path}`,
			};
		}

		const descendantPaths = this.getDescendantPaths(path, mode);
		const subfileCount = descendantPaths.length;
		if (subfileCount === 0) {
			return {
				selection: null,
				error: "No files found under this path.",
			};
		}
		if (subfileCount > PATH_SELECTION_REJECT_SUBFILE_THRESHOLD) {
			return {
				selection: null,
				error: `Path contains ${subfileCount} files; only up to ${PATH_SELECTION_REJECT_SUBFILE_THRESHOLD} files are allowed.`,
			};
		}

		const warning =
			subfileCount > PATH_SELECTION_WARNING_SUBFILE_THRESHOLD
				? `This path includes ${subfileCount} files and may take longer to process.`
				: undefined;

		return {
			selection: {
				id: generateSelectionId(),
				kind: "path",
				mode,
				path,
				label: path,
				filePaths: descendantPaths,
				subfileCount,
			},
			warning,
		};
	}

	private getDescendantPaths(path: string, mode: AddFilePathMode): string[] {
		const prefix = `${path}/`;
		const files = mode === "markdown" ? this.app.vault.getMarkdownFiles() : this.app.vault.getFiles();
		const descendants: string[] = [];
		for (const file of files) {
			if (!file.path.startsWith(prefix)) {
				continue;
			}
			descendants.push(file.path);
		}
		return descendants.sort((left, right) => left.localeCompare(right));
	}
}
