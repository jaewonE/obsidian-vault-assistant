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
	ConversationQueryMetadata,
	ConversationRecord,
	DEFAULT_SETTINGS,
	ExplicitSelectionMetadata,
	NotebookLMPluginSettings,
	QueryProgressState,
	QuerySourceItem,
	ResolveComposerSelectionResult,
	SOURCE_TARGET_CAPACITY,
	SourceEvictionRecord,
} from "../types";
import { ChatView } from "../ui/ChatView";
import { NOTEBOOKLM_CHAT_VIEW_TYPE } from "../ui/constants";
import { NotebookLMSettingTab } from "../ui/SettingsTab";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function getErrorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
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

const SETTINGS_LIMITS = {
	topN: { min: 1, max: 200 },
	cutoffRatio: { min: 0, max: 1 },
	minSourcesK: { min: 1, max: 50 },
	k1: { min: 0, max: 5 },
	b: { min: 0, max: 1 },
	queryTimeoutSeconds: { min: 5, max: 600 },
} as const;

type QueryStepKey = "search" | "upload" | "response";

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
		const items: QuerySourceItem[] = [];
		for (const rawSourceId of sourceIds) {
			const sourceId = this.store.resolveSourceId(rawSourceId);
			if (!sourceId || seen.has(sourceId)) {
				continue;
			}
			seen.add(sourceId);

			const path = this.store.getSourcePathById(sourceId);
			if (!path) {
				continue;
			}

			items.push({
				sourceId,
				path,
				title: this.getFileTitleFromPath(path),
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
			if (selectedUploadPaths.length === 0 && historicalSourceIds.length === 0) {
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

			const uploadedPaths = new Set<string>();
			const reusedPaths = new Set<string>();
			const pathToSourceId = await this.ensureSourcesForPaths(
				notebookId,
				selectedUploadPaths,
				queryMetadata.evictions,
				(sourceProgress) => {
					if (sourceProgress.action === "ready") {
						if (sourceProgress.uploaded) {
							uploadedPaths.add(sourceProgress.path);
						} else {
							reusedPaths.add(sourceProgress.path);
						}
					}

					let uploadDetail = `Checking (${sourceProgress.index}/${sourceProgress.total}): ${sourceProgress.path}`;
					if (sourceProgress.action === "uploading") {
						uploadDetail = `Uploading (${sourceProgress.index}/${sourceProgress.total}): ${sourceProgress.path}`;
					} else if (sourceProgress.action === "ready") {
						uploadDetail = sourceProgress.uploaded
							? `Uploaded (${sourceProgress.index}/${sourceProgress.total}): ${sourceProgress.path}`
							: `Already uploaded (${sourceProgress.index}/${sourceProgress.total}): ${sourceProgress.path}`;
					}

					updateProgress({
						uploadDetail,
						upload: {
							total: sourceProgress.total,
							currentIndex: sourceProgress.index,
							currentPath: sourceProgress.path,
							uploadedCount: uploadedPaths.size,
							reusedCount: reusedPaths.size,
						},
					});
				},
			);

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
			const currentSelectionSourceIds = [...new Set([...bm25SourceIds, ...explicitSourceIds])];

			const sourceIdsSet = new Set(currentSelectionSourceIds);
			const carriedFromHistory = historicalSourceIds.filter((sourceId) => !sourceIdsSet.has(sourceId));
			const mergedSourceIds = [...new Set([...historicalSourceIds, ...currentSelectionSourceIds])];
			if (mergedSourceIds.length === 0) {
				throw new Error("Failed to prepare NotebookLM sources for this query.");
			}
			const newlyPreparedCount = uploadedPaths.size;
			const reusedFromSelectionCount = Math.max(0, currentSelectionSourceIds.length - newlyPreparedCount);
			const totalQuerySourceCount = mergedSourceIds.length;
			queryMetadata.selectedSourceIds = mergedSourceIds;
			queryMetadata.sourceSummary = {
				bm25SelectedCount: bm25SourceIds.length,
				explicitSelectedCount: explicitSourceIds.length,
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
		return ensureSourcesForPaths(
			{
				notebookId,
				paths,
				evictions,
				protectedCapacity: this.getProtectedCapacity(),
				onProgress,
			},
			this.getSourcePreparationDependencies(),
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
