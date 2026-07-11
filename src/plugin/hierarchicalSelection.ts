import type { App } from "obsidian";

interface VaultMarkdownFile {
	path: string;
}

export interface HierarchicalSelectionResult {
	paths: string[];
	error?: string;
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(record, key);
}

function extractParentLinkpaths(value: unknown): string[] {
	const values = Array.isArray(value) ? value : [value];
	const links: string[] = [];
	for (const item of values) {
		if (typeof item !== "string") {
			continue;
		}
		let linkpath = item.trim();
		const wikiLink = /^!?\[\[([\s\S]+?)\]\]$/u.exec(linkpath);
		if (wikiLink?.[1]) {
			linkpath = wikiLink[1];
		}
		linkpath = (linkpath.split("|", 1)[0] ?? "").split("#", 1)[0]?.trim() ?? "";
		if (linkpath.length > 0) {
			links.push(linkpath);
		}
	}
	return links;
}

export function resolveHierarchicalMarkdownPaths(params: {
	app: App;
	rootPath: string;
	parentProperty: string;
	limit: number;
}): HierarchicalSelectionResult {
	const property = params.parentProperty.trim();
	if (!property) {
		return { paths: [], error: "Set a YAML parent property before using $." };
	}

	const markdownFiles = params.app.vault.getMarkdownFiles() as VaultMarkdownFile[];
	const rootFile = markdownFiles.find((file) => file.path === params.rootPath);
	if (!rootFile) {
		return { paths: [], error: `Markdown file not found: ${params.rootPath}` };
	}

	const rootFrontmatter = params.app.metadataCache.getFileCache(rootFile as never)?.frontmatter;
	if (!rootFrontmatter || !hasOwn(rootFrontmatter, property)) {
		return {
			paths: [],
			error: `The selected file has no YAML property named "${property}".`,
		};
	}

	const childrenByParent = new Map<string, string[]>();
	for (const file of markdownFiles) {
		const frontmatter = params.app.metadataCache.getFileCache(file as never)?.frontmatter;
		if (!frontmatter || !hasOwn(frontmatter, property)) {
			continue;
		}
		for (const linkpath of extractParentLinkpaths(frontmatter[property])) {
			const parent = params.app.metadataCache.getFirstLinkpathDest(linkpath, file.path);
			if (!parent || parent.path === file.path) {
				continue;
			}
			const children = childrenByParent.get(parent.path) ?? [];
			children.push(file.path);
			childrenByParent.set(parent.path, children);
		}
	}

	for (const children of childrenByParent.values()) {
		children.sort((left, right) => left.localeCompare(right));
	}

	const maximum = params.limit === -1 ? Number.POSITIVE_INFINITY : Math.max(1, params.limit);
	const paths: string[] = [];
	const visited = new Set<string>();
	const queue = [rootFile.path];
	while (queue.length > 0 && paths.length < maximum) {
		const path = queue.shift();
		if (!path || visited.has(path)) {
			continue;
		}
		visited.add(path);
		paths.push(path);
		for (const childPath of childrenByParent.get(path) ?? []) {
			if (!visited.has(childPath)) {
				queue.push(childPath);
			}
		}
	}

	return { paths };
}
