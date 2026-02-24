import { ButtonComponent, ItemView, MarkdownRenderer, Notice, WorkspaceLeaf } from "obsidian";
import type NotebookLMPlugin from "../main";
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
		this.renderLayout();
		this.renderMessages();
	}

	async onClose(): Promise<void> {
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

	private renderMessages(): void {
		const currentRenderVersion = ++this.renderVersion;
		void this.renderMessagesInternal(currentRenderVersion);
	}

	private async renderMessagesInternal(renderVersion: number): Promise<void> {
		if (!this.messageListEl) {
			return;
		}

		const messageListEl = this.messageListEl;
		messageListEl.empty();
		const conversation = this.plugin.getActiveConversation();
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

		if (this.busy) {
			messageListEl.createDiv({ cls: "nlm-chat-pending", text: "NotebookLM is working..." });
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
}
