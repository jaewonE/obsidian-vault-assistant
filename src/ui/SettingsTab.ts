import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type NotebookLMPlugin from "../main";

export class NotebookLMSettingTab extends PluginSettingTab {
	private readonly plugin: NotebookLMPlugin;

	constructor(app: App, plugin: NotebookLMPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("h2", { text: "NotebookLM settings" });

		new Setting(containerEl)
			.setName("Debug mode")
			.setDesc("Log MCP lifecycle, tool calls, and BM25 stats to console.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.debugMode).onChange(async (value) => {
					await this.plugin.setDebugMode(value);
				}),
			);

		new Setting(containerEl)
			.setName("Refresh auth")
			.setDesc("Calls refresh_auth() and verifies NotebookLM connectivity.")
			.addButton((button) =>
				button.setButtonText("Refresh Auth").onClick(async () => {
					button.setDisabled(true);
					try {
						await this.plugin.refreshAuthFromSettings();
						new Notice("NotebookLM auth refresh completed.");
					} finally {
						button.setDisabled(false);
					}
				}),
			);

		this.addNumberSetting({
			containerEl,
			name: "BM25 Top N",
			desc: "Initial ranked pool size.",
			value: this.plugin.settings.bm25TopN,
			min: 1,
			step: 1,
			onSave: async (nextValue: number) => this.plugin.updateNumericSetting("bm25TopN", nextValue),
		});

		this.addNumberSetting({
			containerEl,
			name: "BM25 cutoff ratio",
			desc: "Keep docs with score >= topScore * cutoffRatio.",
			value: this.plugin.settings.bm25CutoffRatio,
			min: 0,
			max: 1,
			step: 0.01,
			onSave: async (nextValue: number) => this.plugin.updateNumericSetting("bm25CutoffRatio", nextValue),
		});

		this.addNumberSetting({
			containerEl,
			name: "BM25 min K",
			desc: "Force at least this many sources.",
			value: this.plugin.settings.bm25MinSourcesK,
			min: 1,
			step: 1,
			onSave: async (nextValue: number) => this.plugin.updateNumericSetting("bm25MinSourcesK", nextValue),
		});

		this.addNumberSetting({
			containerEl,
			name: "BM25 k1",
			desc: "BM25 term frequency saturation parameter.",
			value: this.plugin.settings.bm25k1,
			min: 0,
			step: 0.1,
			onSave: async (nextValue: number) => this.plugin.updateNumericSetting("bm25k1", nextValue),
		});

		this.addNumberSetting({
			containerEl,
			name: "BM25 b",
			desc: "BM25 document length normalization parameter.",
			value: this.plugin.settings.bm25b,
			min: 0,
			max: 1,
			step: 0.01,
			onSave: async (nextValue: number) => this.plugin.updateNumericSetting("bm25b", nextValue),
		});

		this.addNumberSetting({
			containerEl,
			name: "Query timeout (seconds)",
			desc: "Passed to notebook_query and used for MCP request timeouts (with a small buffer).",
			value: this.plugin.settings.queryTimeoutSeconds,
			min: 5,
			step: 1,
			onSave: async (nextValue: number) => this.plugin.updateNumericSetting("queryTimeoutSeconds", nextValue),
		});
	}

	private addNumberSetting(params: {
		containerEl: HTMLElement;
		name: string;
		desc: string;
		value: number;
		onSave: (nextValue: number) => Promise<void>;
		min?: number;
		max?: number;
		step?: number;
	}): void {
		new Setting(params.containerEl)
			.setName(params.name)
			.setDesc(params.desc)
			.addText((text) => {
				text.inputEl.type = "number";
				if (params.min !== undefined) {
					text.inputEl.min = String(params.min);
				}
				if (params.max !== undefined) {
					text.inputEl.max = String(params.max);
				}
				if (params.step !== undefined) {
					text.inputEl.step = String(params.step);
				}

				text.setValue(String(params.value));
				text.onChange(async (rawValue) => {
					if (rawValue.trim().length === 0) {
						return;
					}

					const parsed = Number(rawValue);
					if (!Number.isFinite(parsed)) {
						return;
					}

					if (params.min !== undefined && parsed < params.min) {
						return;
					}

					if (params.max !== undefined && parsed > params.max) {
						return;
					}

					await params.onSave(parsed);
				});
			});
	}
}
