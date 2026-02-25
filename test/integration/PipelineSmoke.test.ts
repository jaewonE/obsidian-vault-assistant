import assert from "node:assert/strict";
import test from "node:test";
import { BM25 } from "../../src/search/BM25";
import { ensureSourcesForPaths } from "../../src/plugin/SourcePreparationService";
import { PluginDataStore } from "../../src/storage/PluginDataStore";
import type { ConversationRecord } from "../../src/types";

class SilentLogger {
	debug(): void {}
	info(): void {}
	warn(): void {}
	error(): void {}
}

class InMemoryPersistence {
	data: unknown = null;
	async loadData(): Promise<unknown> {
		return this.data;
	}
	async saveData(data: unknown): Promise<void> {
		this.data = data;
	}
}

function hashText(value: string): string {
	let hash = 2166136261;
	for (let index = 0; index < value.length; index += 1) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 16777619);
	}
	return (hash >>> 0).toString(16);
}

test("pipeline smoke: bm25 selection -> source preparation -> persisted metadata", async () => {
	const docs = {
		"algorithms/heapsort.md": "Heapsort is a sorting algorithm.",
		"algorithms/quicksort.md": "Quicksort uses partitioning.",
	};
	const files = Object.entries(docs).map(([path, content]) => ({
		path,
		stat: { mtime: 1, size: content.length },
	}));
	const app = {
		vault: {
			getMarkdownFiles() {
				return files;
			},
			async cachedRead(file: { path: string }) {
				return docs[file.path as keyof typeof docs] ?? "";
			},
		},
	};
	const bm25 = new BM25(app as never, new SilentLogger() as never);
	const bm25Result = await bm25.search("heapsort", {
		topN: 15,
		cutoffRatio: 0.4,
		minK: 3,
		k1: 1.2,
		b: 0.75,
	});
	assert.equal(bm25Result.selected.length > 0, true);

	const persistence = new InMemoryPersistence();
	const store = new PluginDataStore(persistence);
	await store.load();

	const remoteSourceIds = new Set<string>();
	const createdSourceIds: string[] = [];
	const evictions = [];
	const pathToSourceId = await ensureSourcesForPaths(
		{
			notebookId: "nb-smoke",
			paths: bm25Result.selected.map((item) => item.path),
			evictions,
			protectedCapacity: 10,
		},
		{
			remoteSourceIds,
			callTool: async (name, args) => {
				if (name !== "source_add") {
					throw new Error(`Unexpected tool call: ${name}`);
				}
				const sourceId = `source-${createdSourceIds.length + 1}`;
				createdSourceIds.push(sourceId);
				return { source_id: sourceId, args };
			},
			ensureToolSuccess: () => {},
			extractSourceId: (result) => {
				const record = result as Record<string, unknown>;
				return typeof record.source_id === "string" ? record.source_id : null;
			},
			getToolFailure: () => null,
			resolveSourceId: (sourceId) => store.resolveSourceId(sourceId),
			getSourceEntryByPath: (path) => store.getSourceEntryByPath(path),
			upsertSource: (params) => store.upsertSource(params),
			registerSourceAlias: (previous, current) => store.registerSourceAlias(previous, current),
			getSourceEntriesByContentHash: (contentHash) => store.getSourceEntriesByContentHash(contentHash),
			markSourceUsed: (path, protectedCap) => store.markSourceUsed(path, protectedCap),
			getEvictionCandidatePath: () => store.getEvictionCandidatePath(),
			removeSourceByPath: (path) => store.removeSourceByPath(path),
			readSourceContent: async (path) => docs[path as keyof typeof docs] ?? null,
			pathExists: (path) => path in docs,
			hashText,
			logDebug: () => {},
			logWarn: () => {},
		},
	);

	const conversation: ConversationRecord = store.createConversation("nb-smoke");
	conversation.messages.push({
		role: "user",
		text: "heapsort",
		at: new Date().toISOString(),
	});
	conversation.messages.push({
		role: "assistant",
		text: "answer",
		at: new Date().toISOString(),
	});
	conversation.queryMetadata.push({
		at: new Date().toISOString(),
		bm25Selection: {
			query: "heapsort",
			topN: 15,
			cutoffRatio: 0.4,
			minK: 3,
			top15: bm25Result.topResults.map((item) => ({ path: item.path, score: item.score })),
			selected: bm25Result.selected.map((item) => ({
				path: item.path,
				score: item.score,
				sourceId: pathToSourceId[item.path],
			})),
		},
		selectedSourceIds: bm25Result.selected
			.map((item) => pathToSourceId[item.path])
			.filter((value): value is string => typeof value === "string"),
		evictions,
	});
	store.saveConversation(conversation);
	await store.save();

	const reloaded = new PluginDataStore(persistence);
	await reloaded.load();
	const savedConversation = reloaded.getConversationById(conversation.id);
	assert.ok(savedConversation);
	assert.equal(savedConversation?.queryMetadata.length, 1);
	assert.equal(savedConversation?.queryMetadata[0]?.selectedSourceIds.length, createdSourceIds.length);
	for (const sourceId of createdSourceIds) {
		const sourcePath = reloaded.getSourcePathById(sourceId);
		assert.ok(sourcePath);
	}
});
