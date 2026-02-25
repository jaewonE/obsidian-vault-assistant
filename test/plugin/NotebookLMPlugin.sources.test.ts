import assert from "node:assert/strict";
import test from "node:test";
import {
	ensureSourcesForPaths,
	SourcePreparationDependencies,
} from "../../src/plugin/SourcePreparationService";
import {
	SOURCE_TARGET_CAPACITY,
	SourceEvictionRecord,
	SourceRegistryEntry,
} from "../../src/types";

function hashText(value: string): string {
	let hash = 2166136261;
	for (let index = 0; index < value.length; index += 1) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 16777619);
	}
	return (hash >>> 0).toString(16);
}

function makeEntry(params: {
	path: string;
	sourceId: string;
	contentHash: string;
	stale?: boolean;
	lastUsedAt?: string;
}): SourceRegistryEntry {
	return {
		path: params.path,
		sourceId: params.sourceId,
		title: params.path,
		addedAt: params.lastUsedAt ?? "2026-02-25T00:00:00.000Z",
		lastUsedAt: params.lastUsedAt ?? "2026-02-25T00:00:00.000Z",
		useCount: 0,
		contentHash: params.contentHash,
		segment: "probation",
		stale: params.stale ?? false,
	};
}

function createHarness(options: {
	files?: Record<string, string>;
	existingPaths?: Set<string>;
	entries?: SourceRegistryEntry[];
	aliases?: Record<string, string>;
	remoteSourceIds?: string[];
	addSourceIds?: string[];
	deleteFailures?: Set<string>;
	evictionCandidates?: string[];
}) {
	const files = options.files ?? {};
	const existingPaths = options.existingPaths ?? new Set(Object.keys(files));
	const byPath = new Map<string, SourceRegistryEntry>();
	for (const entry of options.entries ?? []) {
		byPath.set(entry.path, { ...entry });
	}

	const bySourceId = new Map<string, string>();
	for (const [path, entry] of byPath) {
		bySourceId.set(entry.sourceId, path);
	}

	const aliases: Record<string, string> = { ...(options.aliases ?? {}) };
	const remoteSourceIds = new Set(options.remoteSourceIds ?? []);
	const addSourceIds = [...(options.addSourceIds ?? [])];
	const deleteFailures = options.deleteFailures ?? new Set<string>();
	const evictionCandidates = [...(options.evictionCandidates ?? [])];
	const markedUsed: string[] = [];
	const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
	const evictions: SourceEvictionRecord[] = [];
	let addCounter = 0;

	const resolveSourceId = (sourceId: string): string => {
		if (!sourceId) {
			return sourceId;
		}
		const seen = new Set<string>();
		let current = sourceId;
		while (!seen.has(current)) {
			seen.add(current);
			const next = aliases[current];
			if (!next || next === current) {
				return current;
			}
			current = next;
		}
		return current;
	};

	const deps: SourcePreparationDependencies = {
		remoteSourceIds,
		callTool: async <T>(name: string, args: Record<string, unknown>) => {
			calls.push({ name, args });
			if (name === "source_add") {
				addCounter += 1;
				const sourceId = addSourceIds.shift() ?? `source-added-${addCounter}`;
				return { source_id: sourceId } as T;
			}
			if (name === "source_delete") {
				const sourceId = typeof args.source_id === "string" ? args.source_id : "";
				if (deleteFailures.has(sourceId)) {
					throw new Error(`delete failed for ${sourceId}`);
				}
				return { status: "success" } as T;
			}
			throw new Error(`Unsupported tool call in harness: ${name}`);
		},
		ensureToolSuccess: (toolName: string, toolResult: unknown) => {
			const record = toolResult as Record<string, unknown>;
			if (record?.status === "error") {
				throw new Error(`${toolName} failed`);
			}
		},
		extractSourceId: (toolResult: unknown) => {
			const record = toolResult as Record<string, unknown>;
			return typeof record.source_id === "string" ? record.source_id : null;
		},
		getToolFailure: (toolResult: unknown) => {
			const record = toolResult as Record<string, unknown>;
			if (typeof record.error === "string") {
				return record.error;
			}
			if (record.status === "error") {
				return "error";
			}
			return null;
		},
		resolveSourceId,
		getSourceEntryByPath: (path: string) => byPath.get(path) ?? null,
		upsertSource: ({ path, sourceId, title, contentHash }) => {
			const existingForPath = byPath.get(path);
			if (existingForPath && existingForPath.sourceId !== sourceId) {
				bySourceId.delete(existingForPath.sourceId);
			}
			const existingPathForSource = bySourceId.get(sourceId);
			if (existingPathForSource && existingPathForSource !== path) {
				byPath.delete(existingPathForSource);
			}
			const nextEntry = makeEntry({
				path,
				sourceId,
				contentHash: contentHash ?? existingForPath?.contentHash ?? "",
				stale: false,
				lastUsedAt: existingForPath?.lastUsedAt,
			});
			nextEntry.title = title;
			nextEntry.useCount = existingForPath?.useCount ?? 0;
			byPath.set(path, nextEntry);
			bySourceId.set(sourceId, path);
			return nextEntry;
		},
		registerSourceAlias: (previousSourceId: string, currentSourceId: string) => {
			if (!previousSourceId || !currentSourceId) {
				return;
			}
			const resolved = resolveSourceId(currentSourceId);
			if (resolved === previousSourceId) {
				return;
			}
			aliases[previousSourceId] = resolved;
			for (const [sourceId, alias] of Object.entries(aliases)) {
				if (alias === previousSourceId) {
					aliases[sourceId] = resolved;
				}
			}
		},
		getSourceEntriesByContentHash: (contentHash: string) =>
			[...byPath.values()].filter((entry) => entry.contentHash === contentHash),
		markSourceUsed: (path: string) => {
			const entry = byPath.get(path);
			if (!entry) {
				return;
			}
			entry.useCount += 1;
			markedUsed.push(path);
		},
		getEvictionCandidatePath: () => evictionCandidates.shift() ?? null,
		removeSourceByPath: (path: string) => {
			const entry = byPath.get(path) ?? null;
			if (!entry) {
				return null;
			}
			byPath.delete(path);
			bySourceId.delete(entry.sourceId);
			return entry;
		},
		readMarkdown: async (path: string) => {
			if (!existingPaths.has(path)) {
				return null;
			}
			return files[path] ?? null;
		},
		pathExists: (path: string) => existingPaths.has(path),
		hashText,
		logDebug: () => {},
		logWarn: () => {},
	};

	return {
		deps,
		evictions,
		calls,
		markedUsed,
		byPath,
		aliases,
		remoteSourceIds,
	};
}

test("covers reuse/replace/rename/new branches and skips missing paths", async () => {
	const harness = createHarness({
		files: {
			"reuse.md": "same-content",
			"replace.md": "replace-new-content",
			"rename-new.md": "rename-content",
			"new.md": "fresh-content",
		},
		existingPaths: new Set(["reuse.md", "replace.md", "rename-new.md", "new.md"]),
		entries: [
			makeEntry({ path: "reuse.md", sourceId: "source-reuse", contentHash: hashText("same-content") }),
			makeEntry({ path: "replace.md", sourceId: "source-replace-old", contentHash: hashText("replace-old") }),
			makeEntry({ path: "rename-old.md", sourceId: "source-rename", contentHash: hashText("rename-content") }),
		],
		remoteSourceIds: ["source-reuse", "source-replace-old", "source-rename"],
		addSourceIds: ["source-replace-new", "source-new"],
	});

	const result = await ensureSourcesForPaths(
		{
			notebookId: "nb-1",
			paths: ["reuse.md", "replace.md", "rename-new.md", "new.md", "missing.md"],
			evictions: harness.evictions,
			protectedCapacity: 10,
		},
		harness.deps,
	);

	assert.equal(result["reuse.md"], "source-reuse");
	assert.equal(result["replace.md"], "source-replace-new");
	assert.equal(result["rename-new.md"], "source-rename");
	assert.equal(result["new.md"], "source-new");
	assert.equal(result["missing.md"], undefined);

	assert.equal(harness.aliases["source-replace-old"], "source-replace-new");
	assert.deepEqual(
		new Set(harness.markedUsed),
		new Set(["reuse.md", "replace.md", "rename-new.md", "new.md"]),
	);
	assert.equal(harness.markedUsed.includes("missing.md"), false);
});

test("replace path uploads first and continues when old source delete fails", async () => {
	const harness = createHarness({
		files: {
			"replace.md": "replace-new-content",
		},
		existingPaths: new Set(["replace.md"]),
		entries: [
			makeEntry({ path: "replace.md", sourceId: "source-old", contentHash: hashText("replace-old") }),
		],
		remoteSourceIds: ["source-old"],
		addSourceIds: ["source-new"],
		deleteFailures: new Set(["source-old"]),
	});

	const result = await ensureSourcesForPaths(
		{
			notebookId: "nb-1",
			paths: ["replace.md"],
			evictions: harness.evictions,
			protectedCapacity: 10,
		},
		harness.deps,
	);

	assert.equal(result["replace.md"], "source-new");
	assert.equal(harness.aliases["source-old"], "source-new");
	assert.equal(harness.remoteSourceIds.has("source-new"), true);
	assert.equal(harness.remoteSourceIds.has("source-old"), true);
	assert.equal(harness.calls[0]?.name, "source_add");
	assert.equal(harness.calls[1]?.name, "source_delete");
});

test("uses remote source size for capacity checks and fails if no eviction candidate exists", async () => {
	const fullRemoteIds = Array.from({ length: SOURCE_TARGET_CAPACITY }, (_, index) => `remote-${index}`);
	const harness = createHarness({
		files: {
			"new.md": "fresh-content",
		},
		existingPaths: new Set(["new.md"]),
		remoteSourceIds: fullRemoteIds,
		evictionCandidates: [],
	});

	await assert.rejects(
		() =>
			ensureSourcesForPaths(
				{
					notebookId: "nb-1",
					paths: ["new.md"],
					evictions: harness.evictions,
					protectedCapacity: 10,
				},
				harness.deps,
			),
		/source capacity reached/i,
	);
});

test("evicts managed candidate when remote size is at capacity", async () => {
	const fullRemoteIds = Array.from({ length: SOURCE_TARGET_CAPACITY - 1 }, (_, index) => `remote-${index}`);
	const harness = createHarness({
		files: {
			"new.md": "fresh-content",
		},
		existingPaths: new Set(["new.md"]),
		entries: [makeEntry({ path: "managed.md", sourceId: "managed-source", contentHash: "hash-managed" })],
		remoteSourceIds: [...fullRemoteIds, "managed-source"],
		evictionCandidates: ["managed.md"],
		addSourceIds: ["source-new"],
	});

	const result = await ensureSourcesForPaths(
		{
			notebookId: "nb-1",
			paths: ["new.md"],
			evictions: harness.evictions,
			protectedCapacity: 10,
		},
		harness.deps,
	);

	assert.equal(result["new.md"], "source-new");
	assert.equal(harness.evictions.length, 1);
	assert.equal(harness.evictions[0]?.path, "managed.md");
	assert.equal(harness.calls[0]?.name, "source_delete");
	assert.equal(harness.calls[1]?.name, "source_add");
});
