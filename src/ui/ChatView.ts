import { ButtonComponent, ItemView, MarkdownRenderer, Notice, WorkspaceLeaf } from "obsidian";
import type NotebookLMPlugin from "../main";
import type {
	ConversationQueryMetadata,
	QueryProgressState,
	QueryProgressStepState,
	QuerySourceItem,
} from "../types";
import { HistoryModal } from "./HistoryModal";
import { NOTEBOOKLM_CHAT_VIEW_TYPE } from "./constants";

export class ChatView extends ItemView {
	private readonly plugin: NotebookLMPlugin;
	private messageListEl: HTMLDivElement | null = null;
	private inputEl: HTMLTextAreaElement | null = null;
	private sendButton: ButtonComponent | null = null;
	private newButton: ButtonComponent | null = null;
	private historyButton: ButtonComponent | null = null;
	private busy = false;
	private renderVersion = 0;
	private queryProgress: QueryProgressState | null = null;
	private unsubscribeProgress: (() => void) | null = null;
	private sourceListExpandedByMessageKey = new Map<string, boolean>();

	constructor(leaf: WorkspaceLeaf, plugin: NotebookLMPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return NOTEBOOKLM_CHAT_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "NotebookLM chat";
	}

	getIcon(): string {
		return "messages-square";
	}

	async onOpen(): Promise<void> {
		this.queryProgress = this.plugin.getQueryProgress();
		this.unsubscribeProgress?.();
		this.unsubscribeProgress = this.plugin.onQueryProgressChange((progress) => {
			this.queryProgress = progress;
			this.renderMessages();
		});
		this.renderLayout();
		this.renderMessages();
	}

	async onClose(): Promise<void> {
		this.unsubscribeProgress?.();
		this.unsubscribeProgress = null;
		this.contentEl.empty();
	}

	private renderLayout(): void {
		this.contentEl.empty();
		this.contentEl.addClass("nlm-chat-view");

		const rootEl = this.contentEl.createDiv({ cls: "nlm-chat-root" });
		const headerEl = rootEl.createDiv({ cls: "nlm-chat-header" });
		headerEl.createDiv({ cls: "nlm-chat-title", text: "NotebookLM chat" });

		const actionsEl = headerEl.createDiv({ cls: "nlm-chat-actions" });
		this.newButton = new ButtonComponent(actionsEl)
			.setButtonText("New")
			.onClick(() => {
				void this.handleNewConversation();
			});

		this.historyButton = new ButtonComponent(actionsEl)
			.setButtonText("History")
			.onClick(() => {
				void this.openHistoryModal();
			});

		this.messageListEl = rootEl.createDiv({ cls: "nlm-chat-messages" });

		const composerEl = rootEl.createDiv({ cls: "nlm-chat-composer" });
		this.inputEl = composerEl.createEl("textarea", {
			cls: "nlm-chat-input",
			attr: {
				placeholder: "Ask about your vault...",
				rows: "3",
			},
		});
		this.inputEl.addEventListener("keydown", (event: KeyboardEvent) => {
			if (event.key !== "Enter" || event.shiftKey) {
				return;
			}

			event.preventDefault();
			void this.sendMessage();
		});

		this.sendButton = new ButtonComponent(composerEl)
			.setButtonText("Send")
			.setCta()
			.onClick(() => {
				void this.sendMessage();
			});
	}

	private renderMessages(preserveScrollPosition = false): void {
		const currentRenderVersion = ++this.renderVersion;
		void this.renderMessagesInternal(currentRenderVersion, preserveScrollPosition);
	}

	private async renderMessagesInternal(
		renderVersion: number,
		preserveScrollPosition: boolean,
	): Promise<void> {
		if (!this.messageListEl) {
			return;
		}

		const messageListEl = this.messageListEl;
		const previousScrollTop = messageListEl.scrollTop;
		messageListEl.empty();
		const conversation = this.plugin.getActiveConversation();
		let assistantMessageIndex = 0;
		if (conversation.messages.length === 0) {
			messageListEl.createDiv({
				cls: "nlm-chat-empty",
				text: "Ask a question to run BM25 over your vault and query NotebookLM.",
			});
		}

		for (const message of conversation.messages) {
			if (renderVersion !== this.renderVersion || this.messageListEl !== messageListEl) {
				return;
			}

			const messageEl = messageListEl.createDiv({
				cls: `nlm-chat-message nlm-chat-${message.role}`,
			});
			if (message.role === "assistant") {
				const queryMetadata = conversation.queryMetadata[assistantMessageIndex] ?? null;
				const messageKey = `${conversation.id}:${assistantMessageIndex}:${message.at}`;
				assistantMessageIndex += 1;
				this.renderAssistantSources(messageEl, queryMetadata, messageKey);

				const bodyEl = messageEl.createDiv({
					cls: "nlm-chat-message-body nlm-chat-message-markdown",
				});
				try {
					await MarkdownRenderer.render(this.app, message.text, bodyEl, "", this);
				} catch {
					bodyEl.setText(message.text);
				}
			} else {
				messageEl.createDiv({ cls: "nlm-chat-message-body", text: message.text });
			}
			messageEl.createDiv({
				cls: "nlm-chat-message-time",
				text: new Date(message.at).toLocaleTimeString(),
			});
		}

		if (renderVersion !== this.renderVersion || this.messageListEl !== messageListEl) {
			return;
		}

		if (this.queryProgress) {
			this.renderProgressPanel(messageListEl, this.queryProgress);
		} else if (this.busy) {
			messageListEl.createDiv({ cls: "nlm-chat-pending", text: "NotebookLM is working..." });
		}

		if (preserveScrollPosition) {
			messageListEl.scrollTop = previousScrollTop;
			return;
		}

		messageListEl.scrollTop = messageListEl.scrollHeight;
	}

	private async sendMessage(): Promise<void> {
		if (this.busy || !this.inputEl) {
			return;
		}

		const query = this.inputEl.value.trim();
		if (!query) {
			return;
		}

		this.inputEl.value = "";
		this.setBusy(true);

		try {
			const runPromise = this.plugin.handleUserQuery(query);
			this.renderMessages();
			await runPromise;
		} catch (error) {
			new Notice(`Failed to send query: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			this.setBusy(false);
			this.renderMessages();
			this.inputEl.focus();
		}
	}

	private async handleNewConversation(): Promise<void> {
		if (this.busy) {
			return;
		}

		await this.plugin.startNewConversation();
		this.sourceListExpandedByMessageKey.clear();
		this.renderMessages();
		this.inputEl?.focus();
	}

	private async openHistoryModal(): Promise<void> {
		if (this.busy) {
			return;
		}

		const modal = new HistoryModal(this.app, {
			conversations: this.plugin.getConversationHistory(),
			onSelect: async (conversationId: string) => {
				this.setBusy(true);
				try {
					await this.plugin.loadConversation(conversationId);
					this.sourceListExpandedByMessageKey.clear();
					this.renderMessages();
				} finally {
					this.setBusy(false);
				}
			},
		});
		modal.open();
	}

	private setBusy(isBusy: boolean): void {
		this.busy = isBusy;
		if (this.inputEl) {
			this.inputEl.disabled = isBusy;
		}
		this.sendButton?.setDisabled(isBusy);
		this.newButton?.setDisabled(isBusy);
		this.historyButton?.setDisabled(isBusy);
	}

	private renderAssistantSources(
		messageEl: HTMLDivElement,
		queryMetadata: ConversationQueryMetadata | null,
		messageKey: string,
	): void {
		if (!queryMetadata || queryMetadata.selectedSourceIds.length === 0) {
			return;
		}

		const sourceItems = this.plugin.getSourceItemsForIds(queryMetadata.selectedSourceIds);
		if (sourceItems.length === 0) {
			return;
		}

		const expanded = this.sourceListExpandedByMessageKey.get(messageKey) ?? false;
		const sourceAreaEl = messageEl.createDiv({ cls: "nlm-chat-sources" });
		if (queryMetadata.sourceSummary) {
			sourceAreaEl.createDiv({
				cls: "nlm-chat-sources-summary",
				text: `Step 1: ${queryMetadata.sourceSummary.newlyPreparedCount} newly prepared source${queryMetadata.sourceSummary.newlyPreparedCount === 1 ? "" : "s"} for this question.`,
			});
			sourceAreaEl.createDiv({
				cls: "nlm-chat-sources-summary",
				text: `Step 2: ${queryMetadata.sourceSummary.totalQuerySourceCount} total source${queryMetadata.sourceSummary.totalQuerySourceCount === 1 ? "" : "s"} used for answer generation.`,
			});
		}
		const toggleButtonEl = sourceAreaEl.createEl("button", {
			cls: "nlm-chat-sources-toggle",
			text: expanded
				? `Hide sources (${sourceItems.length})`
				: `Show sources (${sourceItems.length})`,
		});
		toggleButtonEl.type = "button";
		toggleButtonEl.addEventListener("click", () => {
			this.sourceListExpandedByMessageKey.set(messageKey, !expanded);
			this.renderMessages(true);
		});

		if (!expanded) {
			return;
		}

		const listEl = sourceAreaEl.createDiv({ cls: "nlm-chat-sources-list" });
		for (const sourceItem of sourceItems) {
			this.renderSourceItem(listEl, sourceItem);
		}
	}

	private renderSourceItem(listEl: HTMLDivElement, sourceItem: QuerySourceItem): void {
		const sourceButtonEl = listEl.createEl("button", {
			cls: "nlm-chat-source-item",
			text: sourceItem.title,
		});
		sourceButtonEl.type = "button";
		sourceButtonEl.addEventListener("click", () => {
			void this.plugin.openSourceInNewTab(sourceItem.path);
		});
	}

	private renderProgressPanel(containerEl: HTMLDivElement, progress: QueryProgressState): void {
		const panelEl = containerEl.createDiv({ cls: "nlm-chat-progress" });
		panelEl.createDiv({ cls: "nlm-chat-progress-title", text: "NotebookLM process" });

		this.renderProgressStep(panelEl, "1", "Search and select documents", progress.steps.search, progress.searchDetail);
		const uploadStepEl = this.renderProgressStep(
			panelEl,
			"2",
			"Upload selected documents",
			progress.steps.upload,
			progress.uploadDetail,
		);
		uploadStepEl.createDiv({
			cls: "nlm-chat-progress-meta",
			text: `Uploaded ${progress.upload.uploadedCount}, reused ${progress.upload.reusedCount}, total ${progress.upload.total}`,
		});
		if (progress.steps.upload === "active" && progress.upload.currentPath) {
			uploadStepEl.createDiv({
				cls: "nlm-chat-progress-current",
				text: `Current file: ${progress.upload.currentPath}`,
			});
		}

		this.renderProgressStep(
			panelEl,
			"3",
			"Wait for NotebookLM response",
			progress.steps.response,
			progress.responseDetail,
		);
	}

	private renderProgressStep(
		panelEl: HTMLDivElement,
		stepNumber: string,
		label: string,
		state: QueryProgressStepState,
		detail: string,
	): HTMLDivElement {
		const stepEl = panelEl.createDiv({
			cls: `nlm-chat-progress-step nlm-chat-progress-step-${state}`,
		});
		stepEl.createDiv({
			cls: "nlm-chat-progress-step-title",
			text: `${stepNumber}. ${label}`,
		});
		stepEl.createDiv({
			cls: `nlm-chat-progress-state nlm-chat-progress-state-${state}`,
			text: this.getProgressStateLabel(state),
		});
		stepEl.createDiv({
			cls: "nlm-chat-progress-detail",
			text: detail,
		});
		return stepEl;
	}

	private getProgressStateLabel(state: QueryProgressStepState): string {
		if (state === "done") {
			return "Done";
		}
		if (state === "active") {
			return "In progress";
		}
		if (state === "failed") {
			return "Failed";
		}
		return "Pending";
	}
}
