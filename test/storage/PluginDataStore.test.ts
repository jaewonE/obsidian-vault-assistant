import assert from "node:assert/strict";
import test from "node:test";
import type { BM25CachedIndexState } from "../../src/types";
import { PluginDataStore } from "../../src/storage/PluginDataStore";

class InMemoryPersistence {
	data: unknown = null;

	async loadData(): Promise<unknown> {
		return this.data;
	}

	async saveData(data: unknown): Promise<void> {
		this.data = data;
	}
}

test("resolves source id aliases transitively", async () => {
	const persistence = new InMemoryPersistence();
	const store = new PluginDataStore(persistence);
	await store.load();

	store.upsertSource({
		path: "docs/heapsort.md",
		sourceId: "source-1",
		title: "docs/heapsort.md",
		contentHash: "hash-1",
	});
	store.registerSourceAlias("source-1", "source-2");
	store.registerSourceAlias("source-2", "source-3");

	assert.equal(store.resolveSourceId("source-1"), "source-3");
	assert.equal(store.resolveSourceId("source-2"), "source-3");
});

test("getSourcePathById resolves alias ids", async () => {
	const persistence = new InMemoryPersistence();
	const store = new PluginDataStore(persistence);
	await store.load();

	store.upsertSource({
		path: "docs/heapsort.md",
		sourceId: "source-new",
		title: "docs/heapsort.md",
		contentHash: "hash-1",
	});
	store.registerSourceAlias("source-old", "source-new");

	assert.equal(store.getSourcePathById("source-old"), "docs/heapsort.md");
});

test("upsertSource remaps path for same source id (rename case)", async () => {
	const persistence = new InMemoryPersistence();
	const store = new PluginDataStore(persistence);
	await store.load();

	store.upsertSource({
		path: "old/heapsort.md",
		sourceId: "source-1",
		title: "old/heapsort.md",
		contentHash: "hash-1",
	});
	store.upsertSource({
		path: "new/heapsort.md",
		sourceId: "source-1",
		title: "new/heapsort.md",
		contentHash: "hash-1",
	});

	assert.equal(store.getSourceEntryByPath("old/heapsort.md"), null);
	assert.equal(store.getSourceEntryByPath("new/heapsort.md")?.sourceId, "source-1");
});

test("renameSourcePath moves source mapping and preserves source id", async () => {
	const persistence = new InMemoryPersistence();
	const store = new PluginDataStore(persistence);
	await store.load();

	store.upsertSource({
		path: "old/heapsort.md",
		sourceId: "source-1",
		title: "old/heapsort.md",
		contentHash: "hash-1",
	});

	const renamed = store.renameSourcePath("old/heapsort.md", "new/heapsort.md");
	assert.equal(renamed?.sourceId, "source-1");
	assert.equal(store.getSourceEntryByPath("old/heapsort.md"), null);
	assert.equal(store.getSourcePathById("source-1"), "new/heapsort.md");
});

test("can fetch source entries by content hash", async () => {
	const persistence = new InMemoryPersistence();
	const store = new PluginDataStore(persistence);
	await store.load();

	store.upsertSource({
		path: "a.md",
		sourceId: "s-a",
		title: "a.md",
		contentHash: "same-hash",
	});
	store.upsertSource({
		path: "b.md",
		sourceId: "s-b",
		title: "b.md",
		contentHash: "same-hash",
	});

	const entries = store.getSourceEntriesByContentHash("same-hash");
	assert.equal(entries.length, 2);
});

test("replacement alias chain keeps old source ids resolvable to latest source", async () => {
	const persistence = new InMemoryPersistence();
	const store = new PluginDataStore(persistence);
	await store.load();

	store.upsertSource({
		path: "docs/heapsort.md",
		sourceId: "source-v1",
		title: "docs/heapsort.md",
		contentHash: "hash-v1",
	});

	store.upsertSource({
		path: "docs/heapsort.md",
		sourceId: "source-v2",
		title: "docs/heapsort.md",
		contentHash: "hash-v2",
	});
	store.registerSourceAlias("source-v1", "source-v2");

	store.upsertSource({
		path: "docs/heapsort.md",
		sourceId: "source-v3",
		title: "docs/heapsort.md",
		contentHash: "hash-v3",
	});
	store.registerSourceAlias("source-v2", "source-v3");

	assert.equal(store.resolveSourceId("source-v1"), "source-v3");
	assert.equal(store.getSourcePathById("source-v1"), "docs/heapsort.md");
});

test("old source id resolves to renamed and updated source after persistence reload", async () => {
	const persistence = new InMemoryPersistence();
	const store = new PluginDataStore(persistence);
	await store.load();

	store.upsertSource({
		path: "old/heapsort.md",
		sourceId: "source-v1",
		title: "old/heapsort.md",
		contentHash: "hash-v1",
	});
	store.renameSourcePath("old/heapsort.md", "new/heapsort.md");
	store.upsertSource({
		path: "new/heapsort.md",
		sourceId: "source-v2",
		title: "new/heapsort.md",
		contentHash: "hash-v2",
	});
	store.registerSourceAlias("source-v1", "source-v2");
	await store.save();

	const reloaded = new PluginDataStore(persistence);
	await reloaded.load();

	assert.equal(reloaded.resolveSourceId("source-v1"), "source-v2");
	assert.equal(reloaded.getSourcePathById("source-v1"), "new/heapsort.md");
});

test("stores and restores bm25 cached index state", async () => {
	const persistence = new InMemoryPersistence();
	const store = new PluginDataStore(persistence);
	await store.load();

	const bm25Index: BM25CachedIndexState = {
		schemaVersion: 1,
		averageDocumentLength: 12,
		updatedAt: new Date().toISOString(),
		documents: {
			"docs/heapsort.md": {
				path: "docs/heapsort.md",
				length: 12,
				mtime: 100,
				size: 200,
				termFreq: { heapsort: 3 },
			},
		},
	};
	store.setBM25Index(bm25Index);
	await store.save();

	const nextStore = new PluginDataStore(persistence);
	await nextStore.load();
	assert.equal(nextStore.getBM25Index()?.documents["docs/heapsort.md"]?.termFreq.heapsort, 3);
});

test("reconcileSources keeps aliased source active when resolved id exists remotely", async () => {
	const persistence = new InMemoryPersistence();
	const now = new Date().toISOString();
	persistence.data = {
		settings: {},
		sourceRegistry: {
			byPath: {
				"docs/heapsort.md": {
					path: "docs/heapsort.md",
					sourceId: "source-old",
					title: "docs/heapsort.md",
					addedAt: now,
					lastUsedAt: now,
					useCount: 1,
					contentHash: "hash-1",
					segment: "probation",
					stale: false,
				},
			},
			bySourceId: {
				"source-old": "docs/heapsort.md",
			},
			sourceIdAliases: {
				"source-old": "source-new",
			},
			probation: ["docs/heapsort.md"],
			protected: [],
		},
		conversationHistory: [],
		bm25Index: null,
	};

	const store = new PluginDataStore(persistence);
	await store.load();
	store.reconcileSources(new Set(["source-new"]));

	const entry = store.getSourceEntryByPath("docs/heapsort.md");
	assert.equal(entry?.stale, false);
	assert.equal(entry?.sourceId, "source-new");
	assert.equal(store.getSourcePathById("source-old"), "docs/heapsort.md");
});

test("normalizes out-of-range settings values from persisted data", async () => {
	const persistence = new InMemoryPersistence();
	persistence.data = {
		settings: {
			bm25TopN: -100,
			bm25CutoffRatio: 5,
			bm25MinSourcesK: 0.1,
			bm25k1: -2,
			bm25b: -1,
			queryTimeoutSeconds: 0,
		},
		sourceRegistry: {},
		conversationHistory: [],
		bm25Index: null,
	};

	const store = new PluginDataStore(persistence);
	await store.load();

	const settings = store.getSettings();
	assert.equal(settings.bm25TopN, 1);
	assert.equal(settings.bm25CutoffRatio, 1);
	assert.equal(settings.bm25MinSourcesK, 1);
	assert.equal(settings.bm25k1, 0);
	assert.equal(settings.bm25b, 0);
	assert.equal(settings.queryTimeoutSeconds, 5);
});

test("prunes unreachable aliases while preserving resolvable aliases", async () => {
	const persistence = new InMemoryPersistence();
	const store = new PluginDataStore(persistence);
	await store.load();

	store.upsertSource({
		path: "docs/heapsort.md",
		sourceId: "source-live",
		title: "docs/heapsort.md",
		contentHash: "hash-live",
	});
	store.registerSourceAlias("source-legacy", "source-live");
	store.registerSourceAlias("source-unused-a", "source-unused-b");
	await store.save();

	const reloaded = new PluginDataStore(persistence);
	await reloaded.load();

	assert.equal(reloaded.resolveSourceId("source-legacy"), "source-live");
	assert.equal(reloaded.resolveSourceId("source-unused-a"), "source-unused-a");
});

test("compacts oversized conversation history on save/load", async () => {
	const persistence = new InMemoryPersistence();
	const now = Date.now();
	persistence.data = {
		settings: {},
		sourceRegistry: {},
		bm25Index: null,
		conversationHistory: Array.from({ length: 220 }).map((_, index) => {
			const at = new Date(now + index).toISOString();
			return {
				id: `conv-${index}`,
				createdAt: at,
				updatedAt: at,
				notebookId: null,
				messages: Array.from({ length: 420 }).map((__, mIndex) => ({
					role: mIndex % 2 === 0 ? "user" : "assistant",
					text: `message-${mIndex}`,
					at,
				})),
				queryMetadata: Array.from({ length: 250 }).map((__, qIndex) => ({
					at,
					bm25Selection: {
						query: `q-${qIndex}`,
						topN: 15,
						cutoffRatio: 0.4,
						minK: 3,
						top15: [],
						selected: [],
					},
					selectedSourceIds: [],
					evictions: [],
				})),
			};
		}),
	};

	const store = new PluginDataStore(persistence);
	await store.load();
	await store.save();

	const reloaded = new PluginDataStore(persistence);
	await reloaded.load();
	const conversations = reloaded.getConversationHistory();
	assert.equal(conversations.length, 200);
	for (const conversation of conversations) {
		assert.ok(conversation.messages.length <= 400);
		assert.ok(conversation.queryMetadata.length <= 200);
	}
});
