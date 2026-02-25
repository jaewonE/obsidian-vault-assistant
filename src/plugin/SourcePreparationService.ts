import {
	SOURCE_TARGET_CAPACITY,
	SourceEvictionRecord,
	SourceRegistryEntry,
} from "../types";

export interface JsonObject {
	[key: string]: unknown;
}

export interface SourcePreparationProgress {
	path: string;
	index: number;
	total: number;
	action: "checking" | "uploading" | "ready";
	uploaded: boolean;
}

export interface SourcePreparationDependencies {
	remoteSourceIds: Set<string>;
	callTool<T>(name: string, args: Record<string, unknown>): Promise<T>;
	ensureToolSuccess(toolName: string, toolResult: unknown): void;
	extractSourceId(toolResult: unknown): string | null;
	getToolFailure(toolResult: unknown): string | null;
	resolveSourceId(sourceId: string): string;
	getSourceEntryByPath(path: string): SourceRegistryEntry | null;
	upsertSource(params: {
		path: string;
		sourceId: string;
		title: string;
		contentHash?: string;
	}): SourceRegistryEntry;
	registerSourceAlias(previousSourceId: string, currentSourceId: string): void;
	getSourceEntriesByContentHash(contentHash: string): SourceRegistryEntry[];
	markSourceUsed(path: string, protectedCap: number): void;
	getEvictionCandidatePath(): string | null;
	removeSourceByPath(path: string): SourceRegistryEntry | null;
	readMarkdown(path: string): Promise<string | null>;
	pathExists(path: string): boolean;
	hashText(content: string): string;
	logDebug(message: string, payload?: unknown): void;
	logWarn(message: string, payload?: unknown): void;
}

export interface EnsureSourcesForPathsParams {
	notebookId: string;
	paths: string[];
	evictions: SourceEvictionRecord[];
	protectedCapacity: number;
	onProgress?: (progress: SourcePreparationProgress) => void;
}

export async function ensureSourcesForPaths(
	params: EnsureSourcesForPathsParams,
	deps: SourcePreparationDependencies,
): Promise<Record<string, string>> {
	const pathToSourceId: Record<string, string> = {};
	const { notebookId, paths, evictions, protectedCapacity, onProgress } = params;
	const total = paths.length;

	for (let index = 0; index < paths.length; index += 1) {
		const path = paths[index];
		if (typeof path !== "string") {
			continue;
		}
		const displayIndex = index + 1;
		onProgress?.({
			path,
			index: displayIndex,
			total,
			action: "checking",
			uploaded: false,
		});

		const content = await deps.readMarkdown(path);
		if (content === null) {
			continue;
		}

		const contentHash = deps.hashText(content);
		const existing = deps.getSourceEntryByPath(path);
		const existingSourceId = existing ? deps.resolveSourceId(existing.sourceId) : "";
		const canReuseExisting =
			!!existingSourceId &&
			!existing?.stale &&
			deps.remoteSourceIds.has(existingSourceId);

		if (canReuseExisting && existing?.contentHash === contentHash) {
			if (existing && existing.sourceId !== existingSourceId) {
				deps.upsertSource({
					path,
					sourceId: existingSourceId,
					title: path,
					contentHash,
				});
				deps.registerSourceAlias(existing.sourceId, existingSourceId);
			}

			pathToSourceId[path] = existingSourceId;
			onProgress?.({
				path,
				index: displayIndex,
				total,
				action: "ready",
				uploaded: false,
			});
			continue;
		}

		if (canReuseExisting && existing) {
			onProgress?.({
				path,
				index: displayIndex,
				total,
				action: "uploading",
				uploaded: true,
			});

			const replacedSourceId = await replaceSourceWithLatestContent(
				{
					notebookId,
					path,
					content,
					previousSourceId: existingSourceId,
				},
				deps,
			);
			deps.upsertSource({
				path,
				sourceId: replacedSourceId,
				title: path,
				contentHash,
			});
			deps.registerSourceAlias(existingSourceId, replacedSourceId);
			if (existing.sourceId !== existingSourceId) {
				deps.registerSourceAlias(existing.sourceId, replacedSourceId);
			}
			deps.remoteSourceIds.add(replacedSourceId);

			pathToSourceId[path] = replacedSourceId;
			onProgress?.({
				path,
				index: displayIndex,
				total,
				action: "ready",
				uploaded: true,
			});
			continue;
		}

		const renamedSourceCandidate = findRenamedSourceCandidate(contentHash, path, deps);
		if (renamedSourceCandidate) {
			const resolvedCandidateSourceId = deps.resolveSourceId(renamedSourceCandidate.sourceId);
			deps.upsertSource({
				path,
				sourceId: resolvedCandidateSourceId,
				title: path,
				contentHash,
			});
			if (renamedSourceCandidate.sourceId !== resolvedCandidateSourceId) {
				deps.registerSourceAlias(renamedSourceCandidate.sourceId, resolvedCandidateSourceId);
			}

			pathToSourceId[path] = resolvedCandidateSourceId;
			onProgress?.({
				path,
				index: displayIndex,
				total,
				action: "ready",
				uploaded: false,
			});
			continue;
		}

		await evictUntilCapacity(evictions, deps);

		onProgress?.({
			path,
			index: displayIndex,
			total,
			action: "uploading",
			uploaded: true,
		});
		const addResult = await deps.callTool<JsonObject>("source_add", {
			notebook_id: notebookId,
			source_type: "text",
			text: content,
			title: path,
			wait: true,
		});
		deps.ensureToolSuccess("source_add", addResult);

		const sourceId = deps.extractSourceId(addResult);
		if (!sourceId) {
			throw new Error(`source_add for ${path} did not return source_id`);
		}

		deps.upsertSource({
			path,
			sourceId,
			title: path,
			contentHash,
		});
		if (existing && existing.sourceId !== sourceId) {
			deps.registerSourceAlias(existing.sourceId, sourceId);
		}
		deps.remoteSourceIds.add(sourceId);
		pathToSourceId[path] = sourceId;
		onProgress?.({
			path,
			index: displayIndex,
			total,
			action: "ready",
			uploaded: true,
		});
	}

	for (const preparedPath of Object.keys(pathToSourceId)) {
		deps.markSourceUsed(preparedPath, protectedCapacity);
	}

	return pathToSourceId;
}

function findRenamedSourceCandidate(
	contentHash: string,
	newPath: string,
	deps: SourcePreparationDependencies,
): SourceRegistryEntry | null {
	if (!contentHash) {
		return null;
	}

	const candidates = deps.getSourceEntriesByContentHash(contentHash).filter((entry) => {
		if (entry.path === newPath || entry.stale) {
			return false;
		}

		const currentSourceId = deps.resolveSourceId(entry.sourceId);
		if (!deps.remoteSourceIds.has(currentSourceId)) {
			return false;
		}

		return !deps.pathExists(entry.path);
	});
	if (candidates.length === 0) {
		return null;
	}

	candidates.sort((left, right) => right.lastUsedAt.localeCompare(left.lastUsedAt));
	return candidates[0] ?? null;
}

async function replaceSourceWithLatestContent(
	params: {
		notebookId: string;
		path: string;
		content: string;
		previousSourceId: string;
	},
	deps: SourcePreparationDependencies,
): Promise<string> {
	const { notebookId, path, content, previousSourceId } = params;
	const addResult = await deps.callTool<JsonObject>("source_add", {
		notebook_id: notebookId,
		source_type: "text",
		text: content,
		title: path,
		wait: true,
	});
	deps.ensureToolSuccess("source_add", addResult);

	const sourceId = deps.extractSourceId(addResult);
	if (!sourceId) {
		throw new Error(`source_add for ${path} did not return source_id`);
	}
	deps.remoteSourceIds.add(sourceId);

	await deleteSourceIfExists(previousSourceId, deps, { bestEffort: true });
	return sourceId;
}

async function deleteSourceIfExists(
	sourceId: string,
	deps: SourcePreparationDependencies,
	options: { bestEffort: boolean },
): Promise<void> {
	if (!sourceId) {
		return;
	}

	let removed = false;
	try {
		const deleteResult = await deps.callTool<JsonObject>("source_delete", {
			source_id: sourceId,
			confirm: true,
		});
		const failure = deps.getToolFailure(deleteResult);
		if (!failure || failure.toLowerCase().includes("not found")) {
			removed = true;
		} else if (options.bestEffort) {
			deps.logWarn("Failed to delete source during best-effort cleanup", {
				sourceId,
				failure,
			});
			return;
		} else {
			throw new Error(failure);
		}
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		if (errorMessage.toLowerCase().includes("not found")) {
			removed = true;
		} else if (options.bestEffort) {
			deps.logWarn("Source delete failed during best-effort cleanup", {
				sourceId,
				error: errorMessage,
			});
			return;
		} else {
			throw error;
		}
	}

	if (removed) {
		deps.remoteSourceIds.delete(sourceId);
	}
}

async function evictUntilCapacity(
	evictions: SourceEvictionRecord[],
	deps: SourcePreparationDependencies,
): Promise<void> {
	while (deps.remoteSourceIds.size >= SOURCE_TARGET_CAPACITY) {
		const candidatePath = deps.getEvictionCandidatePath();
		if (!candidatePath) {
			throw new Error(
				"Notebook source capacity reached but no managed eviction candidate is available.",
			);
		}

		const candidate = deps.getSourceEntryByPath(candidatePath);
		if (!candidate) {
			deps.removeSourceByPath(candidatePath);
			continue;
		}

		if (candidate.stale) {
			deps.removeSourceByPath(candidate.path);
			continue;
		}

		const resolvedCandidateSourceId = deps.resolveSourceId(candidate.sourceId);
		await deleteSourceIfExists(resolvedCandidateSourceId, deps, { bestEffort: false });

		deps.removeSourceByPath(candidate.path);
		deps.remoteSourceIds.delete(resolvedCandidateSourceId);
		const eviction: SourceEvictionRecord = {
			path: candidate.path,
			sourceId: resolvedCandidateSourceId,
			evictedAt: new Date().toISOString(),
			reason: "source-capacity-target",
		};
		evictions.push(eviction);
		deps.logDebug("Evicted NotebookLM source", eviction);
	}
}
