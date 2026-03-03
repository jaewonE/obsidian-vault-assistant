import { App, Modal } from "obsidian";
import { openInDefaultBrowser } from "./externalBrowser";

interface ResearchLinksModalItem {
	sourceId?: string;
	title: string;
	url: string;
	fetchFailed?: boolean;
}

interface ResearchLinksModalProps {
	title: string;
	items: ResearchLinksModalItem[];
}

export class ResearchLinksModal extends Modal {
	private readonly titleText: string;
	private readonly items: ResearchLinksModalItem[];

	constructor(app: App, props: ResearchLinksModalProps) {
		super(app);
		this.titleText = props.title;
		this.items = props.items;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h3", { text: this.titleText });

		if (this.items.length === 0) {
			contentEl.createEl("p", { text: "No available links." });
			return;
		}

		const listEl = contentEl.createDiv({ cls: "nlm-research-links-list" });
		for (const item of this.items) {
			const buttonEl = listEl.createEl("button", {
				cls: "nlm-research-links-item",
			});
			if (item.fetchFailed) {
				buttonEl.addClass("nlm-research-links-item-failed");
				buttonEl.setAttribute(
					"title",
					"Source retrieval from NotebookLM failed (often due to bot protection). You can still open this link.",
				);
			}
			buttonEl.type = "button";
			buttonEl.createDiv({ cls: "nlm-research-links-item-title", text: item.title });
			buttonEl.createDiv({ cls: "nlm-research-links-item-url", text: item.url });
			buttonEl.addEventListener("click", () => {
				openInDefaultBrowser(item.url);
				this.close();
			});
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
