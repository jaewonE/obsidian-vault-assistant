import { Notice, Plugin, TAbstractFile, TFile, WorkspaceLeaf } from "obsidian";
import { Logger } from "../logging/logger";
import { NotebookLMMcpBinaryMissingError, NotebookLMMcpClient } from "../mcp/NotebookLMMcpClient";
import { BM25 } from "../search/BM25";
import { PluginDataStore } from "../storage/PluginDataStore";
import {
	ConversationQueryMetadata,
	ConversationRecord,
	DEFAULT_SETTINGS,
	NotebookLMPluginSettings,
	SOURCE_TARGET_CAPACITY,
	SourceEvictionRecord,
} from "../types";
import { ChatView } from "../ui/ChatView";
import { NOTEBOOKLM_CHAT_VIEW_TYPE } from "../ui/constants";
import { NotebookLMSettingTab } from "../ui/SettingsTab";

interface JsonObject {
	[key: string]: unknown;
}

function isRecord(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null;
}

function getErrorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
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

export default class NotebookLMObsidianPlugin extends Plugin {
	private store!: PluginDataStore;
	private logger!: Logger;
	private bm25!: BM25;
	private mcpClient!: NotebookLMMcpClient;
	private activeConversationId: string | null = null;
	private remoteSourceIds = new Set<string>();

	get settings(): NotebookLMPluginSettings {
		return this.store.getSettings();
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
		}

		if (pathsToEnsure.size > 0) {
			try {
				await this.ensureNotebookReady();
				await this.ensureSourcesForPaths([...pathsToEnsure], []);
				await this.store.save();
			} catch (error) {
				this.logger.warn("Failed to ensure history conversation sources", getErrorMessage(error));
			}
		}

		return conversation;
	}

	async handleUserQuery(query: string): Promise<void> {
		const trimmedQuery = query.trim();
		if (!trimmedQuery) {
			return;
		}

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

		const queryMetadata: ConversationQueryMetadata = {
			at: userMessageTime,
			bm25Selection: {
				query: trimmedQuery,
				topN: this.settings.bm25TopN,
				cutoffRatio: this.settings.bm25CutoffRatio,
				minK: this.settings.bm25MinSourcesK,
				top15: [],
				selected: [],
			},
			selectedSourceIds: [],
			evictions: [],
		};

		let assistantResponse = "";

		try {
			const notebookId = await this.ensureNotebookReady();
			const bm25Result = await this.bm25.search(trimmedQuery, {
				topN: this.settings.bm25TopN,
				cutoffRatio: this.settings.bm25CutoffRatio,
				minK: this.settings.bm25MinSourcesK,
				k1: this.settings.bm25k1,
				b: this.settings.bm25b,
			});

			queryMetadata.bm25Selection.top15 = bm25Result.topResults.map((item) => ({
				path: item.path,
				score: item.score,
			}));
			queryMetadata.bm25Selection.selected = bm25Result.selected.map((item) => ({
				path: item.path,
				score: item.score,
			}));

			if (bm25Result.selected.length === 0) {
				throw new Error("No markdown files available to query.");
			}

			const pathToSourceId = await this.ensureSourcesForPaths(
				bm25Result.selected.map((item) => item.path),
				queryMetadata.evictions,
			);

			queryMetadata.bm25Selection.selected = bm25Result.selected.map((item) => ({
				path: item.path,
				score: item.score,
				sourceId: pathToSourceId[item.path],
			}));

			const sourceIds = bm25Result.selected
				.map((item) => pathToSourceId[item.path])
				.filter((value): value is string => typeof value === "string" && value.length > 0);

			if (sourceIds.length === 0) {
				throw new Error("Failed to prepare NotebookLM sources for this query.");
			}

			queryMetadata.selectedSourceIds = sourceIds;

			const queryArgs: Record<string, unknown> = {
				notebook_id: notebookId,
				query: trimmedQuery,
				source_ids: sourceIds,
				timeout: this.settings.queryTimeoutSeconds,
			};
			if (conversation.notebookConversationId) {
				queryArgs.conversation_id = conversation.notebookConversationId;
			}

			let queryResult = await this.mcpClient.callTool<JsonObject>("notebook_query", queryArgs);
			try {
				this.ensureToolSuccess("notebook_query", queryResult);
			} catch (error) {
				if (
					conversation.notebookConversationId &&
					this.isConversationContextError(getErrorMessage(error))
				) {
					delete queryArgs.conversation_id;
					conversation.notebookConversationId = undefined;
					queryResult = await this.mcpClient.callTool<JsonObject>("notebook_query", queryArgs);
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
		} catch (error) {
			const message = this.userFacingError(error);
			assistantResponse = message;
			queryMetadata.errors = [getErrorMessage(error)];
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
		this.store.saveConversation(conversation);
		await this.store.save();
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
			const refreshResult = await this.mcpClient.callTool<JsonObject>("refresh_auth", {});
			this.ensureToolSuccess("refresh_auth", refreshResult);
			await this.mcpClient.callTool<JsonObject>("server_info", {});
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

	private async startMcpServer(): Promise<void> {
		try {
			await this.ensureMcpConnected();
			await this.mcpClient.callTool<JsonObject>("server_info", {});
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

		let notebookId = this.settings.notebookId;
		if (notebookId) {
			try {
				const notebookResult = await this.mcpClient.callTool<JsonObject>("notebook_get", {
					notebook_id: notebookId,
				});
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

		const createResult = await this.mcpClient.callTool<JsonObject>("notebook_create", {
			title: NOTEBOOK_TITLE,
		});
		this.ensureToolSuccess("notebook_create", createResult);
		notebookId = this.extractNotebookId(createResult);
		if (!notebookId) {
			throw new Error("notebook_create succeeded but notebook_id was missing");
		}

		this.store.updateSettings({ notebookId });
		const notebookResult = await this.mcpClient.callTool<JsonObject>("notebook_get", {
			notebook_id: notebookId,
		});
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
		paths: string[],
		evictions: SourceEvictionRecord[],
	): Promise<Record<string, string>> {
		const notebookId = await this.ensureNotebookReady();
		const pathToSourceId: Record<string, string> = {};
		const protectedCapacity = this.getProtectedCapacity();

		for (const path of paths) {
			const existing = this.store.getSourceEntryByPath(path);
			if (existing && !existing.stale && this.remoteSourceIds.has(existing.sourceId)) {
				pathToSourceId[path] = existing.sourceId;
				continue;
			}

			const file = this.app.vault.getAbstractFileByPath(path);
			if (!(file instanceof TFile)) {
				continue;
			}

			await this.evictUntilCapacity(evictions);

			const content = await this.app.vault.cachedRead(file);
			const addResult = await this.mcpClient.callTool<JsonObject>("source_add", {
				notebook_id: notebookId,
				source_type: "text",
				text: content,
				title: path,
				wait: true,
			});
			this.ensureToolSuccess("source_add", addResult);

			const sourceId = this.extractSourceId(addResult);
			if (!sourceId) {
				throw new Error(`source_add for ${path} did not return source_id`);
			}

			this.store.upsertSource({
				path,
				sourceId,
				title: path,
				contentHash: this.hashText(content),
			});
			this.remoteSourceIds.add(sourceId);
			pathToSourceId[path] = sourceId;
		}

		for (const path of paths) {
			this.store.markSourceUsed(path, protectedCapacity);
		}

		return pathToSourceId;
	}

	private async evictUntilCapacity(evictions: SourceEvictionRecord[]): Promise<void> {
		while (this.store.getActiveSourceCount() >= SOURCE_TARGET_CAPACITY) {
			const candidatePath = this.store.getEvictionCandidatePath();
			if (!candidatePath) {
				break;
			}

			const candidate = this.store.getSourceEntryByPath(candidatePath);
			if (!candidate) {
				this.store.removeSourceByPath(candidatePath);
				continue;
			}

			if (candidate.stale) {
				this.store.removeSourceByPath(candidate.path);
				continue;
			}

			let removed = false;
			try {
				const deleteResult = await this.mcpClient.callTool<JsonObject>("source_delete", {
					source_id: candidate.sourceId,
					confirm: true,
				});
				const failure = this.getToolFailure(deleteResult);
				if (!failure) {
					removed = true;
				} else if (failure.toLowerCase().includes("not found")) {
					removed = true;
				} else {
					throw new Error(failure);
				}
			} catch (error) {
				if (getErrorMessage(error).toLowerCase().includes("not found")) {
					removed = true;
				} else {
					throw error;
				}
			}

			if (!removed) {
				break;
			}

			this.store.removeSourceByPath(candidate.path);
			this.remoteSourceIds.delete(candidate.sourceId);
			const eviction: SourceEvictionRecord = {
				path: candidate.path,
				sourceId: candidate.sourceId,
				evictedAt: new Date().toISOString(),
				reason: "source-capacity-target",
			};
			evictions.push(eviction);
			this.logger.debug("Evicted NotebookLM source", eviction);
		}
	}

	private getProtectedCapacity(): number {
		return Math.max(1, Math.floor(SOURCE_TARGET_CAPACITY * PROTECTED_CAPACITY_RATIO));
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

	private hashText(value: string): string {
		let hash = 2166136261;
		for (let index = 0; index < value.length; index += 1) {
			hash ^= value.charCodeAt(index);
			hash = Math.imul(hash, 16777619);
		}
		return (hash >>> 0).toString(16);
	}

	private registerVaultEvents(): void {
		this.registerEvent(this.app.vault.on("modify", (file: TAbstractFile) => this.markBm25Dirty(file)));
		this.registerEvent(this.app.vault.on("create", (file: TAbstractFile) => this.markBm25Dirty(file)));
		this.registerEvent(this.app.vault.on("delete", (file: TAbstractFile) => this.markBm25Dirty(file)));
		this.registerEvent(
			this.app.vault.on("rename", (file: TAbstractFile) => {
				this.markBm25Dirty(file);
			}),
		);
	}

	private markBm25Dirty(file: TAbstractFile): void {
		if (!(file instanceof TFile) || file.extension !== "md") {
			return;
		}

		this.bm25.markDirty();
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
