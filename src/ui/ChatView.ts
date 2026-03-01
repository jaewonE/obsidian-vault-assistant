import { ButtonComponent, ItemView, MarkdownRenderer, Notice, WorkspaceLeaf, setIcon } from "obsidian";
import type NotebookLMPlugin from "../main";
import type {
	AddFilePathSearchItem,
	ConversationQueryMetadata,
	ComposerSelectionItem,
	ComposerSelectionUploadStatus,
	QueryProgressState,
	QueryProgressStepState,
	QuerySourceItem,
} from "../types";
import { HistoryModal } from "./HistoryModal";
import { NOTEBOOKLM_CHAT_VIEW_TYPE } from "./constants";
import {
	type AddFilePathMentionContext,
	getActiveAddFilePathMention,
	replaceMentionToken,
} from "./pathMention";

const FILE_EXTENSION_ICON_BY_NAME: Record<string, string> = {
	md: "file-text",
	canvas: "layout-dashboard",
	base: "database",
	pdf: "file-text",
	csv: "table",
	tsv: "table",
	json: "braces",
	yaml: "list-tree",
	yml: "list-tree",
	txt: "file",
};

const IMAGE_EXTENSIONS = new Set([
	"png",
	"jpg",
	"jpeg",
	"gif",
	"webp",
	"svg",
	"bmp",
	"tif",
	"tiff",
	"heic",
	"ico",
]);
const VIDEO_EXTENSIONS = new Set([
	"mp4",
	"mov",
	"mkv",
	"avi",
	"webm",
	"m4v",
	"wmv",
	"flv",
]);
const CODE_EXTENSIONS = new Set([
	"js",
	"mjs",
	"cjs",
	"ts",
	"jsx",
	"tsx",
	"py",
	"c",
	"cc",
	"cpp",
	"cxx",
	"h",
	"hh",
	"hpp",
	"hxx",
	"java",
	"r",
	"sh",
	"bash",
	"zsh",
	"fish",
	"html",
	"htm",
	"css",
	"scss",
	"sass",
	"sql",
	"go",
	"rs",
	"php",
	"rb",
	"swift",
	"kt",
	"kts",
	"lua",
	"ps1",
]);

function getFileIconNameByExtension(extension?: string): string {
	if (!extension) {
		return "file";
	}

	const normalized = extension.toLocaleLowerCase();
	if (IMAGE_EXTENSIONS.has(normalized)) {
		return "image";
	}
	if (VIDEO_EXTENSIONS.has(normalized)) {
		return "film";
	}
	if (CODE_EXTENSIONS.has(normalized)) {
		return "file-code";
	}

	return FILE_EXTENSION_ICON_BY_NAME[normalized] ?? "file";
}

function getSearchItemIconName(item: AddFilePathSearchItem): string {
	if (item.kind === "path") {
		return "folder";
	}
	return getFileIconNameByExtension(item.extension);
}

function getDisplayParentPath(path: string): string {
	return path.length > 0 ? path : "/";
}

function getLastPathSegment(path: string): string {
	const segments = path.split("/").filter((segment) => segment.length > 0);
	return segments[segments.length - 1] ?? path;
}

export class ChatView extends ItemView {
	private readonly plugin: NotebookLMPlugin;
	private messageListEl: HTMLDivElement | null = null;
	private inputEl: HTMLTextAreaElement | null = null;
	private composerSelectionsEl: HTMLDivElement | null = null;
	private mentionPanelEl: HTMLDivElement | null = null;
	private sendButton: ButtonComponent | null = null;
	private newButton: ButtonComponent | null = null;
	private historyButton: ButtonComponent | null = null;
	private busy = false;
	private renderVersion = 0;
	private queryProgress: QueryProgressState | null = null;
	private unsubscribeProgress: (() => void) | null = null;
	private unsubscribeExplicitUploadState: (() => void) | null = null;
	private sourceListExpandedByMessageKey = new Map<string, boolean>();
	private composerSelections: ComposerSelectionItem[] = [];
	private excludedSourceIds = new Set<string>();
	private excludedPaths = new Set<string>();
	private mentionCandidates: AddFilePathSearchItem[] = [];
	private mentionItemElements: HTMLButtonElement[] = [];
	private mentionSelectionIndex = 0;
	private mentionHoveredIndex: number | null = null;
	private mentionSearchVersion = 0;
	private mentionSuppressedKey: string | null = null;
	private mentionScopeRegistered = false;

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
		this.registerMentionScope();
		this.unsubscribeProgress?.();
		this.unsubscribeProgress = this.plugin.onQueryProgressChange((progress) => {
			this.queryProgress = progress;
			this.renderMessages();
		});
		this.unsubscribeExplicitUploadState?.();
		this.unsubscribeExplicitUploadState = this.plugin.onExplicitUploadStateChange(() => {
			this.renderComposerSelections();
		});
		this.renderLayout();
		this.renderMessages();
	}

	async onClose(): Promise<void> {
		this.unsubscribeProgress?.();
		this.unsubscribeProgress = null;
		this.unsubscribeExplicitUploadState?.();
		this.unsubscribeExplicitUploadState = null;
		this.mentionItemElements = [];
		this.mentionHoveredIndex = null;
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
		this.composerSelectionsEl = composerEl.createDiv({ cls: "nlm-chat-composer-selections" });
		this.composerSelectionsEl.style.display = "none";
		this.inputEl = composerEl.createEl("textarea", {
			cls: "nlm-chat-input",
			attr: {
				placeholder: "Ask about your vault...",
				rows: "3",
			},
		});
		this.inputEl.addEventListener("input", () => {
			void this.handleComposerInputChanged();
		});
		this.inputEl.addEventListener("click", () => {
			void this.handleComposerInputChanged();
		});
		this.registerDomEvent(
			this.inputEl,
			"keydown",
			(event: KeyboardEvent) => {
				this.handleComposerKeydown(event);
			},
			{ capture: true },
		);
		this.mentionPanelEl = composerEl.createDiv({ cls: "nlm-chat-mention-panel" });
		this.mentionPanelEl.style.display = "none";

		this.sendButton = new ButtonComponent(composerEl)
			.setButtonText("Send")
			.setCta()
			.onClick(() => {
				void this.sendMessage();
			});
		this.renderComposerSelections();
		this.renderMentionPanel();
	}

	private registerMentionScope(): void {
		if (this.mentionScopeRegistered) {
			return;
		}

		const scope = this.scope;
		if (!scope) {
			return;
		}
		this.mentionScopeRegistered = true;

		scope.register([], "ArrowUp", () => this.handleMentionScopeKey("ArrowUp"));
		scope.register([], "ArrowDown", () => this.handleMentionScopeKey("ArrowDown"));
		scope.register([], "Enter", () => this.handleMentionScopeKey("Enter"));
		scope.register([], "Escape", () => this.handleMentionScopeKey("Escape"));
	}

	private handleMentionScopeKey(key: "ArrowUp" | "ArrowDown" | "Enter" | "Escape"): boolean {
		if (!this.isMentionPanelVisible()) {
			return true;
		}

		if (key === "ArrowUp") {
			this.navigateMentionItems(-1);
			return false;
		}
		if (key === "ArrowDown") {
			this.navigateMentionItems(1);
			return false;
		}
		if (key === "Escape") {
			this.dismissMentionPanel();
			return false;
		}
		if (key === "Enter") {
			if (this.mentionCandidates.length > 0) {
				this.selectMentionCandidate(this.getEffectiveMentionIndex());
			}
			return false;
		}

		return true;
	}

	private handleComposerKeydown(event: KeyboardEvent): void {
		if (!this.inputEl) {
			return;
		}

		if (this.app.workspace.getActiveViewOfType(ChatView) !== this) {
			return;
		}

		if (this.isMentionPanelVisible()) {
			if (this.matchesArrowDown(event)) {
				this.consumeKeyboardEvent(event);
				this.navigateMentionItems(1);
				return;
			}
			if (this.matchesArrowUp(event)) {
				this.consumeKeyboardEvent(event);
				this.navigateMentionItems(-1);
				return;
			}
			if (this.matchesEscape(event)) {
				this.consumeKeyboardEvent(event);
				this.dismissMentionPanel();
				return;
			}
			if (this.matchesEnter(event) && !event.shiftKey && !event.isComposing) {
				this.consumeKeyboardEvent(event);
				if (this.mentionCandidates.length > 0) {
					this.selectMentionCandidate(this.getEffectiveMentionIndex());
				}
				return;
			}
		}

		if (!this.matchesEnter(event) || event.shiftKey || event.isComposing) {
			return;
		}
		if (this.busy) {
			return;
		}

		this.consumeKeyboardEvent(event);
		void this.sendMessage();
	}

	private consumeKeyboardEvent(event: KeyboardEvent): void {
		event.preventDefault();
		event.stopPropagation();
		event.stopImmediatePropagation();
	}

	private matchesArrowDown(event: KeyboardEvent): boolean {
		return event.key === "ArrowDown" || event.key === "Down" || event.code === "ArrowDown" || event.keyCode === 40;
	}

	private matchesArrowUp(event: KeyboardEvent): boolean {
		return event.key === "ArrowUp" || event.key === "Up" || event.code === "ArrowUp" || event.keyCode === 38;
	}

	private matchesEscape(event: KeyboardEvent): boolean {
		return event.key === "Escape" || event.key === "Esc" || event.code === "Escape" || event.keyCode === 27;
	}

	private matchesEnter(event: KeyboardEvent): boolean {
		return event.key === "Enter" || event.code === "Enter" || event.code === "NumpadEnter" || event.keyCode === 13;
	}

	private handleComposerInputChanged(): void {
		if (!this.inputEl) {
			this.clearMentionPanel();
			return;
		}

		const cursorIndex = this.inputEl.selectionStart ?? this.inputEl.value.length;
		const mentionContext = getActiveAddFilePathMention(this.inputEl.value, cursorIndex);
		if (!mentionContext) {
			this.mentionSuppressedKey = null;
			this.clearMentionPanel();
			return;
		}
		this.mentionPanelEl?.removeClass("nlm-chat-mention-panel-keyboard-nav");
		const mentionKey = this.getMentionSuppressionKey(mentionContext, this.inputEl.value);
		if (this.mentionSuppressedKey && this.mentionSuppressedKey === mentionKey) {
			this.clearMentionPanel();
			return;
		}
		this.mentionSuppressedKey = null;

		const currentSearchVersion = ++this.mentionSearchVersion;
		const candidates = this.plugin.searchAddFilePathCandidates(mentionContext.term, mentionContext.mode);
		if (currentSearchVersion !== this.mentionSearchVersion) {
			return;
		}
		this.mentionCandidates = candidates;
		if (this.mentionHoveredIndex !== null && this.mentionHoveredIndex >= candidates.length) {
			this.mentionHoveredIndex = null;
		}
		this.mentionSelectionIndex = Math.min(this.mentionSelectionIndex, Math.max(0, candidates.length - 1));
		this.renderMentionPanel();
	}

	private navigateMentionItems(direction: number): void {
		if (this.mentionCandidates.length === 0) {
			return;
		}
		this.mentionPanelEl?.addClass("nlm-chat-mention-panel-keyboard-nav");

		if (this.mentionHoveredIndex !== null) {
			this.mentionSelectionIndex = this.mentionHoveredIndex;
			this.mentionHoveredIndex = null;
		}

		if (this.mentionSelectionIndex < 0 || this.mentionSelectionIndex >= this.mentionCandidates.length) {
			this.mentionSelectionIndex = 0;
		}

		const nextIndex = this.mentionSelectionIndex + direction;
		if (nextIndex < 0) {
			this.mentionSelectionIndex = this.mentionCandidates.length - 1;
		} else if (nextIndex >= this.mentionCandidates.length) {
			this.mentionSelectionIndex = 0;
		} else {
			this.mentionSelectionIndex = nextIndex;
		}

		this.focusMentionItem(this.mentionSelectionIndex);
	}

	private getEffectiveMentionIndex(): number {
		if (this.mentionSelectionIndex < 0 || this.mentionSelectionIndex >= this.mentionCandidates.length) {
			return 0;
		}
		return this.mentionSelectionIndex;
	}

	private focusMentionItem(index: number): void {
		this.mentionSelectionIndex = index;
		for (let itemIndex = 0; itemIndex < this.mentionItemElements.length; itemIndex += 1) {
			const item = this.mentionItemElements[itemIndex];
			if (!item) {
				continue;
			}
			if (itemIndex === index) {
				item.addClass("nlm-chat-mention-item-active");
				item.scrollIntoView({ block: "nearest" });
			} else {
				item.removeClass("nlm-chat-mention-item-active");
			}
		}
	}

	private handleMentionItemMouseOver(index: number): void {
		this.mentionPanelEl?.removeClass("nlm-chat-mention-panel-keyboard-nav");
		this.mentionHoveredIndex = index;
		this.focusMentionItem(index);
	}

	private handleMentionItemMouseLeave(): void {
		this.mentionHoveredIndex = null;
	}

	private isMentionPanelVisible(): boolean {
		return !!this.mentionPanelEl && this.mentionPanelEl.style.display !== "none";
	}

	private dismissMentionPanel(): void {
		if (this.inputEl) {
			const cursorIndex = this.inputEl.selectionStart ?? this.inputEl.value.length;
			const mentionContext = getActiveAddFilePathMention(this.inputEl.value, cursorIndex);
			this.mentionSuppressedKey = mentionContext
				? this.getMentionSuppressionKey(mentionContext, this.inputEl.value)
				: null;
		}
		this.clearMentionPanel();
	}

	private getMentionSuppressionKey(
		context: AddFilePathMentionContext,
		text: string,
	): string {
		const tokenText = text.slice(context.tokenStart, context.tokenEnd);
		return `${context.tokenStart}:${context.trigger}:${tokenText}`;
	}

	private selectMentionCandidate(index: number): void {
		if (!this.inputEl) {
			return;
		}

		const candidate = this.mentionCandidates[index];
		if (!candidate) {
			return;
		}

		const cursorIndex = this.inputEl.selectionStart ?? this.inputEl.value.length;
		const mentionContext = getActiveAddFilePathMention(this.inputEl.value, cursorIndex);
		if (!mentionContext) {
			return;
		}

		const resolved = this.plugin.resolveComposerSelection({
			kind: candidate.kind,
			path: candidate.path,
			mode: mentionContext.mode,
		});
		if (resolved.error) {
			new Notice(resolved.error);
			return;
		}
		const resolvedSelection = resolved.selection;
		if (!resolvedSelection) {
			return;
		}

		const alreadyAdded = this.composerSelections.some(
			(selection) => selection.kind === resolvedSelection.kind && selection.path === resolvedSelection.path,
		);
		if (alreadyAdded) {
			new Notice("This file/path is already selected.");
			const replaced = replaceMentionToken(this.inputEl.value, mentionContext, "");
			this.inputEl.value = replaced.value;
			this.inputEl.setSelectionRange(replaced.cursorIndex, replaced.cursorIndex);
			this.mentionSuppressedKey = null;
			this.clearMentionPanel();
			this.inputEl.focus();
			return;
		}

		this.clearExclusionsForSelection(resolvedSelection);
		this.composerSelections.push(resolvedSelection);
		this.plugin.enqueueExplicitSourceUploads(resolvedSelection.filePaths);
		if (resolved.warning) {
			new Notice(resolved.warning, 7000);
		}
		const replaced = replaceMentionToken(this.inputEl.value, mentionContext, "");
		this.inputEl.value = replaced.value;
		this.inputEl.setSelectionRange(replaced.cursorIndex, replaced.cursorIndex);
		this.mentionSuppressedKey = null;
		this.clearMentionPanel();
		this.renderComposerSelections();
		this.inputEl.focus();
	}

	private clearMentionPanel(): void {
		this.mentionCandidates = [];
		this.mentionItemElements = [];
		this.mentionSelectionIndex = 0;
		this.mentionHoveredIndex = null;
		this.mentionSearchVersion += 1;
		if (this.mentionPanelEl) {
			this.mentionPanelEl.removeClass("nlm-chat-mention-panel-keyboard-nav");
			this.mentionPanelEl.empty();
			this.mentionPanelEl.style.display = "none";
		}
	}

	private renderMentionPanel(): void {
		if (!this.mentionPanelEl || !this.inputEl) {
			return;
		}

		const cursorIndex = this.inputEl.selectionStart ?? this.inputEl.value.length;
		const mentionContext = getActiveAddFilePathMention(this.inputEl.value, cursorIndex);
		this.mentionPanelEl.empty();
		if (!mentionContext) {
			this.mentionPanelEl.style.display = "none";
			return;
		}

		this.mentionPanelEl.style.display = "flex";
		if (this.mentionCandidates.length === 0) {
			this.mentionItemElements = [];
			this.mentionHoveredIndex = null;
			this.mentionPanelEl.createDiv({
				cls: "nlm-chat-mention-empty",
				text: "No more files found.",
			});
			return;
		}

		this.mentionItemElements = [];
		const activeIndex = this.getEffectiveMentionIndex();
		for (let index = 0; index < this.mentionCandidates.length; index += 1) {
			const candidate = this.mentionCandidates[index];
			if (!candidate) {
				continue;
			}
			const itemButton = this.mentionPanelEl.createEl("button", { cls: "nlm-chat-mention-item" });
			itemButton.type = "button";
			itemButton.addEventListener("click", () => {
				this.selectMentionCandidate(index);
			});
			itemButton.addEventListener("mouseover", () => {
				this.handleMentionItemMouseOver(index);
			});
			itemButton.addEventListener("mouseleave", () => {
				this.handleMentionItemMouseLeave();
			});
			this.mentionItemElements.push(itemButton);

			const iconEl = itemButton.createSpan({ cls: "nlm-chat-mention-icon" });
			setIcon(iconEl, getSearchItemIconName(candidate));

			const bodyEl = itemButton.createDiv({ cls: "nlm-chat-mention-body" });
			const lineEl = bodyEl.createDiv({ cls: "nlm-chat-mention-line" });
			const pathText =
				candidate.kind === "file" ? getDisplayParentPath(candidate.parentPath) : candidate.path;
			lineEl.createDiv({
				cls: "nlm-chat-mention-title",
				text: candidate.name,
			});
			lineEl.createDiv({
				cls: "nlm-chat-mention-path",
				text: pathText,
			});
		}

		if (this.mentionItemElements.length > 0) {
			this.focusMentionItem(Math.min(activeIndex, this.mentionItemElements.length - 1));
		}
	}

	private renderComposerSelections(): void {
		if (!this.composerSelectionsEl) {
			return;
		}

		this.composerSelectionsEl.empty();
		this.composerSelectionsEl.style.display = "flex";

		for (const selection of this.composerSelections) {
			const chipEl = this.composerSelectionsEl.createDiv({ cls: "nlm-chat-composer-selection" });
			const uploadStatus = this.plugin.getComposerSelectionUploadStatus(selection);
			if (uploadStatus.state === "uploading") {
				chipEl.addClass("nlm-chat-composer-selection-uploading");
			}
			const chipDisplayText =
				selection.kind === "path"
					? `${getLastPathSegment(selection.path)} (${selection.subfileCount})`
					: selection.label;
			const chipTooltipText =
				selection.kind === "path"
					? `${selection.path} (${selection.subfileCount})`
					: selection.path;

			const openButtonEl = chipEl.createEl("button", { cls: "nlm-chat-composer-selection-open" });
			openButtonEl.type = "button";
			openButtonEl.addEventListener("click", () => {
				void this.plugin.openComposerSelectionInNewTab(selection);
			});
			openButtonEl.setAttribute("title", chipTooltipText);
			openButtonEl.setAttribute("aria-label", chipTooltipText);

			const iconEl = openButtonEl.createSpan({ cls: "nlm-chat-composer-selection-icon" });
			const extension = selection.kind === "file" ? selection.path.split(".").pop() : undefined;
			setIcon(
				iconEl,
				selection.kind === "path"
					? "folder"
					: getFileIconNameByExtension(extension),
			);

			openButtonEl.createSpan({
				cls: "nlm-chat-composer-selection-label",
				text: chipDisplayText,
			});

			const removeButtonEl = chipEl.createEl("button", { cls: "nlm-chat-composer-selection-remove" });
			removeButtonEl.type = "button";
			removeButtonEl.setAttribute("aria-label", `Remove source: ${selection.label}`);
			this.renderComposerSelectionRemoveControl(removeButtonEl, uploadStatus);
			removeButtonEl.addEventListener("click", () => {
				this.removeComposerSelection(selection);
			});
		}

		const toggleEl = this.composerSelectionsEl.createDiv({ cls: "nlm-chat-composer-search-toggle" });
		const toggleLabelEl = toggleEl.createEl("label", {
			cls: "nlm-chat-composer-search-toggle-label",
		});
		const toggleInputEl = toggleLabelEl.createEl("input", {
			cls: "nlm-chat-composer-search-toggle-input",
			attr: { type: "checkbox" },
		});
		toggleInputEl.checked = this.plugin.getSearchVaultEnabled();
		toggleInputEl.addEventListener("change", () => {
			void this.plugin.setSearchVaultEnabled(toggleInputEl.checked).catch((error) => {
				new Notice(
					`Failed to update search toggle: ${error instanceof Error ? error.message : String(error)}`,
				);
				toggleInputEl.checked = this.plugin.getSearchVaultEnabled();
			});
		});
		toggleLabelEl.createSpan({
			cls: "nlm-chat-composer-search-toggle-text",
			text: "Search vault",
		});
	}

	private removeComposerSelection(selection: ComposerSelectionItem): void {
		this.plugin.cancelExplicitSourceUploads(selection.filePaths);
		const nextSelections = this.composerSelections.filter((item) => item.id !== selection.id);
		this.excludeDeselectedSelection(selection, nextSelections);
		this.composerSelections = nextSelections;
		this.renderComposerSelections();
	}

	private renderComposerSelectionRemoveControl(
		removeButtonEl: HTMLButtonElement,
		uploadStatus: ComposerSelectionUploadStatus,
	): void {
		removeButtonEl.empty();
		const removeSymbolEl = removeButtonEl.createSpan({
			cls: "nlm-chat-composer-selection-remove-symbol",
			text: "x",
		});
		removeSymbolEl.setAttribute("aria-hidden", "true");
		if (uploadStatus.state !== "uploading") {
			return;
		}

		const loadingEl = removeButtonEl.createSpan({
			cls: "nlm-chat-composer-selection-remove-loading",
		});
		if (uploadStatus.total > 1) {
			loadingEl.addClass("nlm-chat-composer-selection-remove-loading-with-percent");
			loadingEl.createSpan({
				cls: "nlm-chat-composer-selection-remove-loading-percent",
				text: `${uploadStatus.percent}%`,
			});
		}
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
		const explicitSelections = [...this.composerSelections];
		const includeBm25Search = this.plugin.getSearchVaultEnabled();
		const excludedSourceIds = [...this.excludedSourceIds];
		const excludedPaths = [...this.excludedPaths];

		this.inputEl.value = "";
		this.clearMentionPanel();
		this.setBusy(true);

		try {
			const runPromise = this.plugin.handleUserQuery(query, {
				explicitSelections,
				includeBm25Search,
				excludedSourceIds,
				excludedPaths,
			});
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
		this.resetComposerState();
		this.renderComposerSelections();
		this.clearMentionPanel();
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
					this.resetComposerState();
					this.renderComposerSelections();
					this.clearMentionPanel();
					this.renderMessages();
				} finally {
					this.setBusy(false);
				}
			},
		});
		modal.open();
	}

	private resetComposerState(): void {
		for (const selection of this.composerSelections) {
			this.plugin.cancelExplicitSourceUploads(selection.filePaths);
		}
		this.composerSelections = [];
		this.excludedSourceIds.clear();
		this.excludedPaths.clear();
	}

	private clearExclusionsForSelection(selection: ComposerSelectionItem): void {
		for (const filePath of selection.filePaths) {
			if (!filePath) {
				continue;
			}
			this.excludedPaths.delete(filePath);
		}

		const sourceIds = this.plugin.getSourceIdsForPaths(selection.filePaths);
		for (const sourceId of sourceIds) {
			if (!sourceId) {
				continue;
			}
			this.excludedSourceIds.delete(sourceId);
		}
	}

	private excludeDeselectedSelection(
		selection: ComposerSelectionItem,
		remainingSelections: ComposerSelectionItem[],
	): void {
		const remainingPaths = new Set<string>();
		for (const remainingSelection of remainingSelections) {
			for (const filePath of remainingSelection.filePaths) {
				if (filePath) {
					remainingPaths.add(filePath);
				}
			}
		}

		const removedPaths: string[] = [];
		for (const filePath of selection.filePaths) {
			if (!filePath || remainingPaths.has(filePath)) {
				continue;
			}
			this.excludedPaths.add(filePath);
			removedPaths.push(filePath);
		}

		const removedSourceIds = this.plugin.getSourceIdsForPaths(removedPaths);
		for (const sourceId of removedSourceIds) {
			if (!sourceId) {
				continue;
			}
			this.excludedSourceIds.add(sourceId);
		}
	}

	private setBusy(isBusy: boolean): void {
		this.busy = isBusy;
		this.renderComposerSelections();
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
			if ((queryMetadata.sourceSummary.explicitSelectedCount ?? 0) > 0) {
				sourceAreaEl.createDiv({
					cls: "nlm-chat-sources-summary",
					text: `Manual selection: ${queryMetadata.sourceSummary.explicitSelectedCount} source${queryMetadata.sourceSummary.explicitSelectedCount === 1 ? "" : "s"} added from selected files/paths.`,
				});
			}
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
