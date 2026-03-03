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
	explicitSelectedCount?: number;
	manualExternalSelectedCount?: number;
	newlyPreparedCount: number;
	reusedFromSelectionCount: number;
	carriedFromHistoryCount: number;
	totalQuerySourceCount: number;
}

export type ResearchCommandKind = "link" | "links" | "research-fast" | "research-deep";

export type ResearchCommandParseResult =
	| {
			kind: "none";
	  }
	| {
			kind: "invalid";
			error: string;
	  }
	| {
			kind: "link";
			url: string;
			isYouTube: boolean;
	  }
	| {
			kind: "links";
			urls: string[];
	  }
	| {
			kind: "research-fast";
			query: string;
	  }
	| {
			kind: "research-deep";
			query: string;
	  };

export type AddFilePathMode = "markdown" | "all";

export type AddFilePathSelectionKind = "file" | "path";

export interface AddFilePathSearchItem {
	kind: AddFilePathSelectionKind;
	path: string;
	name: string;
	parentPath: string;
	extension?: string;
	subfileCount: number;
}

export interface ComposerSelectionItem {
	id: string;
	kind: AddFilePathSelectionKind;
	mode: AddFilePathMode;
	path: string;
	label: string;
	filePaths: string[];
	subfileCount: number;
}

export interface ComposerSelectionUploadStatus {
	state: "idle" | "uploading" | "complete";
	total: number;
	completed: number;
	percent: number;
}

export interface ResolveComposerSelectionResult {
	selection: ComposerSelectionItem | null;
	warning?: string;
	error?: string;
}

export interface ExplicitSelectionMetadata {
	kind: AddFilePathSelectionKind;
	mode: AddFilePathMode;
	path: string;
	resolvedPaths: string[];
	subfileCount: number;
}

export interface ConversationQueryMetadata {
	at: string;
	bm25Selection: BM25SelectionMetadata;
	explicitSelections?: ExplicitSelectionMetadata[];
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

export type NotebookResearchStatus = "loading" | "ready" | "no_research" | "error";

export type ResearchLinkKind = "url" | "youtube";

export interface NotebookResearchSourceItem {
	sourceId: string;
	title: string;
	url?: string;
	sourceType?: string;
}

export interface NotebookResearchRecord {
	id: string;
	kind: ResearchCommandKind;
	status: NotebookResearchStatus;
	query: string;
	links: string[];
	sourceItems: NotebookResearchSourceItem[];
	report?: string;
	error?: string;
	notebookId: string | null;
	startTaskId?: string;
	taskId?: string;
	createdAt: string;
	updatedAt: string;
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
	searchWithExplicitSelections: boolean;
}

export interface NotebookLMPluginData {
	settings: NotebookLMPluginSettings;
	sourceRegistry: SourceRegistryState;
	bm25Index: BM25CachedIndexState | null;
	conversationHistory: ConversationRecord[];
	researchRecords: NotebookResearchRecord[];
	researchSourceIndex: Record<string, string>;
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
	kind: "local" | ResearchCommandKind;
	researchRecordId?: string;
}

export interface ResearchOperationProgress {
	total: number;
	completed: number;
	percent: number;
}

export interface ResearchOperationView {
	id: string;
	recordId: string;
	kind: ResearchCommandKind;
	status: NotebookResearchStatus;
	dismissed: boolean;
	query: string;
	links: string[];
	sourceItems: NotebookResearchSourceItem[];
	report?: string;
	error?: string;
	linkKind?: ResearchLinkKind;
	progress: ResearchOperationProgress;
	createdAt: string;
	updatedAt: string;
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
	queryTimeoutSeconds: 300,
	searchWithExplicitSelections: true,
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
	researchRecords: [],
	researchSourceIndex: {},
};
