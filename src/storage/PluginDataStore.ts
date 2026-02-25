import {
	BM25SelectionMetadata,
	ConversationQueryMetadata,
	ConversationRecord,
	DEFAULT_PLUGIN_DATA,
	DEFAULT_SETTINGS,
	NotebookLMPluginData,
	NotebookLMPluginSettings,
	QuerySourceSummary,
	SourceRegistryEntry,
	SourceSegment,
} from "../types";

interface DataPersistence {
	loadData(): Promise<unknown>;
	saveData(data: unknown): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function getString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function getNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function getBoolean(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function cloneDefaults(): NotebookLMPluginData {
	return {
		settings: { ...DEFAULT_PLUGIN_DATA.settings },
		sourceRegistry: {
			byPath: {},
			bySourceId: {},
			probation: [],
			protected: [],
		},
		conversationHistory: [],
	};
}

function normalizeSettings(rawSettings: unknown): NotebookLMPluginSettings {
	if (!isRecord(rawSettings)) {
		return { ...DEFAULT_SETTINGS };
	}

	return {
		debugMode: getBoolean(rawSettings.debugMode) ?? DEFAULT_SETTINGS.debugMode,
		notebookId: getString(rawSettings.notebookId) ?? DEFAULT_SETTINGS.notebookId,
		bm25TopN: getNumber(rawSettings.bm25TopN) ?? DEFAULT_SETTINGS.bm25TopN,
		bm25CutoffRatio: getNumber(rawSettings.bm25CutoffRatio) ?? DEFAULT_SETTINGS.bm25CutoffRatio,
		bm25MinSourcesK: getNumber(rawSettings.bm25MinSourcesK) ?? DEFAULT_SETTINGS.bm25MinSourcesK,
		bm25k1: getNumber(rawSettings.bm25k1) ?? DEFAULT_SETTINGS.bm25k1,
		bm25b: getNumber(rawSettings.bm25b) ?? DEFAULT_SETTINGS.bm25b,
		queryTimeoutSeconds: getNumber(rawSettings.queryTimeoutSeconds) ?? DEFAULT_SETTINGS.queryTimeoutSeconds,
	};
}

function normalizeSourceEntry(path: string, rawEntry: unknown): SourceRegistryEntry | null {
	if (!isRecord(rawEntry)) {
		return null;
	}

	const sourceId = getString(rawEntry.sourceId);
	if (!sourceId) {
		return null;
	}

	const segmentValue = getString(rawEntry.segment);
	const segment: SourceSegment = segmentValue === "protected" ? "protected" : "probation";
	const now = new Date().toISOString();

	return {
		path,
		sourceId,
		title: getString(rawEntry.title) ?? path,
		addedAt: getString(rawEntry.addedAt) ?? now,
		lastUsedAt: getString(rawEntry.lastUsedAt) ?? now,
		useCount: getNumber(rawEntry.useCount) ?? 0,
		contentHash: getString(rawEntry.contentHash),
		segment,
		stale: getBoolean(rawEntry.stale) ?? false,
	};
}

function normalizeScoredPathArray(value: unknown): BM25SelectionMetadata["selected"] {
	const rawList = Array.isArray(value) ? value : [];
	return rawList
		.map((item) => {
			if (!isRecord(item)) {
				return null;
			}

			const path = getString(item.path);
			const score = getNumber(item.score);
			if (!path || score === undefined) {
				return null;
			}

			const sourceId = getString(item.sourceId);
			if (sourceId) {
				return { path, score, sourceId };
			}

			return { path, score };
		})
		.filter((item): item is BM25SelectionMetadata["selected"][number] => item !== null);
}

function normalizeQueryMetadata(value: unknown): ConversationQueryMetadata | null {
	if (!isRecord(value)) {
		return null;
	}

	const at = getString(value.at);
	const bm25SelectionRaw = isRecord(value.bm25Selection) ? value.bm25Selection : null;
	if (!at || !bm25SelectionRaw) {
		return null;
	}

	const query = getString(bm25SelectionRaw.query);
	const topN = getNumber(bm25SelectionRaw.topN);
	const cutoffRatio = getNumber(bm25SelectionRaw.cutoffRatio);
	const minK = getNumber(bm25SelectionRaw.minK);
	if (!query || topN === undefined || cutoffRatio === undefined || minK === undefined) {
		return null;
	}

	const top15 = normalizeScoredPathArray(bm25SelectionRaw.top15);
	const selected = normalizeScoredPathArray(bm25SelectionRaw.selected);
	const selectedSourceIdsRaw = Array.isArray(value.selectedSourceIds) ? value.selectedSourceIds : [];
	const evictionsRaw = Array.isArray(value.evictions) ? value.evictions : [];
	const sourceSummaryRaw = isRecord(value.sourceSummary) ? value.sourceSummary : null;
	let sourceSummary: QuerySourceSummary | undefined;
	if (sourceSummaryRaw) {
		const bm25SelectedCount = getNumber(sourceSummaryRaw.bm25SelectedCount);
		const newlyPreparedCount = getNumber(sourceSummaryRaw.newlyPreparedCount);
		const reusedFromSelectionCount = getNumber(sourceSummaryRaw.reusedFromSelectionCount);
		const carriedFromHistoryCount = getNumber(sourceSummaryRaw.carriedFromHistoryCount);
		const totalQuerySourceCount = getNumber(sourceSummaryRaw.totalQuerySourceCount);
		if (
			bm25SelectedCount !== undefined &&
			newlyPreparedCount !== undefined &&
			reusedFromSelectionCount !== undefined &&
			carriedFromHistoryCount !== undefined &&
			totalQuerySourceCount !== undefined
		) {
			sourceSummary = {
				bm25SelectedCount,
				newlyPreparedCount,
				reusedFromSelectionCount,
				carriedFromHistoryCount,
				totalQuerySourceCount,
			};
		}
	}

	return {
		at,
		bm25Selection: {
			query,
			topN,
			cutoffRatio,
			minK,
			top15,
			selected,
		},
		selectedSourceIds: selectedSourceIdsRaw.filter((item): item is string => typeof item === "string"),
		evictions: evictionsRaw
			.map((item) => {
				if (!isRecord(item)) {
					return null;
				}

				const path = getString(item.path);
				const sourceId = getString(item.sourceId);
				const evictedAt = getString(item.evictedAt);
				const reason = getString(item.reason);
				if (!path || !sourceId || !evictedAt || !reason) {
					return null;
				}

				return { path, sourceId, evictedAt, reason };
			})
			.filter((item): item is ConversationQueryMetadata["evictions"][number] => item !== null),
		errors: Array.isArray(value.errors)
			? value.errors.filter((item): item is string => typeof item === "string")
			: undefined,
		sourceSummary,
	};
}

function normalizeConversationRecord(rawConversation: unknown): ConversationRecord | null {
	if (!isRecord(rawConversation)) {
		return null;
	}

	const id = getString(rawConversation.id);
	const createdAt = getString(rawConversation.createdAt);
	const updatedAt = getString(rawConversation.updatedAt);
	if (!id || !createdAt || !updatedAt) {
		return null;
	}

	const messagesRaw = Array.isArray(rawConversation.messages) ? rawConversation.messages : [];
	const messages = messagesRaw
		.map((message) => {
			if (!isRecord(message)) {
				return null;
			}

			const role = getString(message.role);
			const text = getString(message.text);
			const at = getString(message.at);
			if (!role || (role !== "user" && role !== "assistant") || !text || !at) {
				return null;
			}

			return { role, text, at };
		})
		.filter((message): message is ConversationRecord["messages"][number] => message !== null);

	const queryMetadataRaw = Array.isArray(rawConversation.queryMetadata) ? rawConversation.queryMetadata : [];
	const queryMetadata = queryMetadataRaw
		.map((item) => normalizeQueryMetadata(item))
		.filter((item): item is ConversationRecord["queryMetadata"][number] => item !== null);

	return {
		id,
		createdAt,
		updatedAt,
		notebookId: getString(rawConversation.notebookId) ?? null,
		notebookConversationId: getString(rawConversation.notebookConversationId),
		messages,
		queryMetadata,
		errors: Array.isArray(rawConversation.errors)
			? rawConversation.errors.filter((item): item is string => typeof item === "string")
			: undefined,
	};
}

function generateConversationId(): string {
	if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
		return crypto.randomUUID();
	}

	return `conv-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export class PluginDataStore {
	private data: NotebookLMPluginData = cloneDefaults();
	private readonly persistence: DataPersistence;

	constructor(persistence: DataPersistence) {
		this.persistence = persistence;
	}

	async load(): Promise<void> {
		const raw = await this.persistence.loadData();
		if (!isRecord(raw)) {
			this.data = cloneDefaults();
			return;
		}

		const loaded = cloneDefaults();
		loaded.settings = normalizeSettings(raw.settings);

		const sourceRegistryRaw = isRecord(raw.sourceRegistry) ? raw.sourceRegistry : {};
		const byPathRaw = isRecord(sourceRegistryRaw.byPath) ? sourceRegistryRaw.byPath : {};
		const bySourceIdRaw = isRecord(sourceRegistryRaw.bySourceId) ? sourceRegistryRaw.bySourceId : {};
		const probationRaw = Array.isArray(sourceRegistryRaw.probation) ? sourceRegistryRaw.probation : [];
		const protectedRaw = Array.isArray(sourceRegistryRaw.protected) ? sourceRegistryRaw.protected : [];

		for (const [path, rawEntry] of Object.entries(byPathRaw)) {
			const normalizedEntry = normalizeSourceEntry(path, rawEntry);
			if (!normalizedEntry) {
				continue;
			}

			loaded.sourceRegistry.byPath[path] = normalizedEntry;
			loaded.sourceRegistry.bySourceId[normalizedEntry.sourceId] = path;
		}

		for (const [sourceId, pathValue] of Object.entries(bySourceIdRaw)) {
			const path = getString(pathValue);
			if (!path || !loaded.sourceRegistry.byPath[path]) {
				continue;
			}
			loaded.sourceRegistry.bySourceId[sourceId] = path;
		}

		loaded.sourceRegistry.probation = [];
		for (const value of probationRaw) {
			const path = getString(value);
			if (!path || !loaded.sourceRegistry.byPath[path]) {
				continue;
			}
			loaded.sourceRegistry.probation.push(path);
		}

		loaded.sourceRegistry.protected = [];
		for (const value of protectedRaw) {
			const path = getString(value);
			if (!path || !loaded.sourceRegistry.byPath[path]) {
				continue;
			}
			loaded.sourceRegistry.protected.push(path);
		}

		const historyRaw = Array.isArray(raw.conversationHistory) ? raw.conversationHistory : [];
		loaded.conversationHistory = historyRaw
			.map((entry) => normalizeConversationRecord(entry))
			.filter((entry): entry is ConversationRecord => entry !== null)
			.map((entry) => ({ ...entry }));

		this.data = loaded;
		this.cleanupQueues();
	}

	async save(): Promise<void> {
		await this.persistence.saveData(this.data);
	}

	getSettings(): NotebookLMPluginSettings {
		return this.data.settings;
	}

	updateSettings(patch: Partial<NotebookLMPluginSettings>): void {
		this.data.settings = {
			...this.data.settings,
			...patch,
		};
	}

	getConversationHistory(): ConversationRecord[] {
		return [...this.data.conversationHistory].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	}

	getConversationById(conversationId: string): ConversationRecord | null {
		return this.data.conversationHistory.find((conversation) => conversation.id === conversationId) ?? null;
	}

	createConversation(notebookId: string | null): ConversationRecord {
		const now = new Date().toISOString();
		const conversation: ConversationRecord = {
			id: generateConversationId(),
			createdAt: now,
			updatedAt: now,
			notebookId,
			messages: [],
			queryMetadata: [],
		};

		this.data.conversationHistory.push(conversation);
		return conversation;
	}

	saveConversation(conversation: ConversationRecord): void {
		const index = this.data.conversationHistory.findIndex((item) => item.id === conversation.id);
		if (index >= 0) {
			this.data.conversationHistory[index] = conversation;
			return;
		}

		this.data.conversationHistory.push(conversation);
	}

	getSourceEntryByPath(path: string): SourceRegistryEntry | null {
		return this.data.sourceRegistry.byPath[path] ?? null;
	}

	getSourcePathById(sourceId: string): string | null {
		return this.data.sourceRegistry.bySourceId[sourceId] ?? null;
	}

	getActiveSourceCount(): number {
		return Object.values(this.data.sourceRegistry.byPath).filter((entry) => !entry.stale).length;
	}

	getAllSourceEntries(): SourceRegistryEntry[] {
		return Object.values(this.data.sourceRegistry.byPath);
	}

	reconcileSources(remoteSourceIds: Set<string>): void {
		for (const entry of Object.values(this.data.sourceRegistry.byPath)) {
			if (remoteSourceIds.has(entry.sourceId)) {
				entry.stale = false;
				this.data.sourceRegistry.bySourceId[entry.sourceId] = entry.path;
				continue;
			}

			entry.stale = true;
			delete this.data.sourceRegistry.bySourceId[entry.sourceId];
		}

		this.cleanupQueues();
	}

	upsertSource(params: { path: string; sourceId: string; title: string; contentHash?: string }): SourceRegistryEntry {
		const now = new Date().toISOString();
		const existingForPath = this.data.sourceRegistry.byPath[params.path];
		if (existingForPath && existingForPath.sourceId !== params.sourceId) {
			delete this.data.sourceRegistry.bySourceId[existingForPath.sourceId];
		}

		const existingPathForSource = this.data.sourceRegistry.bySourceId[params.sourceId];
		if (existingPathForSource && existingPathForSource !== params.path) {
			this.removeSourceByPath(existingPathForSource);
		}

		const nextEntry: SourceRegistryEntry = {
			path: params.path,
			sourceId: params.sourceId,
			title: params.title,
			addedAt: existingForPath?.addedAt ?? now,
			lastUsedAt: now,
			useCount: existingForPath?.useCount ?? 0,
			contentHash: params.contentHash ?? existingForPath?.contentHash,
			segment: existingForPath?.segment ?? "probation",
			stale: false,
		};

		this.data.sourceRegistry.byPath[params.path] = nextEntry;
		this.data.sourceRegistry.bySourceId[params.sourceId] = params.path;

		if (!this.isPathInQueue(params.path, "probation") && !this.isPathInQueue(params.path, "protected")) {
			this.movePathToQueueFront(params.path, "probation");
			nextEntry.segment = "probation";
		}

		this.cleanupQueues();
		return nextEntry;
	}

	markSourceUsed(path: string, protectedCap: number): void {
		const entry = this.data.sourceRegistry.byPath[path];
		if (!entry) {
			return;
		}

		entry.lastUsedAt = new Date().toISOString();
		entry.useCount += 1;
		entry.stale = false;

		if (this.isPathInQueue(path, "protected")) {
			this.movePathToQueueFront(path, "protected");
			entry.segment = "protected";
		} else if (this.isPathInQueue(path, "probation")) {
			this.removePathFromQueue(path, "probation");
			this.movePathToQueueFront(path, "protected");
			entry.segment = "protected";
		} else {
			this.movePathToQueueFront(path, "probation");
			entry.segment = "probation";
		}

		this.enforceProtectedCap(protectedCap);
	}

	getEvictionCandidatePath(): string | null {
		this.cleanupQueues();

		if (this.data.sourceRegistry.probation.length === 0 && this.data.sourceRegistry.protected.length > 0) {
			const demotedPath = this.data.sourceRegistry.protected.pop();
			if (demotedPath) {
				this.movePathToQueueFront(demotedPath, "probation");
				const entry = this.data.sourceRegistry.byPath[demotedPath];
				if (entry) {
					entry.segment = "probation";
				}
			}
		}

		const candidate = this.data.sourceRegistry.probation[this.data.sourceRegistry.probation.length - 1];
		return candidate ?? null;
	}

	removeSourceByPath(path: string): SourceRegistryEntry | null {
		const entry = this.data.sourceRegistry.byPath[path];
		if (!entry) {
			return null;
		}

		delete this.data.sourceRegistry.byPath[path];
		delete this.data.sourceRegistry.bySourceId[entry.sourceId];
		this.removePathFromQueue(path, "probation");
		this.removePathFromQueue(path, "protected");
		return entry;
	}

	private enforceProtectedCap(protectedCap: number): void {
		const safeProtectedCap = Math.max(1, protectedCap);
		while (this.data.sourceRegistry.protected.length > safeProtectedCap) {
			const demotedPath = this.data.sourceRegistry.protected.pop();
			if (!demotedPath) {
				break;
			}

			this.movePathToQueueFront(demotedPath, "probation");
			const entry = this.data.sourceRegistry.byPath[demotedPath];
			if (entry) {
				entry.segment = "probation";
			}
		}
	}

	private isPathInQueue(path: string, segment: SourceSegment): boolean {
		const queue = segment === "probation" ? this.data.sourceRegistry.probation : this.data.sourceRegistry.protected;
		return queue.includes(path);
	}

	private movePathToQueueFront(path: string, segment: SourceSegment): void {
		this.removePathFromQueue(path, "probation");
		this.removePathFromQueue(path, "protected");

		const queue = segment === "probation" ? this.data.sourceRegistry.probation : this.data.sourceRegistry.protected;
		queue.unshift(path);
	}

	private removePathFromQueue(path: string, segment: SourceSegment): void {
		const queue = segment === "probation" ? this.data.sourceRegistry.probation : this.data.sourceRegistry.protected;
		const nextQueue = queue.filter((item) => item !== path);
		if (segment === "probation") {
			this.data.sourceRegistry.probation = nextQueue;
			return;
		}

		this.data.sourceRegistry.protected = nextQueue;
	}

	private cleanupQueues(): void {
		const knownPaths = new Set(Object.keys(this.data.sourceRegistry.byPath));
		const uniqProbation: string[] = [];
		const uniqProtected: string[] = [];

		for (const path of this.data.sourceRegistry.probation) {
			if (!knownPaths.has(path) || uniqProbation.includes(path)) {
				continue;
			}
			uniqProbation.push(path);
		}

		for (const path of this.data.sourceRegistry.protected) {
			if (!knownPaths.has(path) || uniqProtected.includes(path) || uniqProbation.includes(path)) {
				continue;
			}
			uniqProtected.push(path);
		}

		this.data.sourceRegistry.probation = uniqProbation;
		this.data.sourceRegistry.protected = uniqProtected;
	}
}
