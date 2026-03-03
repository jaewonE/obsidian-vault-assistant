import { FileSystemAdapter, Notice, Plugin, TAbstractFile, TFile, WorkspaceLeaf } from "obsidian";
import { Logger } from "../logging/logger";
import { NotebookLMMcpBinaryMissingError, NotebookLMMcpClient } from "../mcp/NotebookLMMcpClient";
import { buildReusableSourceIds } from "./historySourceIds";
import { collectExplicitSelectionPaths, mergeSelectionPaths } from "./explicitSelectionMerge";
import { ensureSourcesForPaths, JsonObject, SourcePreparationProgress } from "./SourcePreparationService";
import { ExplicitSourceSelectionService } from "./ExplicitSourceSelectionService";
import {
	buildFileUploadPlan,
	buildTextUploadPlan,
	filterAllowedUploadPaths,
	getUploadMethodForPath,
	SourceUploadPlan,
} from "./sourceUploadPolicy";
import { BM25, type BM25SearchResult } from "../search/BM25";
import { PluginDataStore } from "../storage/PluginDataStore";
import {
	AddFilePathMode,
	AddFilePathSearchItem,
	AddFilePathSelectionKind,
	ComposerSelectionItem,
	ComposerSelectionUploadStatus,
	ConversationQueryMetadata,
	ConversationRecord,
	DEFAULT_SETTINGS,
	ExplicitSelectionMetadata,
	NotebookResearchRecord,
	NotebookResearchSourceItem,
	NotebookResearchStatus,
	NotebookLMPluginSettings,
	QueryProgressState,
	QuerySourceItem,
	ResearchCommandKind,
	ResearchCommandParseResult,
	ResearchLinkKind,
	ResearchOperationView,
	ResolveComposerSelectionResult,
	SOURCE_TARGET_CAPACITY,
	SourceEvictionRecord,
} from "../types";
import { ChatView } from "../ui/ChatView";
import { NOTEBOOKLM_CHAT_VIEW_TYPE } from "../ui/constants";
import { NotebookLMSettingTab } from "../ui/SettingsTab";
import { buildResearchTrackingQuery } from "./researchQuery";
import { getResearchImportIndices, trackResearchStatus } from "./researchTracking";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function getErrorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}

function parseHttpUrl(value: string | undefined): string | null {
	if (typeof value !== "string") {
		return null;
	}
	const trimmed = value.trim();
	if (!/^https?:\/\//iu.test(trimmed) || /\s/u.test(trimmed)) {
		return null;
	}
	try {
		const parsed = new URL(trimmed);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
			return null;
		}
		return trimmed;
	} catch {
		return null;
	}
}

function summarizeTokens(tokens: string[], max = 5): string {
	if (tokens.length <= max) {
		return tokens.join(", ");
	}

	const listed = tokens.slice(0, max).join(", ");
	return `${listed}, +${tokens.length - max} more`;
}

type NumericSettingKey =
	| "bm25TopN"
	| "bm25CutoffRatio"
	| "bm25MinSourcesK"
	| "bm25k1"
	| "bm25b"
	| "queryTimeoutSeconds";

const NOTEBOOK_TITLE = "Obsidian Vault Notebook";
const PROTECTED_CAPACITY_RATIO = 0.7;
const MAX_REUSABLE_HISTORY_SOURCE_IDS = 40;
const IMPORTED_SOURCE_VALIDATION_DELAYS_MS = [10_000, 20_000, 30_000] as const;

const SETTINGS_LIMITS = {
	topN: { min: 1, max: 200 },
	cutoffRatio: { min: 0, max: 1 },
	minSourcesK: { min: 1, max: 50 },
	k1: { min: 0, max: 5 },
	b: { min: 0, max: 1 },
	queryTimeoutSeconds: { min: 5, max: 600 },
} as const;

type QueryStepKey = "search" | "upload" | "response";

type ExplicitUploadPathStatus = "pending" | "checking" | "uploading" | "ready" | "failed";

interface ExplicitUploadPathState {
	status: ExplicitUploadPathStatus;
	uploaded: boolean;
	error?: string;
}

interface ExplicitUploadScopeState {
	total: number;
	completed: number;
	failed: number;
	currentPath: string | null;
	currentIndex: number;
	uploadedPaths: Set<string>;
	reusedPaths: Set<string>;
}

interface ResearchOperationState {
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
	progress: {
		total: number;
		completed: number;
		percent: number;
	};
	notebookId: string | null;
	startTaskId?: string;
	taskId?: string;
	createdAt: string;
	updatedAt: string;
}

type ExecutableResearchCommand = Exclude<ResearchCommandParseResult, { kind: "none" | "invalid" }>;

export default class NotebookLMObsidianPlugin extends Plugin {
	private store!: PluginDataStore;
	private logger!: Logger;
	private bm25!: BM25;
	private mcpClient!: NotebookLMMcpClient;
	private explicitSourceSelectionService!: ExplicitSourceSelectionService;
	private activeConversationId: string | null = null;
	private remoteSourceIds = new Set<string>();
	private queryProgress: QueryProgressState | null = null;
	private queryProgressListeners = new Set<(progress: QueryProgressState | null) => void>();
	private explicitUploadQueue: string[] = [];
	private explicitUploadState = new Map<string, ExplicitUploadPathState>();
	private explicitUploadStateListeners = new Set<() => void>();
	private explicitUploadCurrentPath: string | null = null;
	private explicitUploadWorkerPromise: Promise<void> | null = null;
	private explicitUploadUpdateWaiters = new Set<() => void>();
	private researchOperations = new Map<string, ResearchOperationState>();
	private researchOperationListeners = new Set<() => void>();
	private researchSourceFetchabilityCache = new Map<string, boolean>();
	private sourcePreparationMutex: Promise<void> = Promise.resolve();

	get settings(): NotebookLMPluginSettings {
		return this.store.getSettings();
	}

	getQueryProgress(): QueryProgressState | null {
		return this.queryProgress;
	}

	getSearchVaultEnabled(): boolean {
		return this.settings.searchWithExplicitSelections;
	}

	async setSearchVaultEnabled(enabled: boolean): Promise<void> {
		if (this.settings.searchWithExplicitSelections === enabled) {
			return;
		}
		this.store.updateSettings({ searchWithExplicitSelections: enabled });
		await this.store.save();
	}

	onQueryProgressChange(listener: (progress: QueryProgressState | null) => void): () => void {
		this.queryProgressListeners.add(listener);
		listener(this.queryProgress);
		return () => {
			this.queryProgressListeners.delete(listener);
		};
	}

	onExplicitUploadStateChange(listener: () => void): () => void {
		this.explicitUploadStateListeners.add(listener);
		listener();
		return () => {
			this.explicitUploadStateListeners.delete(listener);
		};
	}

	onResearchOperationChange(listener: () => void): () => void {
		this.researchOperationListeners.add(listener);
		listener();
		return () => {
			this.researchOperationListeners.delete(listener);
		};
	}

	async onload(): Promise<void> {
		this.store = new PluginDataStore(this);
		await this.store.load();
		this.store.updateSettings({
			...DEFAULT_SETTINGS,
			...this.store.getSettings(),
		});

		this.logger = new Logger(() => this.settings.debugMode);
		this.bm25 = new BM25(this.app, this.logger);
		this.bm25.loadCachedIndex(this.store.getBM25Index());
		this.explicitSourceSelectionService = new ExplicitSourceSelectionService(this.app);
		this.mcpClient = new NotebookLMMcpClient(this.logger);

		this.registerView(
			NOTEBOOKLM_CHAT_VIEW_TYPE,
			(leaf: WorkspaceLeaf) => new ChatView(leaf, this),
		);

		this.addCommand({
			id: "open-notebooklm-chat-view",
			name: "Open NotebookLM chat",
			callback: () => {
				void this.activateChatView();
			},
		});

		this.addSettingTab(new NotebookLMSettingTab(this.app, this));
		this.registerVaultEvents();

		this.app.workspace.onLayoutReady(() => {
			void this.activateChatView();
		});

		await this.startMcpServer();

		const latestConversation = this.store.getConversationHistory()[0] ?? null;
		if (latestConversation) {
			this.activeConversationId = latestConversation.id;
		} else {
			await this.startNewConversation();
		}
	}

	onunload(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(NOTEBOOKLM_CHAT_VIEW_TYPE)) {
			leaf.detach();
		}

		void this.mcpClient.stop();
	}

	getConversationHistory(): ConversationRecord[] {
		return this.store.getConversationHistory();
	}

	getSourceItemsForIds(sourceIds: string[]): QuerySourceItem[] {
		const seen = new Set<string>();
		const seenResearchRecords = new Set<string>();
		const items: QuerySourceItem[] = [];
		for (const rawSourceId of sourceIds) {
			const sourceId = this.store.resolveSourceId(rawSourceId);
			if (!sourceId || seen.has(sourceId)) {
				continue;
			}
			seen.add(sourceId);

			const researchRecord = this.store.getResearchRecordBySourceId(sourceId);
			if (researchRecord) {
				if (seenResearchRecords.has(researchRecord.id)) {
					continue;
				}
				seenResearchRecords.add(researchRecord.id);
				items.push({
					sourceId,
					path: researchRecord.query,
					title: this.getResearchRecordDisplayTitle(researchRecord),
					kind: researchRecord.kind,
					researchRecordId: researchRecord.id,
				});
				continue;
			}

			const path = this.store.getSourcePathById(sourceId);
			if (!path) {
				continue;
			}

			items.push({
				sourceId,
				path,
				title: this.getFileTitleFromPath(path),
				kind: "local",
			});
		}

		return items;
	}

	getSourceIdsForPaths(paths: string[]): string[] {
		const sourceIds = new Set<string>();
		for (const path of paths) {
			if (!path) {
				continue;
			}
			const entry = this.store.getSourceEntryByPath(path);
			if (!entry?.sourceId) {
				continue;
			}
			const resolvedSourceId = this.store.resolveSourceId(entry.sourceId);
			if (!resolvedSourceId) {
				continue;
			}
			sourceIds.add(resolvedSourceId);
		}
		return [...sourceIds];
	}

	getResearchOperations(): ResearchOperationView[] {
		const operations = [...this.researchOperations.values()]
			.sort((left, right) => left.createdAt.localeCompare(right.createdAt))
			.map((operation) => ({
				id: operation.id,
				recordId: operation.recordId,
				kind: operation.kind,
				status: operation.status,
				dismissed: operation.dismissed,
				query: operation.query,
				links: [...operation.links],
				sourceItems: operation.sourceItems.map((item) => ({ ...item })),
				report: operation.report,
				error: operation.error,
				linkKind: operation.linkKind,
				progress: { ...operation.progress },
				createdAt: operation.createdAt,
				updatedAt: operation.updatedAt,
			}));
		return operations;
	}

	getResearchRecordById(recordId: string): NotebookResearchRecord | null {
		return this.store.getResearchRecordById(recordId);
	}

	async getResearchSourceFetchability(sourceIds: string[]): Promise<Record<string, boolean>> {
		const result: Record<string, boolean> = {};
		const dedupedInputSourceIds = [...new Set(sourceIds)]
			.filter((sourceId): sourceId is string => typeof sourceId === "string" && sourceId.length > 0);
		if (dedupedInputSourceIds.length === 0) {
			return result;
		}

		const groupedByResolvedId = new Map<string, string[]>();
		for (const inputSourceId of dedupedInputSourceIds) {
			const resolvedSourceId = this.store.resolveSourceId(inputSourceId);
			if (!resolvedSourceId) {
				result[inputSourceId] = false;
				continue;
			}
			const group = groupedByResolvedId.get(resolvedSourceId) ?? [];
			group.push(inputSourceId);
			groupedByResolvedId.set(resolvedSourceId, group);
		}
		if (groupedByResolvedId.size === 0) {
			return result;
		}

		await this.ensureMcpConnected();
		const mcpRequestTimeoutMs = this.getSafeMcpRequestTimeoutMs();
		await Promise.all(
			[...groupedByResolvedId.entries()].map(async ([resolvedSourceId, inputSourceIds]) => {
				const cached = this.researchSourceFetchabilityCache.get(resolvedSourceId);
				if (typeof cached === "boolean") {
					for (const inputSourceId of inputSourceIds) {
						result[inputSourceId] = cached;
					}
					result[resolvedSourceId] = cached;
					return;
				}

				try {
					const toolResult = await this.mcpClient.callTool<JsonObject>(
						"source_get_content",
						{ source_id: resolvedSourceId },
						{ idempotent: true, requestTimeoutMs: mcpRequestTimeoutMs },
					);
					this.ensureToolSuccess("source_get_content", toolResult);
					this.researchSourceFetchabilityCache.set(resolvedSourceId, true);
					for (const inputSourceId of inputSourceIds) {
						result[inputSourceId] = true;
					}
					result[resolvedSourceId] = true;
				} catch (error) {
					this.logger.warn(
						`Failed to retrieve research source content (${resolvedSourceId})`,
						getErrorMessage(error),
					);
					this.researchSourceFetchabilityCache.set(resolvedSourceId, false);
					for (const inputSourceId of inputSourceIds) {
						result[inputSourceId] = false;
					}
					result[resolvedSourceId] = false;
				}
			}),
		);

		return result;
	}

	getActiveResearchSourceIds(): string[] {
		const sourceIds = new Set<string>();
		for (const operation of this.researchOperations.values()) {
			if (operation.dismissed || operation.status !== "ready") {
				continue;
			}
			for (const sourceItem of operation.sourceItems) {
				const resolvedSourceId = this.store.resolveSourceId(sourceItem.sourceId);
				if (!resolvedSourceId || !this.remoteSourceIds.has(resolvedSourceId)) {
					continue;
				}
				sourceIds.add(resolvedSourceId);
			}
		}
		return [...sourceIds];
	}

	dismissResearchOperation(operationId: string): void {
		const operation = this.researchOperations.get(operationId);
		if (!operation || operation.dismissed) {
			return;
		}
		operation.dismissed = true;
		operation.updatedAt = new Date().toISOString();
		this.persistResearchOperation(operation);
		this.emitResearchOperationUpdate();
	}

	clearResearchComposerOperations(): void {
		let changed = false;
		for (const operation of this.researchOperations.values()) {
			if (operation.dismissed) {
				continue;
			}
			operation.dismissed = true;
			operation.updatedAt = new Date().toISOString();
			this.persistResearchOperation(operation);
			changed = true;
		}
		if (changed) {
			this.emitResearchOperationUpdate();
		}
	}

	executeResearchCommand(command: ExecutableResearchCommand): string {
		const now = new Date().toISOString();
		const operationId = `research-op-${crypto.randomUUID()}`;
		const recordId = `research-record-${crypto.randomUUID()}`;
		const query =
			command.kind === "link"
				? command.url
				: command.kind === "links"
					? command.urls.join(" ")
					: command.query;
		const links =
			command.kind === "link"
				? [command.url]
				: command.kind === "links"
					? [...command.urls]
					: [];
		const progressTotal = command.kind === "links" ? command.urls.length : 1;
		const operation: ResearchOperationState = {
			id: operationId,
			recordId,
			kind: command.kind,
			status: "loading",
			dismissed: false,
			query,
			links,
			sourceItems: [],
			linkKind: command.kind === "link" ? (command.isYouTube ? "youtube" : "url") : undefined,
			progress: {
				total: Math.max(1, progressTotal),
				completed: 0,
				percent: 0,
			},
			notebookId: null,
			createdAt: now,
			updatedAt: now,
		};
		this.researchOperations.set(operationId, operation);
		this.persistResearchOperation(operation);
		this.emitResearchOperationUpdate();

		void this.runResearchOperation(operationId, command);
		return operationId;
	}

	getComposerSelectionUploadStatus(selection: ComposerSelectionItem): ComposerSelectionUploadStatus {
		const allowedPaths = filterAllowedUploadPaths(selection.filePaths).allowedPaths;
		const scope = this.getExplicitUploadScopeState(allowedPaths);
		if (scope.total <= 0) {
			return {
				state: "idle",
				total: 0,
				completed: 0,
				percent: 100,
			};
		}

		const completed = Math.min(scope.total, scope.completed);
		const settled = Math.min(scope.total, scope.completed + scope.failed);
		const percent = Math.min(100, Math.max(0, Math.round((completed / scope.total) * 100)));
		return {
			state: scope.currentPath || settled < scope.total ? "uploading" : "complete",
			total: scope.total,
			completed,
			percent,
		};
	}

	enqueueExplicitSourceUploads(paths: string[]): void {
		const allowedPathsResult = filterAllowedUploadPaths(paths);
		const pathsToQueue = allowedPathsResult.allowedPaths;
		if (pathsToQueue.length === 0) {
			return;
		}

		let queuedAny = false;
		let stateChanged = false;
		for (const path of pathsToQueue) {
			if (!path) {
				continue;
			}
			if (this.getPreparedSourceIdForPath(path)) {
				const existingState = this.explicitUploadState.get(path);
				if (existingState?.status !== "ready" || existingState.uploaded) {
					this.explicitUploadState.set(path, { status: "ready", uploaded: false });
					stateChanged = true;
				}
				continue;
			}
			const existingState = this.explicitUploadState.get(path);
			if (
				existingState &&
				(existingState.status === "pending" ||
					existingState.status === "checking" ||
					existingState.status === "uploading")
			) {
				continue;
			}
			this.explicitUploadState.set(path, { status: "pending", uploaded: false });
			stateChanged = true;
			this.explicitUploadQueue.push(path);
			queuedAny = true;
		}

		if (queuedAny || stateChanged) {
			this.emitExplicitUploadUpdate();
		}
		if (queuedAny) {
			this.startExplicitUploadWorker();
		}
	}

	cancelExplicitSourceUploads(paths: string[]): void {
		const allowedPaths = filterAllowedUploadPaths(paths).allowedPaths;
		const cancelSet = new Set(allowedPaths.filter((path) => typeof path === "string" && path.length > 0));
		if (cancelSet.size === 0) {
			return;
		}

		let changed = false;
		const nextQueue = this.explicitUploadQueue.filter((queuedPath) => {
			if (!cancelSet.has(queuedPath)) {
				return true;
			}
			this.explicitUploadState.set(queuedPath, {
				status: "failed",
				uploaded: false,
				error: "Upload interrupted by user.",
			});
			changed = true;
			return false;
		});
		if (nextQueue.length !== this.explicitUploadQueue.length) {
			this.explicitUploadQueue = nextQueue;
		}

		for (const path of cancelSet) {
			if (path === this.explicitUploadCurrentPath) {
				continue;
			}
			const state = this.explicitUploadState.get(path);
			if (!state) {
				continue;
			}
			if (state.status === "pending" || state.status === "checking" || state.status === "uploading") {
				this.explicitUploadState.set(path, {
					status: "failed",
					uploaded: false,
					error: "Upload interrupted by user.",
				});
				changed = true;
			}
		}

		if (changed) {
			this.emitExplicitUploadUpdate();
		}
	}

	searchAddFilePathCandidates(term: string, mode: AddFilePathMode): AddFilePathSearchItem[] {
		return this.explicitSourceSelectionService.search(term, mode);
	}

	resolveComposerSelection(params: {
		kind: AddFilePathSelectionKind;
		path: string;
		mode: AddFilePathMode;
	}): ResolveComposerSelectionResult {
		return this.explicitSourceSelectionService.resolveSelection(params);
	}

	async openComposerSelectionInNewTab(selection: ComposerSelectionItem): Promise<void> {
		if (selection.kind === "file") {
			await this.openSourceInNewTab(selection.path);
			return;
		}

		const folderNotePath = this.explicitSourceSelectionService.resolveFolderNotePath(selection.path);
		if (!folderNotePath) {
			new Notice(`Folder note not found for path: ${selection.path}`);
			return;
		}

		await this.openSourceInNewTab(folderNotePath);
	}

	async openSourceInNewTab(path: string): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) {
			new Notice(`Source file not found in vault: ${path}`);
			return;
		}

		const leaf = this.app.workspace.getLeaf("tab");
		await leaf.openFile(file, { active: true });
		this.app.workspace.setActiveLeaf(leaf, { focus: true });
	}

	getActiveConversation(): ConversationRecord {
		const existingConversation =
			this.activeConversationId !== null
				? this.store.getConversationById(this.activeConversationId)
				: null;
		if (existingConversation) {
			return existingConversation;
		}

		const latestConversation = this.store.getConversationHistory()[0] ?? null;
		if (latestConversation) {
			this.activeConversationId = latestConversation.id;
			return latestConversation;
		}

		const conversation = this.store.createConversation(this.settings.notebookId);
		this.activeConversationId = conversation.id;
		void this.store.save();
		return conversation;
	}

	async startNewConversation(): Promise<ConversationRecord> {
		const conversation = this.store.createConversation(this.settings.notebookId);
		this.activeConversationId = conversation.id;
		await this.store.save();
		return conversation;
	}

	async loadConversation(conversationId: string): Promise<ConversationRecord | null> {
		const conversation = this.store.getConversationById(conversationId);
		if (!conversation) {
			new Notice("Conversation not found.");
			return null;
		}

		this.activeConversationId = conversation.id;

		const pathsToEnsure = new Set<string>();
		for (const metadata of conversation.queryMetadata) {
			for (const scoredPath of metadata.bm25Selection.selected) {
				pathsToEnsure.add(scoredPath.path);
			}
			for (const rawSourceId of metadata.selectedSourceIds) {
				const resolvedSourceId = this.store.resolveSourceId(rawSourceId);
				const resolvedPath = this.store.getSourcePathById(resolvedSourceId);
				if (resolvedPath) {
					pathsToEnsure.add(resolvedPath);
				}
			}
		}

			if (pathsToEnsure.size > 0) {
				try {
					const notebookId = await this.ensureNotebookReady();
					await this.ensureSourcesForPaths(notebookId, [...pathsToEnsure], []);
					await this.store.save();
				} catch (error) {
					this.logger.warn("Failed to ensure history conversation sources", getErrorMessage(error));
				}
		}

		return conversation;
	}

	async handleUserQuery(
		query: string,
		options?: {
			explicitSelections?: ComposerSelectionItem[];
			includeBm25Search?: boolean;
			excludedSourceIds?: string[];
			excludedPaths?: string[];
			manualSourceIds?: string[];
		},
	): Promise<void> {
		const trimmedQuery = query.trim();
		if (!trimmedQuery) {
			return;
		}
		const explicitSelections = this.normalizeComposerSelections(options?.explicitSelections ?? []);
		const excludedPathSet = this.normalizeExcludedPaths(options?.excludedPaths ?? []);
		const explicitPaths = collectExplicitSelectionPaths(explicitSelections).filter(
			(path) => !excludedPathSet.has(path),
		);
		const excludedSourceIdSet = this.normalizeExcludedSourceIds(options?.excludedSourceIds ?? []);
		const manualSourceIds = this.normalizeManualSourceIds(
			options?.manualSourceIds ?? [],
			excludedSourceIdSet,
		);
		const includeBm25Search = this.shouldRunBm25ForQuery(options?.includeBm25Search);

		const conversation = this.getActiveConversation();
		const userMessageTime = new Date().toISOString();
		conversation.messages.push({
			role: "user",
			text: trimmedQuery,
			at: userMessageTime,
		});
		conversation.updatedAt = userMessageTime;
		this.store.saveConversation(conversation);
		await this.store.save();

		const safeSearchParams = this.getSafeBm25SearchParams();
		const explicitSelectionMetadata = this.toExplicitSelectionMetadata(explicitSelections);
		const queryMetadata: ConversationQueryMetadata = {
			at: userMessageTime,
			bm25Selection: {
				query: trimmedQuery,
				topN: safeSearchParams.topN,
				cutoffRatio: safeSearchParams.cutoffRatio,
				minK: safeSearchParams.minK,
				top15: [],
				selected: [],
			},
			explicitSelections: explicitSelectionMetadata.length > 0 ? explicitSelectionMetadata : undefined,
			selectedSourceIds: [],
			evictions: [],
		};

		let assistantResponse = "";
		let currentStep: QueryStepKey = "search";
		let progressState: QueryProgressState = {
			steps: {
				search: "active",
				upload: "pending",
				response: "pending",
			},
			searchDetail: includeBm25Search
				? "Searching vault notes with BM25 and selecting documents..."
				: "BM25 search skipped. Using explicit and conversation sources only.",
			uploadDetail: "Waiting for document selection...",
			responseDetail: "Waiting for source preparation...",
			upload: {
				total: 0,
				currentIndex: 0,
				currentPath: null,
				uploadedCount: 0,
				reusedCount: 0,
			},
		};
		this.setQueryProgress(progressState);

		const updateProgress = (patch: Partial<QueryProgressState>): void => {
			progressState = {
				...progressState,
				...patch,
				steps: patch.steps ?? progressState.steps,
				upload: patch.upload ?? progressState.upload,
			};
			this.setQueryProgress(progressState);
		};

		try {
			const notebookId = await this.ensureNotebookReady();
			let bm25Result: BM25SearchResult | null = null;
			if (includeBm25Search) {
				bm25Result = await this.bm25.search(trimmedQuery, safeSearchParams);
				queryMetadata.bm25Selection.top15 = bm25Result.topResults.map((item) => ({
					path: item.path,
					score: item.score,
				}));
			}

			const bm25SelectedItems = bm25Result
				? bm25Result.selected.filter((item) => !excludedPathSet.has(item.path))
				: [];
			queryMetadata.bm25Selection.selected = bm25SelectedItems.map((item) => ({
				path: item.path,
				score: item.score,
			}));
			const bm25SelectedPaths = bm25SelectedItems.map((item) => item.path);
			const selectedPaths = mergeSelectionPaths(bm25SelectedPaths, explicitPaths);
			const allowedUploadPathsResult = filterAllowedUploadPaths(selectedPaths);
			const selectedUploadPaths = allowedUploadPathsResult.allowedPaths;
			if (allowedUploadPathsResult.ignoredCount > 0) {
				const extensionList = allowedUploadPathsResult.ignoredExtensions.join(", ");
				new Notice(
					`Ignored ${allowedUploadPathsResult.ignoredCount} file${allowedUploadPathsResult.ignoredCount === 1 ? "" : "s"} due to unallowed extensions ${extensionList}.`,
					8000,
				);
			}
			const selectedUploadPathSet = new Set(selectedUploadPaths);
			const explicitUploadPaths = explicitPaths.filter((path) => selectedUploadPathSet.has(path));
			const historicalSourceIds = this.getConversationReusableSourceIds(conversation, excludedSourceIdSet);
				if (selectedUploadPaths.length === 0 && historicalSourceIds.length === 0 && manualSourceIds.length === 0) {
				if (includeBm25Search && bm25Result) {
					if (bm25Result.queryTokens.length === 0) {
						throw new Error(
							"No searchable tokens were found in your query after normalization. Try adding text keywords.",
						);
					}
					if (bm25Result.matchedTokens.length === 0) {
						throw new Error(
							`No lexical match in vault notes for tokens: ${summarizeTokens(bm25Result.queryTokens)}.`,
						);
					}
					throw new Error(
						`No BM25 candidates scored above zero. Matched tokens: ${summarizeTokens(bm25Result.matchedTokens)}.`,
					);
				}

				throw new Error(
					"No sources are available for this question. Enable Search vault or add files/paths with @.",
				);
				}
				const selectedCount = selectedUploadPaths.length;
				const explicitUploadPathSet = new Set(explicitUploadPaths);
				const bm25OnlyUploadPaths = selectedUploadPaths.filter((path) => !explicitUploadPathSet.has(path));
				const searchDetailParts: string[] = [];
			if (includeBm25Search) {
				searchDetailParts.push(
					`BM25 selected ${bm25SelectedPaths.length} source${bm25SelectedPaths.length === 1 ? "" : "s"} for this question`,
				);
			} else {
				searchDetailParts.push("BM25 search skipped for this question");
			}
				if (explicitUploadPaths.length > 0) {
					searchDetailParts.push(
						`manual selection added ${explicitUploadPaths.length} file${explicitUploadPaths.length === 1 ? "" : "s"}`,
					);
				}
				if (manualSourceIds.length > 0) {
					searchDetailParts.push(
						`research selection added ${manualSourceIds.length} source${manualSourceIds.length === 1 ? "" : "s"}`,
					);
				}
			currentStep = "upload";
				updateProgress({
					steps: {
						search: "done",
						upload: "active",
						response: "pending",
					},
					searchDetail: `${searchDetailParts.join("; ")}.`,
					uploadDetail: `Preparing ${selectedCount} selected document${selectedCount === 1 ? "" : "s"}...`,
					responseDetail: "Waiting for uploads to finish...",
					upload: {
						total: selectedCount,
						currentIndex: 0,
						currentPath: null,
						uploadedCount: 0,
						reusedCount: 0,
					},
				});

				const explicitUploadedPaths = new Set<string>();
				const explicitReusedPaths = new Set<string>();
				const bm25UploadedPaths = new Set<string>();
				const bm25ReusedPaths = new Set<string>();
				const pathToSourceId: Record<string, string> = {};

				const updateUploadProgress = (params: {
					uploadDetail: string;
					currentIndex: number;
					currentPath: string | null;
				}): void => {
					updateProgress({
						uploadDetail: params.uploadDetail,
						upload: {
							total: selectedCount,
							currentIndex: Math.max(0, Math.min(selectedCount, params.currentIndex)),
							currentPath: params.currentPath,
							uploadedCount: explicitUploadedPaths.size + bm25UploadedPaths.size,
							reusedCount: explicitReusedPaths.size + bm25ReusedPaths.size,
						},
					});
				};

				if (explicitUploadPaths.length > 0) {
					await this.waitForExplicitUploads(explicitUploadPaths, (scope) => {
						explicitUploadedPaths.clear();
						for (const path of scope.uploadedPaths) {
							explicitUploadedPaths.add(path);
						}
						explicitReusedPaths.clear();
						for (const path of scope.reusedPaths) {
							explicitReusedPaths.add(path);
						}

						let uploadDetail = `Preparing explicit sources (${scope.completed}/${scope.total})...`;
						if (scope.currentPath) {
							const pathState = this.explicitUploadState.get(scope.currentPath);
							const actionLabel =
								pathState?.status === "uploading"
									? "Uploading"
									: pathState?.status === "checking"
										? "Checking"
										: "Preparing";
							uploadDetail = `${actionLabel} (${scope.currentIndex}/${selectedCount}): ${scope.currentPath}`;
						} else if (scope.total > 0 && scope.completed + scope.failed >= scope.total) {
							uploadDetail = `Explicit selection ready (${scope.completed}/${scope.total}).`;
						}

						updateUploadProgress({
							uploadDetail,
							currentIndex: scope.currentPath ? scope.currentIndex : scope.completed + scope.failed,
							currentPath: scope.currentPath,
						});
					});

					for (const path of explicitUploadPaths) {
						const sourceId = this.getPreparedSourceIdForPath(path);
						if (sourceId) {
							pathToSourceId[path] = sourceId;
						}
					}
				}

				if (bm25OnlyUploadPaths.length > 0) {
					const bm25PathToSourceId = await this.ensureSourcesForPaths(
						notebookId,
						bm25OnlyUploadPaths,
						queryMetadata.evictions,
						(sourceProgress) => {
							if (sourceProgress.action === "ready") {
								if (sourceProgress.uploaded) {
									bm25UploadedPaths.add(sourceProgress.path);
								} else {
									bm25ReusedPaths.add(sourceProgress.path);
								}
							}

							const globalIndex = explicitUploadPaths.length + sourceProgress.index;
							let uploadDetail = `Checking (${globalIndex}/${selectedCount}): ${sourceProgress.path}`;
							if (sourceProgress.action === "uploading") {
								uploadDetail = `Uploading (${globalIndex}/${selectedCount}): ${sourceProgress.path}`;
							} else if (sourceProgress.action === "ready") {
								uploadDetail = sourceProgress.uploaded
									? `Uploaded (${globalIndex}/${selectedCount}): ${sourceProgress.path}`
									: `Already uploaded (${globalIndex}/${selectedCount}): ${sourceProgress.path}`;
							}

							updateUploadProgress({
								uploadDetail,
								currentIndex: globalIndex,
								currentPath: sourceProgress.path,
							});
						},
					);
					Object.assign(pathToSourceId, bm25PathToSourceId);
				}

			queryMetadata.bm25Selection.selected = bm25Result
				? bm25SelectedItems.map((item) => ({
						path: item.path,
						score: item.score,
						sourceId: pathToSourceId[item.path],
					}))
				: [];

			const bm25SourceIds = bm25SelectedItems
				.map((item) => pathToSourceId[item.path])
				.filter((value): value is string => typeof value === "string" && value.length > 0)
				.filter((sourceId) => !excludedSourceIdSet.has(this.store.resolveSourceId(sourceId)));
			const explicitSourceIds = explicitUploadPaths
				.map((path) => pathToSourceId[path])
				.filter((value): value is string => typeof value === "string" && value.length > 0)
				.filter((sourceId) => !excludedSourceIdSet.has(this.store.resolveSourceId(sourceId)));
				const currentSelectionSourceIds = [
					...new Set([...bm25SourceIds, ...explicitSourceIds, ...manualSourceIds]),
				];

				const sourceIdsSet = new Set(currentSelectionSourceIds);
				const carriedFromHistory = historicalSourceIds.filter((sourceId) => !sourceIdsSet.has(sourceId));
				const mergedSourceIds = [...new Set([...historicalSourceIds, ...currentSelectionSourceIds])];
				if (mergedSourceIds.length === 0) {
					throw new Error("Failed to prepare NotebookLM sources for this query.");
				}
				const newlyPreparedCount = explicitUploadedPaths.size + bm25UploadedPaths.size;
				const reusedFromSelectionCount = Math.max(0, currentSelectionSourceIds.length - newlyPreparedCount);
			const totalQuerySourceCount = mergedSourceIds.length;
			queryMetadata.selectedSourceIds = mergedSourceIds;
				queryMetadata.sourceSummary = {
					bm25SelectedCount: bm25SourceIds.length,
					explicitSelectedCount: explicitSourceIds.length,
					manualExternalSelectedCount: manualSourceIds.length,
					newlyPreparedCount,
					reusedFromSelectionCount,
					carriedFromHistoryCount: carriedFromHistory.length,
				totalQuerySourceCount,
			};
			currentStep = "response";
			updateProgress({
				steps: {
					search: "done",
					upload: "done",
					response: "active",
				},
				uploadDetail: `Step 1 complete: prepared ${newlyPreparedCount} new source${newlyPreparedCount === 1 ? "" : "s"} (reused ${reusedFromSelectionCount} from current selection).`,
				responseDetail: `Step 2 complete: querying with ${totalQuerySourceCount} total source${totalQuerySourceCount === 1 ? "" : "s"} (current ${currentSelectionSourceIds.length}, session ${carriedFromHistory.length}).`,
			});

			const queryArgs: Record<string, unknown> = {
				notebook_id: notebookId,
				query: trimmedQuery,
				source_ids: mergedSourceIds,
				timeout: this.getSafeQueryTimeoutSeconds(),
			};
			if (conversation.notebookConversationId) {
				queryArgs.conversation_id = conversation.notebookConversationId;
			}

			const mcpRequestTimeoutMs = this.getSafeMcpRequestTimeoutMs();
			let queryResult = await this.mcpClient.callTool<JsonObject>("notebook_query", queryArgs, {
				requestTimeoutMs: mcpRequestTimeoutMs,
				resetTimeoutOnProgress: true,
			});
			try {
				this.ensureToolSuccess("notebook_query", queryResult);
			} catch (error) {
				if (
					conversation.notebookConversationId &&
					this.isConversationContextError(getErrorMessage(error))
				) {
					delete queryArgs.conversation_id;
					conversation.notebookConversationId = undefined;
					queryResult = await this.mcpClient.callTool<JsonObject>("notebook_query", queryArgs, {
						requestTimeoutMs: mcpRequestTimeoutMs,
						resetTimeoutOnProgress: true,
					});
					this.ensureToolSuccess("notebook_query", queryResult);
				} else {
					throw error;
				}
			}

			const responseText = this.extractAssistantText(queryResult);
			assistantResponse = responseText.length > 0 ? responseText : "NotebookLM returned an empty response.";
			const conversationId = this.extractConversationId(queryResult);
			if (conversationId) {
				conversation.notebookConversationId = conversationId;
			}
			updateProgress({
				steps: {
					search: "done",
					upload: "done",
					response: "done",
				},
				responseDetail: "NotebookLM response received.",
				upload: {
					...progressState.upload,
					currentPath: null,
				},
			});
		} catch (error) {
			const message = this.userFacingError(error);
			assistantResponse = message;
			queryMetadata.errors = [getErrorMessage(error)];

			updateProgress({
				steps: {
					...progressState.steps,
					[currentStep]: "failed",
				},
				searchDetail:
					currentStep === "search" ? `Failed: ${message}` : progressState.searchDetail,
				uploadDetail:
					currentStep === "upload" ? `Failed: ${message}` : progressState.uploadDetail,
				responseDetail:
					currentStep === "response" ? `Failed: ${message}` : progressState.responseDetail,
			});
		}

		const assistantMessageTime = new Date().toISOString();
		conversation.messages.push({
			role: "assistant",
			text: assistantResponse,
			at: assistantMessageTime,
		});
		conversation.updatedAt = assistantMessageTime;
		conversation.notebookId = this.settings.notebookId;
		conversation.queryMetadata.push(queryMetadata);
		this.store.setBM25Index(this.bm25.exportCachedIndex());
		this.store.saveConversation(conversation);
		try {
			await this.store.save();
		} finally {
			this.setQueryProgress(null);
		}
	}

	async setDebugMode(enabled: boolean): Promise<void> {
		if (this.settings.debugMode === enabled) {
			return;
		}

		this.store.updateSettings({ debugMode: enabled });
		await this.store.save();

		try {
			await this.mcpClient.restart(enabled);
			await this.ensureNotebookReady();
		} catch (error) {
			new Notice(`Failed to restart MCP server: ${getErrorMessage(error)}`);
		}
	}

	async refreshAuthFromSettings(): Promise<void> {
		try {
			await this.ensureMcpConnected();
			const mcpRequestTimeoutMs = this.getSafeMcpRequestTimeoutMs();
			const refreshResult = await this.mcpClient.callTool<JsonObject>("refresh_auth", {}, {
				requestTimeoutMs: mcpRequestTimeoutMs,
			});
			this.ensureToolSuccess("refresh_auth", refreshResult);
			await this.mcpClient.callTool<JsonObject>("server_info", {}, {
				idempotent: true,
				requestTimeoutMs: mcpRequestTimeoutMs,
			});
			await this.ensureNotebookReady();
		} catch (error) {
			this.logger.error("Refresh auth failed", getErrorMessage(error));
			this.showAuthNotice();
			throw error;
		}
	}

	async updateNumericSetting(key: NumericSettingKey, value: number): Promise<void> {
		this.store.updateSettings({ [key]: value });
		await this.store.save();
	}

	private setQueryProgress(progress: QueryProgressState | null): void {
		this.queryProgress = progress;
		for (const listener of this.queryProgressListeners) {
			try {
				listener(progress);
			} catch {
				// Ignore listener failures to keep query execution stable.
			}
		}
	}

	private async startMcpServer(): Promise<void> {
		try {
			await this.ensureMcpConnected();
			await this.mcpClient.callTool<JsonObject>("server_info", {}, {
				idempotent: true,
				requestTimeoutMs: this.getSafeMcpRequestTimeoutMs(),
			});
			await this.ensureNotebookReady();
		} catch (error) {
			if (error instanceof NotebookLMMcpBinaryMissingError) {
				new Notice(
					"NotebookLM integration unavailable. Install notebooklm-mcp-cli globally (pip install notebooklm-mcp-cli, uv tool install notebooklm-mcp-cli, or pipx install notebooklm-mcp-cli).",
					12000,
				);
				return;
			}

			if (this.isAuthError(error)) {
				this.showAuthNotice();
				return;
			}

			new Notice(`NotebookLM MCP startup failed: ${getErrorMessage(error)}`, 10000);
		}
	}

	private async ensureMcpConnected(): Promise<void> {
		if (this.mcpClient.isConnected()) {
			return;
		}

		await this.mcpClient.start(this.settings.debugMode);
	}

	private async ensureNotebookReady(): Promise<string> {
		await this.ensureMcpConnected();
		const mcpRequestTimeoutMs = this.getSafeMcpRequestTimeoutMs();

		let notebookId = this.settings.notebookId;
		if (notebookId) {
			try {
				const notebookResult = await this.mcpClient.callTool<JsonObject>(
					"notebook_get",
					{
						notebook_id: notebookId,
					},
					{ idempotent: true, requestTimeoutMs: mcpRequestTimeoutMs },
				);
				this.ensureToolSuccess("notebook_get", notebookResult);
					this.updateRemoteSources(notebookResult);
					this.store.reconcileSources(this.remoteSourceIds);
					this.store.reconcileResearchRecords(this.remoteSourceIds);
					await this.store.save();
					return notebookId;
			} catch (error) {
				const message = getErrorMessage(error).toLowerCase();
				if (!message.includes("not found") && !message.includes("404") && !message.includes("missing")) {
					throw error;
				}
			}
		}

		const createResult = await this.mcpClient.callTool<JsonObject>(
			"notebook_create",
			{
				title: NOTEBOOK_TITLE,
			},
			{ requestTimeoutMs: mcpRequestTimeoutMs },
		);
		this.ensureToolSuccess("notebook_create", createResult);
		notebookId = this.extractNotebookId(createResult);
		if (!notebookId) {
			throw new Error("notebook_create succeeded but notebook_id was missing");
		}

		this.store.updateSettings({ notebookId });
		const notebookResult = await this.mcpClient.callTool<JsonObject>("notebook_get", {
			notebook_id: notebookId,
		}, { idempotent: true, requestTimeoutMs: mcpRequestTimeoutMs });
		this.ensureToolSuccess("notebook_get", notebookResult);
			this.updateRemoteSources(notebookResult);
			this.store.reconcileSources(this.remoteSourceIds);
			this.store.reconcileResearchRecords(this.remoteSourceIds);
			await this.store.save();

		return notebookId;
	}

	private updateRemoteSources(notebookResult: unknown): void {
		const sources = this.extractNotebookSources(notebookResult);
		this.remoteSourceIds = new Set(sources.map((source) => source.id));
	}

	private extractNotebookSources(notebookResult: unknown): Array<{ id: string; title?: string }> {
		const sources: Array<{ id: string; title?: string }> = [];
		const root = isRecord(notebookResult) ? notebookResult : {};
		const directSources = Array.isArray(root.sources) ? root.sources : [];
		const notebookObj = isRecord(root.notebook) ? root.notebook : null;
		const nestedSources = notebookObj && Array.isArray(notebookObj.sources) ? notebookObj.sources : [];

		for (const source of [...directSources, ...nestedSources]) {
			if (!isRecord(source)) {
				continue;
			}

			const id =
				(typeof source.id === "string" && source.id) ||
				(typeof source.source_id === "string" && source.source_id) ||
				"";
			if (!id) {
				continue;
			}

			sources.push({
				id,
				title: typeof source.title === "string" ? source.title : undefined,
			});
		}

		return sources;
	}

	private async ensureSourcesForPaths(
		notebookId: string,
		paths: string[],
		evictions: SourceEvictionRecord[],
		onProgress?: (progress: SourcePreparationProgress) => void,
	): Promise<Record<string, string>> {
		return this.runSourcePreparationExclusive(() =>
			ensureSourcesForPaths(
				{
					notebookId,
					paths,
					evictions,
					protectedCapacity: this.getProtectedCapacity(),
					onProgress,
				},
				this.getSourcePreparationDependencies(),
			),
		);
	}

	private getSourcePreparationDependencies() {
		return {
			remoteSourceIds: this.remoteSourceIds,
			callTool: <T>(name: string, args: Record<string, unknown>) =>
				this.mcpClient.callTool<T>(name, args, {
					requestTimeoutMs: this.getSafeMcpRequestTimeoutMs(),
					resetTimeoutOnProgress: true,
				}),
			ensureToolSuccess: (toolName: string, toolResult: unknown) => this.ensureToolSuccess(toolName, toolResult),
			extractSourceId: (toolResult: unknown) => this.extractSourceId(toolResult),
			getToolFailure: (toolResult: unknown) => this.getToolFailure(toolResult),
			resolveSourceId: (sourceId: string) => this.store.resolveSourceId(sourceId),
			getSourceEntryByPath: (path: string) => this.store.getSourceEntryByPath(path),
			upsertSource: (params: { path: string; sourceId: string; title: string; contentHash?: string }) =>
				this.store.upsertSource(params),
			registerSourceAlias: (previousSourceId: string, currentSourceId: string) =>
				this.store.registerSourceAlias(previousSourceId, currentSourceId),
			getSourceEntriesByContentHash: (contentHash: string) => this.store.getSourceEntriesByContentHash(contentHash),
			markSourceUsed: (path: string, protectedCap: number) => this.store.markSourceUsed(path, protectedCap),
			getEvictionCandidatePath: () => this.store.getEvictionCandidatePath(),
			removeSourceByPath: (path: string) => this.store.removeSourceByPath(path),
			prepareUploadPlan: async (path: string) => this.prepareUploadPlan(path),
			pathExists: (path: string) => this.app.vault.getAbstractFileByPath(path) instanceof TFile,
			logDebug: (message: string, payload?: unknown) => this.logger.debug(message, payload),
			logWarn: (message: string, payload?: unknown) => this.logger.warn(message, payload),
		};
	}

	private getProtectedCapacity(): number {
		return Math.max(1, Math.floor(SOURCE_TARGET_CAPACITY * PROTECTED_CAPACITY_RATIO));
	}

	private getSafeBm25SearchParams(): {
		topN: number;
		cutoffRatio: number;
		minK: number;
		k1: number;
		b: number;
	} {
		return {
			topN: this.clampInteger(this.settings.bm25TopN, SETTINGS_LIMITS.topN.min, SETTINGS_LIMITS.topN.max),
			cutoffRatio: this.clampNumber(
				this.settings.bm25CutoffRatio,
				SETTINGS_LIMITS.cutoffRatio.min,
				SETTINGS_LIMITS.cutoffRatio.max,
			),
			minK: this.clampInteger(
				this.settings.bm25MinSourcesK,
				SETTINGS_LIMITS.minSourcesK.min,
				SETTINGS_LIMITS.minSourcesK.max,
			),
			k1: this.clampNumber(this.settings.bm25k1, SETTINGS_LIMITS.k1.min, SETTINGS_LIMITS.k1.max),
			b: this.clampNumber(this.settings.bm25b, SETTINGS_LIMITS.b.min, SETTINGS_LIMITS.b.max),
		};
	}

	private getSafeQueryTimeoutSeconds(): number {
		return this.clampInteger(
			this.settings.queryTimeoutSeconds,
			SETTINGS_LIMITS.queryTimeoutSeconds.min,
			SETTINGS_LIMITS.queryTimeoutSeconds.max,
		);
	}

	private getSafeMcpRequestTimeoutMs(bufferMs = 30_000): number {
		return this.getSafeQueryTimeoutSeconds() * 1000 + bufferMs;
	}

	private clampInteger(value: number, min: number, max: number): number {
		if (!Number.isFinite(value)) {
			return min;
		}
		return Math.min(max, Math.max(min, Math.floor(value)));
	}

	private clampNumber(value: number, min: number, max: number): number {
		if (!Number.isFinite(value)) {
			return min;
		}
		return Math.min(max, Math.max(min, value));
	}

	private ensureToolSuccess(toolName: string, toolResult: unknown): void {
		const failure = this.getToolFailure(toolResult);
		if (!failure) {
			return;
		}

		throw new Error(`${toolName} failed: ${failure}`);
	}

	private getToolFailure(toolResult: unknown): string | null {
		if (!isRecord(toolResult)) {
			return null;
		}

		if (typeof toolResult.status === "string" && toolResult.status.toLowerCase() !== "success") {
			if (typeof toolResult.error === "string" && toolResult.error.length > 0) {
				return toolResult.error;
			}
			if (typeof toolResult.message === "string" && toolResult.message.length > 0) {
				return toolResult.message;
			}
			return `status=${toolResult.status}`;
		}

		if (typeof toolResult.success === "boolean" && !toolResult.success) {
			if (typeof toolResult.error === "string" && toolResult.error.length > 0) {
				return toolResult.error;
			}
			if (typeof toolResult.message === "string" && toolResult.message.length > 0) {
				return toolResult.message;
			}
			return "success=false";
		}

		return null;
	}

	private extractNotebookId(toolResult: unknown): string | null {
		if (!isRecord(toolResult)) {
			return null;
		}

		if (typeof toolResult.notebook_id === "string") {
			return toolResult.notebook_id;
		}

		if (isRecord(toolResult.notebook) && typeof toolResult.notebook.id === "string") {
			return toolResult.notebook.id;
		}

		if (isRecord(toolResult.notebook) && typeof toolResult.notebook.notebook_id === "string") {
			return toolResult.notebook.notebook_id;
		}

		return null;
	}

	private extractSourceId(toolResult: unknown): string | null {
		if (!isRecord(toolResult)) {
			return null;
		}

		if (typeof toolResult.source_id === "string") {
			return toolResult.source_id;
		}

		if (isRecord(toolResult.source) && typeof toolResult.source.id === "string") {
			return toolResult.source.id;
		}

		if (isRecord(toolResult.source) && typeof toolResult.source.source_id === "string") {
			return toolResult.source.source_id;
		}

		return null;
	}

	private extractConversationId(toolResult: unknown): string | null {
		if (!isRecord(toolResult)) {
			return null;
		}

		if (typeof toolResult.conversation_id === "string") {
			return toolResult.conversation_id;
		}

		if (isRecord(toolResult.conversation) && typeof toolResult.conversation.id === "string") {
			return toolResult.conversation.id;
		}

		return null;
	}

	private extractAssistantText(toolResult: unknown): string {
		if (!isRecord(toolResult)) {
			return typeof toolResult === "string" ? toolResult : JSON.stringify(toolResult);
		}

		const candidateFields = ["answer", "response", "result", "text", "message", "output"];
		for (const field of candidateFields) {
			const value = toolResult[field];
			if (typeof value === "string" && value.trim().length > 0) {
				return value.trim();
			}
		}

		if (isRecord(toolResult.data)) {
			for (const field of candidateFields) {
				const value = toolResult.data[field];
				if (typeof value === "string" && value.trim().length > 0) {
					return value.trim();
				}
			}
		}

		if (Array.isArray(toolResult.response)) {
			const parts = toolResult.response.filter((part): part is string => typeof part === "string");
			if (parts.length > 0) {
				return parts.join("\n");
			}
		}

		return JSON.stringify(toolResult);
	}

	private userFacingError(error: unknown): string {
		if (error instanceof NotebookLMMcpBinaryMissingError) {
			new Notice(
				"NotebookLM executable missing. Install notebooklm-mcp-cli globally (pip/uv/pipx).",
				10000,
			);
			return "NotebookLM executable missing. Install notebooklm-mcp-cli globally and retry.";
		}

		const message = getErrorMessage(error);
		if (this.isAuthError(message)) {
			this.showAuthNotice();
			return "Authentication failed. Run `nlm login` in a terminal, then click Refresh Auth in settings.";
		}

		if (message.toLowerCase().includes("timeout")) {
			return "Request timed out. Try again or reduce source scope.";
		}

		return `Request failed: ${message}`;
	}

	private showAuthNotice(): void {
		new Notice("Run `nlm login` in a terminal, then click Refresh Auth in settings.", 12000);
	}

	private isAuthError(error: unknown): boolean {
		const message = (typeof error === "string" ? error : getErrorMessage(error)).toLowerCase();
		return (
			message.includes("login") ||
			message.includes("auth") ||
			message.includes("unauthorized") ||
			message.includes("token") ||
			message.includes("cookie")
		);
	}

	private isConversationContextError(message: string): boolean {
		const lowered = message.toLowerCase();
		return lowered.includes("conversation") && (lowered.includes("not found") || lowered.includes("invalid"));
	}

	private getConversationReusableSourceIds(
		conversation: ConversationRecord,
		excludedSourceIds?: Set<string>,
	): string[] {
		return buildReusableSourceIds({
			queryMetadata: conversation.queryMetadata,
			resolveSourceId: (sourceId: string) => this.store.resolveSourceId(sourceId),
			remoteSourceIds: this.remoteSourceIds,
			maxCount: MAX_REUSABLE_HISTORY_SOURCE_IDS,
			excludedSourceIds,
		});
	}

	private shouldRunBm25ForQuery(requestedValue?: boolean): boolean {
		if (typeof requestedValue === "boolean") {
			return requestedValue;
		}
		return this.settings.searchWithExplicitSelections;
	}

	private getFileTitleFromPath(path: string): string {
		const parts = path.split("/");
		const lastPart = parts[parts.length - 1];
		return lastPart?.trim().length ? lastPart : path;
	}

	private normalizeComposerSelections(selections: ComposerSelectionItem[]): ComposerSelectionItem[] {
		const normalized: ComposerSelectionItem[] = [];
		const seenSelectionKeys = new Set<string>();
		for (const selection of selections) {
			if (!selection?.path || (selection.kind !== "file" && selection.kind !== "path")) {
				continue;
			}

			const rawFilePaths = Array.isArray(selection.filePaths) ? selection.filePaths : [];
			const filePaths = [...new Set(rawFilePaths.filter((path) => typeof path === "string" && !!path))];
			if (filePaths.length === 0) {
				continue;
			}

			const key = `${selection.kind}:${selection.path}`;
			if (seenSelectionKeys.has(key)) {
				continue;
			}
			seenSelectionKeys.add(key);

			normalized.push({
				...selection,
				filePaths,
				subfileCount: selection.kind === "path" ? Math.max(1, selection.subfileCount) : 1,
			});
		}

		return normalized;
	}

	private normalizeExcludedPaths(paths: string[]): Set<string> {
		const normalized = new Set<string>();
		for (const path of paths) {
			if (typeof path !== "string" || path.length === 0) {
				continue;
			}
			normalized.add(path);
		}
		return normalized;
	}

	private normalizeExcludedSourceIds(sourceIds: string[]): Set<string> {
		const normalized = new Set<string>();
		for (const sourceId of sourceIds) {
			if (typeof sourceId !== "string" || sourceId.length === 0) {
				continue;
			}
			const resolvedSourceId = this.store.resolveSourceId(sourceId);
			if (!resolvedSourceId) {
				continue;
			}
			normalized.add(resolvedSourceId);
		}
		return normalized;
	}

	private normalizeManualSourceIds(sourceIds: string[], excludedSourceIds: Set<string>): string[] {
		const normalized = new Set<string>();
		for (const sourceId of sourceIds) {
			if (typeof sourceId !== "string" || sourceId.length === 0) {
				continue;
			}
			const resolvedSourceId = this.store.resolveSourceId(sourceId);
			if (!resolvedSourceId) {
				continue;
			}
			if (excludedSourceIds.has(resolvedSourceId)) {
				continue;
			}
			if (!this.remoteSourceIds.has(resolvedSourceId)) {
				continue;
			}
			normalized.add(resolvedSourceId);
		}
		return [...normalized];
	}

	private startExplicitUploadWorker(): void {
		if (this.explicitUploadWorkerPromise) {
			return;
		}

		this.explicitUploadWorkerPromise = this.runExplicitUploadWorker().finally(() => {
			this.explicitUploadWorkerPromise = null;
			this.explicitUploadCurrentPath = null;
			this.emitExplicitUploadUpdate();
			if (this.explicitUploadQueue.length > 0) {
				this.startExplicitUploadWorker();
			}
		});
	}

	private async runExplicitUploadWorker(): Promise<void> {
		while (this.explicitUploadQueue.length > 0) {
			const path = this.explicitUploadQueue.shift();
			if (!path) {
				continue;
			}

			if (this.getPreparedSourceIdForPath(path)) {
				this.explicitUploadState.set(path, { status: "ready", uploaded: false });
				this.emitExplicitUploadUpdate();
				continue;
			}

			this.explicitUploadCurrentPath = path;
			this.explicitUploadState.set(path, { status: "checking", uploaded: false });
			this.emitExplicitUploadUpdate();

			try {
				const notebookId = await this.ensureNotebookReady();
				await this.ensureSourcesForPaths(notebookId, [path], [], (sourceProgress) => {
					const previous = this.explicitUploadState.get(path);
					if (sourceProgress.action === "checking") {
						this.explicitUploadState.set(path, {
							status: "checking",
							uploaded: previous?.uploaded ?? false,
						});
					} else if (sourceProgress.action === "uploading") {
						this.explicitUploadState.set(path, {
							status: "uploading",
							uploaded: true,
						});
					} else {
						this.explicitUploadState.set(path, {
							status: "ready",
							uploaded: sourceProgress.uploaded,
						});
					}
					this.emitExplicitUploadUpdate();
				});

				const sourceId = this.getPreparedSourceIdForPath(path);
				if (!sourceId) {
					this.explicitUploadState.set(path, {
						status: "failed",
						uploaded: false,
						error: "No source_id was prepared for this path.",
					});
				}
			} catch (error) {
				this.logger.warn("Explicit source pre-upload failed", {
					path,
					error: getErrorMessage(error),
				});
				this.explicitUploadState.set(path, {
					status: "failed",
					uploaded: false,
					error: getErrorMessage(error),
				});
			} finally {
				if (this.explicitUploadCurrentPath === path) {
					this.explicitUploadCurrentPath = null;
				}
				this.emitExplicitUploadUpdate();
			}
		}
	}

	private emitExplicitUploadUpdate(): void {
		for (const listener of this.explicitUploadStateListeners) {
			try {
				listener();
			} catch {
				// Ignore listener failures.
			}
		}

		for (const waiter of this.explicitUploadUpdateWaiters) {
			try {
				waiter();
			} catch {
				// Ignore waiter failures.
			}
		}
		this.explicitUploadUpdateWaiters.clear();
	}

	private waitForExplicitUploadUpdate(): Promise<void> {
		return new Promise((resolve) => {
			this.explicitUploadUpdateWaiters.add(resolve);
		});
	}

	private getPreparedSourceIdForPath(path: string): string | null {
		const entry = this.store.getSourceEntryByPath(path);
		if (!entry || entry.stale) {
			return null;
		}
		const sourceId = this.store.resolveSourceId(entry.sourceId);
		if (!sourceId || !this.remoteSourceIds.has(sourceId)) {
			return null;
		}
		return sourceId;
	}

	private getExplicitUploadScopeState(paths: string[]): ExplicitUploadScopeState {
		const dedupedPaths = [...new Set(paths.filter((path) => typeof path === "string" && path.length > 0))];
		const uploadedPaths = new Set<string>();
		const reusedPaths = new Set<string>();
		let completed = 0;
		let failed = 0;
		let currentPath: string | null = null;
		let currentIndex = 0;

		for (const path of dedupedPaths) {
			const preparedSourceId = this.getPreparedSourceIdForPath(path);
			if (preparedSourceId) {
				completed += 1;
				const currentState = this.explicitUploadState.get(path);
				if (currentState?.uploaded) {
					uploadedPaths.add(path);
				} else {
					reusedPaths.add(path);
				}
				continue;
			}

			const state = this.explicitUploadState.get(path);
			if (!state) {
				continue;
			}
			if (state.status === "ready") {
				completed += 1;
				if (state.uploaded) {
					uploadedPaths.add(path);
				} else {
					reusedPaths.add(path);
				}
				continue;
			}
			if (state.status === "failed") {
				failed += 1;
				continue;
			}
			if (!currentPath && (state.status === "checking" || state.status === "uploading")) {
				currentPath = path;
			}
		}

		if (currentPath) {
			currentIndex = Math.min(dedupedPaths.length, completed + failed + 1);
		} else {
			currentIndex = Math.min(dedupedPaths.length, completed + failed);
		}

		return {
			total: dedupedPaths.length,
			completed,
			failed,
			currentPath,
			currentIndex,
			uploadedPaths,
			reusedPaths,
		};
	}

	private async waitForExplicitUploads(
		paths: string[],
		onProgress: (scope: ExplicitUploadScopeState) => void,
	): Promise<void> {
		const dedupedPaths = [...new Set(paths.filter((path) => typeof path === "string" && path.length > 0))];
		if (dedupedPaths.length === 0) {
			onProgress({
				total: 0,
				completed: 0,
				failed: 0,
				currentPath: null,
				currentIndex: 0,
				uploadedPaths: new Set<string>(),
				reusedPaths: new Set<string>(),
			});
			return;
		}

		this.enqueueExplicitSourceUploads(dedupedPaths);
		while (true) {
			const scope = this.getExplicitUploadScopeState(dedupedPaths);
			onProgress(scope);
			if (scope.completed + scope.failed >= scope.total) {
				return;
			}
			await this.waitForExplicitUploadUpdate();
		}
	}

	private async runSourcePreparationExclusive<T>(task: () => Promise<T>): Promise<T> {
		const runTask = async (): Promise<T> => task();
		const resultPromise = this.sourcePreparationMutex.then(runTask, runTask);
		this.sourcePreparationMutex = resultPromise.then(
			() => undefined,
			() => undefined,
		);
		return resultPromise;
	}

	private async runResearchOperation(
		operationId: string,
		command: ExecutableResearchCommand,
	): Promise<void> {
		try {
			const notebookId = await this.ensureNotebookReady();
			this.updateResearchOperation(
				operationId,
				(operation) => {
					operation.notebookId = notebookId;
				},
				false,
			);

			if (command.kind === "link") {
				await this.runSingleLinkResearchOperation(operationId, notebookId, command.url);
				return;
			}
			if (command.kind === "links") {
				await this.runMultiLinkResearchOperation(operationId, notebookId, command.urls);
				return;
			}
			if (command.kind === "research-fast") {
				await this.runFastOrDeepResearchOperation(operationId, notebookId, "fast", command.query);
				return;
			}
			await this.runFastOrDeepResearchOperation(operationId, notebookId, "deep", command.query);
		} catch (error) {
			const message = getErrorMessage(error);
			this.updateResearchOperation(
				operationId,
				(operation) => {
					operation.status = "error";
					operation.error = message;
					operation.progress.completed = operation.progress.total;
					operation.progress.percent = 100;
				},
				true,
			);
		}
	}

	private async runSingleLinkResearchOperation(
		operationId: string,
		notebookId: string,
		url: string,
	): Promise<void> {
		let addedSource: NotebookResearchSourceItem | null = null;
		let firstError: string | null = null;
		try {
			addedSource = await this.addLinkSourceToNotebook(notebookId, url);
		} catch (error) {
			firstError = getErrorMessage(error);
		}

		const validatedResult = addedSource
			? await this.validateImportedResearchSources([addedSource])
			: { usableSources: [] as NotebookResearchSourceItem[], failedLinks: [] as string[] };
		const usableSources = validatedResult.usableSources;
		const failedLinkSet = new Set<string>(validatedResult.failedLinks);
		if (usableSources.length === 0) {
			failedLinkSet.add(url);
		}
		const failedCount = failedLinkSet.size;
		const status: NotebookResearchStatus = usableSources.length > 0 ? "ready" : "error";
		const errorMessage =
			status === "ready"
				? firstError ?? undefined
				: firstError ??
					(failedCount > 0
						? "Link could not be retrieved from NotebookLM and was removed automatically."
						: "No link was added to NotebookLM.");
		this.updateResearchOperation(
			operationId,
			(operation) => {
				operation.sourceItems = usableSources;
				operation.links = [url];
				operation.status = status;
				operation.error = errorMessage;
				operation.progress.completed = operation.progress.total;
				operation.progress.percent = 100;
			},
			true,
		);
	}

	private async runMultiLinkResearchOperation(
		operationId: string,
		notebookId: string,
		urls: string[],
	): Promise<void> {
		const addedSources: NotebookResearchSourceItem[] = [];
		const failedAddLinks: string[] = [];
		let completed = 0;
		let firstError: string | null = null;
		for (const url of urls) {
			try {
				const source = await this.addLinkSourceToNotebook(notebookId, url);
				addedSources.push(source);
			} catch (error) {
				failedAddLinks.push(url);
				if (!firstError) {
					firstError = getErrorMessage(error);
				}
			} finally {
				completed += 1;
				const percent = Math.min(100, Math.round((completed / Math.max(1, urls.length)) * 100));
				this.updateResearchOperation(
					operationId,
					(operation) => {
						operation.progress.completed = completed;
						operation.progress.percent = percent;
					},
					false,
				);
			}
		}

		const validatedResult =
			addedSources.length > 0
				? await this.validateImportedResearchSources(addedSources)
				: { usableSources: [] as NotebookResearchSourceItem[], failedLinks: [] as string[] };
		const usableSources = validatedResult.usableSources;
		const failedLinkSet = new Set<string>([...failedAddLinks, ...validatedResult.failedLinks]);
		if (usableSources.length === 0) {
			for (const url of urls) {
				failedLinkSet.add(url);
			}
		}
		const failedCount = failedLinkSet.size;
		const status: NotebookResearchStatus = usableSources.length > 0 ? "ready" : "error";
		const errorMessage =
			status === "ready"
				? firstError ??
					(failedCount > 0
						? `${failedCount} link${failedCount === 1 ? "" : "s"} could not be retrieved and were removed from NotebookLM sources.`
						: undefined)
				: firstError ??
					(failedCount > 0
						? "No links were retrievable from NotebookLM. Failed links remain available to open in browser."
						: "No links were added to NotebookLM.");

		this.updateResearchOperation(
			operationId,
			(operation) => {
				operation.sourceItems = usableSources;
				operation.links = [...urls];
				operation.status = status;
				operation.error = errorMessage;
				operation.progress.completed = operation.progress.total;
				operation.progress.percent = 100;
			},
			true,
		);
	}

	private async runFastOrDeepResearchOperation(
		operationId: string,
		notebookId: string,
		mode: "fast" | "deep",
		query: string,
	): Promise<void> {
		const baselineSourceIds = new Set<string>();
		for (const sourceId of this.remoteSourceIds) {
			const resolvedSourceId = this.store.resolveSourceId(sourceId);
			if (resolvedSourceId) {
				baselineSourceIds.add(resolvedSourceId);
			}
		}

		const mcpRequestTimeoutMs = this.getSafeMcpRequestTimeoutMs();
		const trackingQuery = buildResearchTrackingQuery(query);
		const startResult = await this.mcpClient.callTool<JsonObject>(
			"research_start",
			{
				query: trackingQuery,
				source: "web",
				mode,
				notebook_id: notebookId,
			},
			{
				requestTimeoutMs: mcpRequestTimeoutMs,
				resetTimeoutOnProgress: true,
			},
		);
		this.ensureToolSuccess("research_start", startResult);
		const startTaskId = typeof startResult.task_id === "string" ? startResult.task_id : null;
		if (!startTaskId) {
			throw new Error("research_start succeeded but task_id is missing.");
		}

		this.updateResearchOperation(
			operationId,
			(operation) => {
				operation.startTaskId = startTaskId;
				operation.taskId = startTaskId;
			},
			false,
		);

		const tracker = await trackResearchStatus({
			mode,
			notebookId,
			query: trackingQuery,
			startTaskId,
			pollStatus: async ({ taskId, query: statusQuery }) =>
				this.mcpClient.callTool<JsonObject>(
					"research_status",
					{
						notebook_id: notebookId,
						task_id: taskId,
						query: statusQuery,
						compact: false,
					},
					{
						requestTimeoutMs: mcpRequestTimeoutMs,
						resetTimeoutOnProgress: true,
					},
				),
			onUpdate: ({ currentTaskId }) => {
				this.updateResearchOperation(
					operationId,
					(operation) => {
						if (currentTaskId) {
							operation.taskId = currentTaskId;
						}
					},
					false,
				);
			},
		});

		const finalResponse = tracker.response && isRecord(tracker.response) ? tracker.response : {};
		const sourcesRaw = Array.isArray(finalResponse.sources) ? finalResponse.sources : [];
		const normalizedSources = sourcesRaw.map((source, fallbackIndex) => {
			if (!isRecord(source)) {
				return {
					index: fallbackIndex,
					title: "",
					url: "",
					resultTypeName: "",
				};
			}
			return {
				index:
					typeof source.index === "number" && Number.isFinite(source.index)
						? Math.floor(source.index)
						: fallbackIndex,
				title: typeof source.title === "string" ? source.title : "",
				url: typeof source.url === "string" ? source.url : "",
				resultTypeName: typeof source.result_type_name === "string" ? source.result_type_name : "",
			};
		});
		const discoveredLinks = normalizedSources
			.map((item) => item.url)
			.filter((value): value is string => typeof value === "string" && value.trim().length > 0);

		if (tracker.status === "timeout" || tracker.status === "error") {
			const cleanupFailedLinks = await this.cleanupUnusableNewResearchSources(
				notebookId,
				baselineSourceIds,
				new Set<string>(),
			);
			const message =
				tracker.status === "timeout"
					? "Research polling timed out."
					: `Research polling failed${typeof finalResponse.error === "string" ? `: ${finalResponse.error}` : "."}`;
			this.updateResearchOperation(
				operationId,
				(operation) => {
					operation.status = "error";
					operation.error = message;
					operation.links = [...new Set([...discoveredLinks, ...cleanupFailedLinks])];
					operation.progress.completed = operation.progress.total;
					operation.progress.percent = 100;
					operation.taskId = tracker.taskId ?? operation.taskId;
				},
				true,
			);
			return;
		}

		if (tracker.status === "no_research") {
			const cleanupFailedLinks = await this.cleanupUnusableNewResearchSources(
				notebookId,
				baselineSourceIds,
				new Set<string>(),
			);
			this.updateResearchOperation(
				operationId,
				(operation) => {
					operation.status = "no_research";
					operation.links = [...new Set([...discoveredLinks, ...cleanupFailedLinks])];
					operation.report = typeof finalResponse.report === "string" ? finalResponse.report : undefined;
					operation.progress.completed = operation.progress.total;
					operation.progress.percent = 100;
					operation.taskId = tracker.taskId ?? operation.taskId;
				},
				true,
			);
			return;
		}

		const importIndices = getResearchImportIndices(
			mode,
			normalizedSources.map((item) => ({
				index: item.index,
				title: item.title,
				url: item.url,
				result_type_name: item.resultTypeName,
			})),
		);
		const importCandidateLinks = importIndices
			.map((index) => normalizedSources.find((source) => source.index === index)?.url ?? "")
			.filter((value): value is string => typeof value === "string" && value.trim().length > 0);
		if (importIndices.length === 0) {
			const cleanupFailedLinks = await this.cleanupUnusableNewResearchSources(
				notebookId,
				baselineSourceIds,
				new Set<string>(),
			);
			this.updateResearchOperation(
				operationId,
				(operation) => {
					operation.status = "no_research";
					operation.links = [...new Set([...importCandidateLinks, ...cleanupFailedLinks])];
					operation.report = typeof finalResponse.report === "string" ? finalResponse.report : undefined;
					operation.progress.completed = operation.progress.total;
					operation.progress.percent = 100;
					operation.taskId = tracker.taskId ?? operation.taskId;
				},
				true,
			);
			return;
		}

		const importResult = await this.mcpClient.callTool<JsonObject>(
			"research_import",
			{
				notebook_id: notebookId,
				task_id: tracker.taskId ?? startTaskId,
				source_indices: importIndices,
			},
			{
				requestTimeoutMs: mcpRequestTimeoutMs,
				resetTimeoutOnProgress: true,
			},
		);
		this.ensureToolSuccess("research_import", importResult);
		const importedRaw = Array.isArray(importResult.imported_sources) ? importResult.imported_sources : [];
		const selectedSources = importIndices.map((index) =>
			normalizedSources.find((source) => source.index === index),
		);
		const importedSources: NotebookResearchSourceItem[] = [];
		for (let index = 0; index < importedRaw.length; index += 1) {
			const item = importedRaw[index];
			if (!isRecord(item)) {
				continue;
			}
			const sourceId = typeof item.id === "string" ? item.id : "";
			const title = typeof item.title === "string" ? item.title : "";
			if (!sourceId || !title) {
				continue;
			}
			const sourceFromStatus = selectedSources[index];
			importedSources.push({
				sourceId,
				title,
				url: sourceFromStatus?.url || undefined,
				sourceType: sourceFromStatus?.resultTypeName || undefined,
			});
		}

		if (importedSources.length === 0) {
			const cleanupFailedLinks = await this.cleanupUnusableNewResearchSources(
				notebookId,
				baselineSourceIds,
				new Set<string>(),
			);
			this.updateResearchOperation(
				operationId,
				(operation) => {
					operation.status = "no_research";
					operation.error = "research_import completed but did not return importable sources.";
					operation.links = [...new Set([...importCandidateLinks, ...cleanupFailedLinks])];
					operation.report = typeof finalResponse.report === "string" ? finalResponse.report : undefined;
					operation.progress.completed = operation.progress.total;
					operation.progress.percent = 100;
					operation.taskId = tracker.taskId ?? operation.taskId;
				},
				true,
			);
			return;
		}

		const validatedImportResult = await this.validateImportedResearchSources(importedSources);
		const usableSources = validatedImportResult.usableSources;
		const failedLinks = validatedImportResult.failedLinks;
		const retainedSourceIds = new Set<string>(
			usableSources
				.map((source) => this.store.resolveSourceId(source.sourceId))
				.filter((value): value is string => typeof value === "string" && value.length > 0),
		);
		const cleanupFailedLinks = await this.cleanupUnusableNewResearchSources(
			notebookId,
			baselineSourceIds,
			retainedSourceIds,
		);
		const visibleLinks = [...new Set([...importCandidateLinks, ...failedLinks, ...cleanupFailedLinks])];
		if (usableSources.length === 0) {
			this.updateResearchOperation(
				operationId,
				(operation) => {
					operation.status = "no_research";
					operation.error =
						"Imported links could not be retrieved from NotebookLM and were removed automatically.";
					operation.links = visibleLinks;
					operation.report = typeof finalResponse.report === "string" ? finalResponse.report : undefined;
					operation.progress.completed = operation.progress.total;
					operation.progress.percent = 100;
					operation.taskId = tracker.taskId ?? operation.taskId;
				},
				true,
			);
			return;
		}

		this.updateResearchOperation(
			operationId,
			(operation) => {
				operation.status = "ready";
				operation.sourceItems = usableSources;
				operation.links = visibleLinks;
				operation.report = typeof finalResponse.report === "string" ? finalResponse.report : undefined;
				operation.progress.completed = operation.progress.total;
				operation.progress.percent = 100;
				operation.taskId = tracker.taskId ?? operation.taskId;
				operation.error =
					failedLinks.length > 0
						? `${failedLinks.length} imported link${failedLinks.length === 1 ? "" : "s"} could not be retrieved and were removed from NotebookLM sources.`
						: undefined;
			},
			true,
		);
	}

	private async validateImportedResearchSources(
		sources: NotebookResearchSourceItem[],
	): Promise<{ usableSources: NotebookResearchSourceItem[]; failedLinks: string[] }> {
		const usableSources: NotebookResearchSourceItem[] = [];
		const failedLinks: string[] = [];
		const validationResults = await Promise.all(
			sources.map(async (source) => {
				const resolvedSourceId = this.store.resolveSourceId(source.sourceId);
				const sourceUrl = typeof source.url === "string" ? source.url.trim() : "";
				if (!resolvedSourceId) {
					return {
						usableSource: null as NotebookResearchSourceItem | null,
						failedLink: sourceUrl || null,
					};
				}

				const usable = await this.isSourceContentUsableAfterValidationRetries(resolvedSourceId);
				if (usable) {
					this.researchSourceFetchabilityCache.set(resolvedSourceId, true);
					this.remoteSourceIds.add(resolvedSourceId);
					return {
						usableSource: {
							...source,
							sourceId: resolvedSourceId,
						},
						failedLink: null as string | null,
					};
				}

				this.researchSourceFetchabilityCache.set(resolvedSourceId, false);
				await this.deleteResearchSourceIfExists(resolvedSourceId);
				return {
					usableSource: null as NotebookResearchSourceItem | null,
					failedLink: sourceUrl || null,
				};
			}),
		);

		for (const result of validationResults) {
			if (result.usableSource) {
				usableSources.push(result.usableSource);
			}
			if (result.failedLink) {
				failedLinks.push(result.failedLink);
			}
		}

		return {
			usableSources,
			failedLinks: [...new Set(failedLinks)],
		};
	}

	private async cleanupUnusableNewResearchSources(
		notebookId: string,
		baselineSourceIds: Set<string>,
		retainedSourceIds: Set<string>,
	): Promise<string[]> {
		let notebookResult: JsonObject;
		try {
			notebookResult = await this.mcpClient.callTool<JsonObject>(
				"notebook_get",
				{ notebook_id: notebookId },
				{ idempotent: true, requestTimeoutMs: this.getSafeMcpRequestTimeoutMs() },
			);
			this.ensureToolSuccess("notebook_get", notebookResult);
		} catch (error) {
			this.logger.warn("Failed to load notebook sources for research cleanup", getErrorMessage(error));
			return [];
		}

		this.updateRemoteSources(notebookResult);
		const notebookSources = this.extractNotebookSources(notebookResult);
		const cleanupCandidates = notebookSources
			.map((source) => ({
				sourceId: this.store.resolveSourceId(source.id),
				title: source.title,
			}))
			.filter((item) => typeof item.sourceId === "string" && item.sourceId.length > 0)
			.map((item) => ({
				sourceId: item.sourceId as string,
				title: item.title,
			}))
			.filter(
				(item) =>
					!baselineSourceIds.has(item.sourceId) && !retainedSourceIds.has(item.sourceId),
			);
		if (cleanupCandidates.length === 0) {
			return [];
		}

		const failedLinks: string[] = [];
		await Promise.all(
			cleanupCandidates.map(async (candidate) => {
				const usable = await this.isSourceContentUsableAfterValidationRetries(candidate.sourceId);
				if (usable) {
					this.researchSourceFetchabilityCache.set(candidate.sourceId, true);
					return;
				}

				this.researchSourceFetchabilityCache.set(candidate.sourceId, false);
				await this.deleteResearchSourceIfExists(candidate.sourceId);
				const failedLink = parseHttpUrl(candidate.title);
				if (failedLink) {
					failedLinks.push(failedLink);
				}
			}),
		);

		return [...new Set(failedLinks)];
	}

	private async isSourceContentUsableAfterValidationRetries(sourceId: string): Promise<boolean> {
		if (!sourceId) {
			return false;
		}

		const mcpRequestTimeoutMs = this.getSafeMcpRequestTimeoutMs();
		for (const delayMs of IMPORTED_SOURCE_VALIDATION_DELAYS_MS) {
			await this.sleepForImportedSourceValidation(delayMs);
			try {
				const contentResult = await this.mcpClient.callTool<JsonObject>(
					"source_get_content",
					{ source_id: sourceId },
					{ idempotent: true, requestTimeoutMs: mcpRequestTimeoutMs },
				);
				const failure = this.getToolFailure(contentResult);
				if (failure) {
					continue;
				}
				if (this.isSourceContentUsable(contentResult)) {
					return true;
				}
			} catch {
				// Continue retry schedule (10s -> 20s -> 30s).
			}
		}

		return false;
	}

	private sleepForImportedSourceValidation(ms: number): Promise<void> {
		return new Promise((resolve) => {
			globalThis.setTimeout(resolve, Math.max(0, ms));
		});
	}

	private isSourceContentUsable(toolResult: unknown): boolean {
		if (!isRecord(toolResult)) {
			return false;
		}
		const content = typeof toolResult.content === "string" ? toolResult.content.trim() : "";
		if (content.length > 0) {
			return true;
		}

		const charCount =
			typeof toolResult.char_count === "number"
				? toolResult.char_count
				: typeof toolResult.charCount === "number"
					? toolResult.charCount
					: null;
		return typeof charCount === "number" && Number.isFinite(charCount) && charCount > 0;
	}

	private async deleteResearchSourceIfExists(sourceId: string): Promise<void> {
		if (!sourceId) {
			return;
		}
		const mcpRequestTimeoutMs = this.getSafeMcpRequestTimeoutMs();
		try {
			const deleteResult = await this.mcpClient.callTool<JsonObject>(
				"source_delete",
				{
					source_id: sourceId,
					confirm: true,
				},
				{
					requestTimeoutMs: mcpRequestTimeoutMs,
					resetTimeoutOnProgress: true,
				},
			);
			const failure = this.getToolFailure(deleteResult);
			if (failure && !failure.toLocaleLowerCase().includes("not found")) {
				this.logger.warn("Failed to delete unusable research source", {
					sourceId,
					failure,
				});
				return;
			}
		} catch (error) {
			const message = getErrorMessage(error);
			if (!message.toLocaleLowerCase().includes("not found")) {
				this.logger.warn("Failed to delete unusable research source", {
					sourceId,
					error: message,
				});
				return;
			}
		}

		this.remoteSourceIds.delete(sourceId);
	}

	private async addLinkSourceToNotebook(
		notebookId: string,
		url: string,
	): Promise<NotebookResearchSourceItem> {
		const mcpRequestTimeoutMs = this.getSafeMcpRequestTimeoutMs();
		const addWithArgs = async (args: Record<string, unknown>): Promise<NotebookResearchSourceItem> => {
			const result = await this.mcpClient.callTool<JsonObject>("source_add", args, {
				requestTimeoutMs: mcpRequestTimeoutMs,
				resetTimeoutOnProgress: true,
			});
			this.ensureToolSuccess("source_add", result);
			const sourceId = this.extractSourceId(result);
			if (!sourceId) {
				throw new Error("source_add succeeded but source_id is missing.");
			}
			const title = this.extractSourceTitle(result) ?? url;
			const sourceType = typeof result.source_type === "string" ? result.source_type : undefined;
			return {
				sourceId,
				title,
				url,
				sourceType,
			};
		};

		return await addWithArgs({
			notebook_id: notebookId,
			source_type: "url",
			url,
			wait: true,
		});
	}

	private extractSourceTitle(toolResult: unknown): string | null {
		if (!isRecord(toolResult)) {
			return null;
		}
		if (typeof toolResult.title === "string" && toolResult.title.trim().length > 0) {
			return toolResult.title.trim();
		}
		if (isRecord(toolResult.source) && typeof toolResult.source.title === "string") {
			return toolResult.source.title;
		}
		return null;
	}

	private updateResearchOperation(
		operationId: string,
		updater: (operation: ResearchOperationState) => void,
		persist: boolean,
	): void {
		const operation = this.researchOperations.get(operationId);
		if (!operation) {
			return;
		}
		updater(operation);
		operation.updatedAt = new Date().toISOString();
		if (persist) {
			this.persistResearchOperation(operation);
		}
		this.emitResearchOperationUpdate();
	}

	private persistResearchOperation(operation: ResearchOperationState): void {
		const record: NotebookResearchRecord = {
			id: operation.recordId,
			kind: operation.kind,
			status: operation.status,
			query: operation.query,
			links: [...operation.links],
			sourceItems: operation.sourceItems.map((item) => ({ ...item })),
			report: operation.report,
			error: operation.error,
			notebookId: operation.notebookId,
			startTaskId: operation.startTaskId,
			taskId: operation.taskId,
			createdAt: operation.createdAt,
			updatedAt: operation.updatedAt,
		};
		this.store.upsertResearchRecord(record);
		void this.store.save().catch((error) => {
			this.logger.warn("Failed to persist research record", getErrorMessage(error));
		});
	}

	private emitResearchOperationUpdate(): void {
		for (const listener of this.researchOperationListeners) {
			try {
				listener();
			} catch {
				// Ignore listener failures.
			}
		}
	}

	private getResearchRecordDisplayTitle(record: NotebookResearchRecord): string {
		if (record.kind === "link") {
			return record.sourceItems[0]?.title || record.query;
		}
		if (record.kind === "links") {
			const title = record.sourceItems[0]?.title || record.links[0] || record.query;
			return `${title} (${record.sourceItems.length})`;
		}
		if (record.kind === "research-fast") {
			return `${record.query} (${record.sourceItems.length})`;
		}
		return `${record.query} (${record.sourceItems.length})`;
	}

	private toExplicitSelectionMetadata(selections: ComposerSelectionItem[]): ExplicitSelectionMetadata[] {
		return selections.map((selection) => ({
			kind: selection.kind,
			mode: selection.mode,
			path: selection.path,
			resolvedPaths: [...selection.filePaths],
			subfileCount: selection.subfileCount,
		}));
	}

	private hashText(value: string): string {
		let hash = 2166136261;
		for (let index = 0; index < value.length; index += 1) {
			hash ^= value.charCodeAt(index);
			hash = Math.imul(hash, 16777619);
		}
		return (hash >>> 0).toString(16);
	}

	private hashBinary(value: Uint8Array): string {
		let hash = 2166136261;
		for (let index = 0; index < value.length; index += 1) {
			hash ^= value[index] ?? 0;
			hash = Math.imul(hash, 16777619);
		}
		return `${value.length.toString(16)}-${(hash >>> 0).toString(16)}`;
	}

	private async prepareUploadPlan(path: string): Promise<SourceUploadPlan | null> {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) {
			return null;
		}

		const uploadMethod = getUploadMethodForPath(path);
		if (!uploadMethod) {
			return null;
		}

		if (uploadMethod === "text") {
			try {
				const textContent = await this.app.vault.cachedRead(file);
				return buildTextUploadPlan({
					path,
					text: textContent,
					contentHash: this.hashText(textContent),
				});
			} catch (error) {
				this.logger.warn("Failed to read text source content", {
					path,
					error: getErrorMessage(error),
				});
				return null;
			}
		}

		const absoluteFilePath = this.resolveAbsoluteVaultFilePath(path);
		if (!absoluteFilePath) {
			this.logger.warn("Failed to resolve full path for file upload", { path });
			return null;
		}

		try {
			const content = await this.app.vault.readBinary(file);
			return buildFileUploadPlan({
				path,
				filePath: absoluteFilePath,
				contentHash: this.hashBinary(new Uint8Array(content)),
			});
		} catch (error) {
			this.logger.warn("Failed to read binary source content", {
				path,
				error: getErrorMessage(error),
			});
			return null;
		}
	}

	private resolveAbsoluteVaultFilePath(path: string): string | null {
		const adapter = this.app.vault.adapter;
		if (!(adapter instanceof FileSystemAdapter)) {
			return null;
		}
		try {
			return adapter.getFullPath(path);
		} catch (error) {
			this.logger.warn("Vault adapter getFullPath failed", {
				path,
				error: getErrorMessage(error),
			});
			return null;
		}
	}

	private registerVaultEvents(): void {
		this.registerEvent(this.app.vault.on("modify", (file: TAbstractFile) => this.handleVaultModifyOrCreate(file)));
		this.registerEvent(this.app.vault.on("create", (file: TAbstractFile) => this.handleVaultModifyOrCreate(file)));
		this.registerEvent(this.app.vault.on("delete", (file: TAbstractFile) => this.handleVaultDelete(file)));
		this.registerEvent(
			this.app.vault.on("rename", (file: TAbstractFile, oldPath: string) => {
				this.handleVaultRename(file, oldPath);
			}),
		);
	}

	private handleVaultModifyOrCreate(file: TAbstractFile): void {
		if (!(file instanceof TFile) || file.extension !== "md") {
			return;
		}

		this.bm25.markPathModified(file.path);
	}

	private handleVaultDelete(file: TAbstractFile): void {
		if (!(file instanceof TFile) || file.extension !== "md") {
			return;
		}

		this.bm25.markPathDeleted(file.path);
	}

	private handleVaultRename(file: TAbstractFile, oldPath: string): void {
		if (!(file instanceof TFile) || !oldPath || oldPath === file.path) {
			return;
		}

		const oldIsMarkdown = oldPath.toLowerCase().endsWith(".md");
		const newIsMarkdown = file.extension === "md";
		if (oldIsMarkdown) {
			this.bm25.markPathDeleted(oldPath);
		}
		if (newIsMarkdown) {
			this.bm25.markPathModified(file.path);
		}

		if (!oldIsMarkdown && !newIsMarkdown) {
			return;
		}

		if (oldIsMarkdown && newIsMarkdown) {
			const renamed = this.store.renameSourcePath(oldPath, file.path);
			if (renamed) {
				void this.store.save();
			}
			return;
		}

		if (oldIsMarkdown && !newIsMarkdown) {
			const removed = this.store.removeSourceByPath(oldPath);
			if (removed) {
				void this.store.save();
			}
			return;
		}
	}

	private async activateChatView(): Promise<void> {
		const existingLeaves = this.app.workspace.getLeavesOfType(NOTEBOOKLM_CHAT_VIEW_TYPE);
		const [primaryLeaf, ...extraLeaves] = existingLeaves;

		for (const leaf of extraLeaves) {
			leaf.detach();
		}

		let leaf: WorkspaceLeaf | null = primaryLeaf ?? null;
		if (!leaf) {
			leaf = this.app.workspace.getRightLeaf(false) ?? this.app.workspace.getRightLeaf(true);
		}
		if (!leaf) {
			return;
		}

		const currentState = leaf.getViewState();
		if (currentState.type !== NOTEBOOKLM_CHAT_VIEW_TYPE) {
			await leaf.setViewState({ type: NOTEBOOKLM_CHAT_VIEW_TYPE, active: true });
		}

		this.app.workspace.revealLeaf(leaf);
	}
}
