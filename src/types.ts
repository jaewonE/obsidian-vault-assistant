export type ChatRole = "user" | "assistant";

export interface ConversationMessage {
	role: ChatRole;
	text: string;
	at: string;
}

export interface ScoredPath {
	path: string;
	score: number;
	sourceId?: string;
}

export interface BM25SelectionMetadata {
	query: string;
	topN: number;
	cutoffRatio: number;
	minK: number;
	top15: ScoredPath[];
	selected: ScoredPath[];
}

export interface SourceEvictionRecord {
	path: string;
	sourceId: string;
	evictedAt: string;
	reason: string;
}

export interface QuerySourceSummary {
	bm25SelectedCount: number;
	newlyPreparedCount: number;
	reusedFromSelectionCount: number;
	carriedFromHistoryCount: number;
	totalQuerySourceCount: number;
}

export interface ConversationQueryMetadata {
	at: string;
	bm25Selection: BM25SelectionMetadata;
	selectedSourceIds: string[];
	evictions: SourceEvictionRecord[];
	sourceSummary?: QuerySourceSummary;
	errors?: string[];
}

export interface ConversationRecord {
	id: string;
	createdAt: string;
	updatedAt: string;
	notebookId: string | null;
	notebookConversationId?: string;
	messages: ConversationMessage[];
	queryMetadata: ConversationQueryMetadata[];
	errors?: string[];
}

export type SourceSegment = "probation" | "protected";

export interface SourceRegistryEntry {
	path: string;
	sourceId: string;
	title: string;
	addedAt: string;
	lastUsedAt: string;
	useCount: number;
	contentHash?: string;
	segment: SourceSegment;
	stale: boolean;
}

export interface SourceRegistryState {
	byPath: Record<string, SourceRegistryEntry>;
	bySourceId: Record<string, string>;
	sourceIdAliases: Record<string, string>;
	probation: string[];
	protected: string[];
}

export interface BM25CachedDocumentState {
	path: string;
	length: number;
	mtime: number;
	size: number;
	termFreq: Record<string, number>;
}

export interface BM25CachedIndexState {
	schemaVersion: number;
	averageDocumentLength: number;
	updatedAt: string;
	documents: Record<string, BM25CachedDocumentState>;
}

export interface NotebookLMPluginSettings {
	debugMode: boolean;
	notebookId: string | null;
	bm25TopN: number;
	bm25CutoffRatio: number;
	bm25MinSourcesK: number;
	bm25k1: number;
	bm25b: number;
	queryTimeoutSeconds: number;
}

export interface NotebookLMPluginData {
	settings: NotebookLMPluginSettings;
	sourceRegistry: SourceRegistryState;
	bm25Index: BM25CachedIndexState | null;
	conversationHistory: ConversationRecord[];
}

export type QueryProgressStepState = "pending" | "active" | "done" | "failed";

export interface QueryUploadProgress {
	total: number;
	currentIndex: number;
	currentPath: string | null;
	uploadedCount: number;
	reusedCount: number;
}

export interface QueryProgressState {
	steps: {
		search: QueryProgressStepState;
		upload: QueryProgressStepState;
		response: QueryProgressStepState;
	};
	searchDetail: string;
	uploadDetail: string;
	responseDetail: string;
	upload: QueryUploadProgress;
}

export interface QuerySourceItem {
	sourceId: string;
	path: string;
	title: string;
}

export const MAX_NOTEBOOK_SOURCES = 300;
export const SOURCE_HEADROOM = 10;
export const SOURCE_TARGET_CAPACITY = MAX_NOTEBOOK_SOURCES - SOURCE_HEADROOM;

export const DEFAULT_SETTINGS: NotebookLMPluginSettings = {
	debugMode: false,
	notebookId: null,
	bm25TopN: 15,
	bm25CutoffRatio: 0.4,
	bm25MinSourcesK: 3,
	bm25k1: 1.2,
	bm25b: 0.75,
	queryTimeoutSeconds: 120,
};

export const DEFAULT_SOURCE_REGISTRY: SourceRegistryState = {
	byPath: {},
	bySourceId: {},
	sourceIdAliases: {},
	probation: [],
	protected: [],
};

export const DEFAULT_PLUGIN_DATA: NotebookLMPluginData = {
	settings: DEFAULT_SETTINGS,
	sourceRegistry: DEFAULT_SOURCE_REGISTRY,
	bm25Index: null,
	conversationHistory: [],
};
