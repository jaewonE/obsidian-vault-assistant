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

export interface ConversationQueryMetadata {
	at: string;
	bm25Selection: BM25SelectionMetadata;
	selectedSourceIds: string[];
	evictions: SourceEvictionRecord[];
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
	probation: string[];
	protected: string[];
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
	conversationHistory: ConversationRecord[];
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
	probation: [],
	protected: [],
};

export const DEFAULT_PLUGIN_DATA: NotebookLMPluginData = {
	settings: DEFAULT_SETTINGS,
	sourceRegistry: DEFAULT_SOURCE_REGISTRY,
	conversationHistory: [],
};
