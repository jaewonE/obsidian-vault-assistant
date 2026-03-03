import { App, Component, MarkdownRenderer, Modal } from "obsidian";

interface DeepResearchReportModalProps {
	title: string;
	report: string;
}

export class DeepResearchReportModal extends Modal {
	private readonly titleText: string;
	private readonly report: string;
	private renderComponent: Component | null = null;

	constructor(app: App, props: DeepResearchReportModalProps) {
		super(app);
		this.titleText = props.title;
		this.report = props.report;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h3", { text: this.titleText });

		if (!this.report.trim()) {
			contentEl.createEl("p", { text: "No deep research report is available." });
			return;
		}

		const bodyEl = contentEl.createDiv({ cls: "nlm-research-report-body" });
		this.renderComponent?.unload();
		this.renderComponent = new Component();
		this.renderComponent.load();
		void MarkdownRenderer.render(this.app, this.report, bodyEl, "", this.renderComponent);
	}

	onClose(): void {
		this.renderComponent?.unload();
		this.renderComponent = null;
		this.contentEl.empty();
	}
}
