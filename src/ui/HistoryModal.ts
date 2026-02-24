import { App, Modal, Notice } from "obsidian";
import type { ConversationRecord } from "../types";

interface HistoryModalProps {
	conversations: ConversationRecord[];
	onSelect: (conversationId: string) => Promise<void>;
}

export class HistoryModal extends Modal {
	private readonly conversations: ConversationRecord[];
	private readonly onSelect: (conversationId: string) => Promise<void>;
	private selecting = false;

	constructor(app: App, props: HistoryModalProps) {
		super(app);
		this.conversations = props.conversations;
		this.onSelect = props.onSelect;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h3", { text: "Conversation history" });

		if (this.conversations.length === 0) {
			contentEl.createEl("p", { text: "No previous conversations yet." });
			return;
		}

		const listEl = contentEl.createDiv({ cls: "nlm-history-list" });
		for (const conversation of this.conversations) {
			const itemEl = listEl.createDiv({ cls: "nlm-history-item" });
			const firstQuestion =
				conversation.messages.find((message) => message.role === "user")?.text ?? "(No user message)";
			const sourceCount = new Set(
				conversation.queryMetadata.flatMap((metadata) => metadata.selectedSourceIds),
			).size;
			const updatedAt = new Date(conversation.updatedAt).toLocaleString();

			itemEl.createDiv({ cls: "nlm-history-item-title", text: firstQuestion.slice(0, 80) });
			itemEl.createDiv({
				cls: "nlm-history-item-meta",
				text: `${updatedAt} | Sources: ${sourceCount}`,
			});

			itemEl.addEventListener("click", () => {
				void this.selectConversation(conversation.id);
			});
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private async selectConversation(conversationId: string): Promise<void> {
		if (this.selecting) {
			return;
		}

		this.selecting = true;
		try {
			await this.onSelect(conversationId);
			this.close();
		} catch (error) {
			new Notice(`Failed to load conversation: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			this.selecting = false;
		}
	}
}
