import type { App, TFile } from "obsidian";
import { Logger } from "../logging/logger";
import type { BM25CachedDocumentState, BM25CachedIndexState } from "../types";
import { extractMarkdownHeadings } from "./markdownFields";
import { tokenizeForBm25, tokenizePathForBm25 } from "./tokenization";

interface IndexedDocument {
	file: TFile;
	length: number;
	mtime: number;
	size: number;
	termFreq: Map<string, number>;
}

export interface BM25SearchParams {
	topN: number;
	cutoffRatio: number;
	minK: number;
	k1: number;
	b: number;
}

export interface BM25SearchHit {
	file: TFile;
	path: string;
	score: number;
}

export interface BM25SearchResult {
	topResults: BM25SearchHit[];
	selected: BM25SearchHit[];
	topScore: number;
	threshold: number;
	elapsedMs: number;
	queryTokens: string[];
	matchedTokens: string[];
	matchedDocumentCount: number;
	nonZeroScoreCount: number;
}

const FIELD_WEIGHT_BODY = 1;
const FIELD_WEIGHT_HEADINGS = 2.5;
const FIELD_WEIGHT_PATH = 4;
const BM25_INDEX_SCHEMA_VERSION = 1;
const FULL_RESCAN_EVERY_DIRTY_SYNCS = 50;

export class BM25 {
	private readonly app: App;
	private readonly logger: Logger;
	private documents: Map<string, IndexedDocument> = new Map();
	private invertedIndex: Map<string, Map<string, number>> = new Map();
	private averageDocumentLength = 0;
	private dirty = true;
	private fullRescanNeeded = true;
	private pendingModifiedPaths = new Set<string>();
	private pendingDeletedPaths = new Set<string>();
	private dirtySyncCountSinceFullRescan = 0;
	private cachedIndexForHydration: BM25CachedIndexState | null = null;

	constructor(app: App, logger: Logger) {
		this.app = app;
		this.logger = logger;
	}

	markDirty(): void {
		this.markFullRescanNeeded();
	}

	markPathModified(path: string): void {
		if (!path) {
			return;
		}
		this.pendingDeletedPaths.delete(path);
		this.pendingModifiedPaths.add(path);
		this.dirty = true;
	}

	markPathDeleted(path: string): void {
		if (!path) {
			return;
		}
		this.pendingModifiedPaths.delete(path);
		this.pendingDeletedPaths.add(path);
		this.dirty = true;
	}

	markFullRescanNeeded(): void {
		this.fullRescanNeeded = true;
		this.pendingModifiedPaths.clear();
		this.pendingDeletedPaths.clear();
		this.dirty = true;
	}

	loadCachedIndex(index: BM25CachedIndexState | null): void {
		if (!index || index.schemaVersion !== BM25_INDEX_SCHEMA_VERSION) {
			this.cachedIndexForHydration = null;
			this.markFullRescanNeeded();
			return;
		}

		this.cachedIndexForHydration = index;
		this.markFullRescanNeeded();
	}

	exportCachedIndex(): BM25CachedIndexState {
		const documents: Record<string, BM25CachedDocumentState> = {};
		for (const [path, doc] of this.documents) {
			const termFreq: Record<string, number> = {};
			for (const [token, frequency] of doc.termFreq) {
				termFreq[token] = frequency;
			}

			documents[path] = {
				path,
				length: doc.length,
				mtime: doc.mtime,
				size: doc.size,
				termFreq,
			};
		}

		return {
			schemaVersion: BM25_INDEX_SCHEMA_VERSION,
			averageDocumentLength: this.averageDocumentLength,
			updatedAt: new Date().toISOString(),
			documents,
		};
	}

	async search(query: string, params: BM25SearchParams): Promise<BM25SearchResult> {
		if (this.dirty) {
			await this.syncIndex();
		}

		const startedAt = Date.now();
		const topN = Math.max(1, Math.floor(params.topN));
		const minK = Math.max(1, Math.floor(params.minK));
		const cutoffRatio = Math.max(0, Math.min(1, params.cutoffRatio));

		const queryTokens = tokenizeForBm25(query);
		const queryTermFrequencies = this.countTokens(queryTokens);
		const allDocCount = this.documents.size;
		const safeAverageLength = this.averageDocumentLength > 0 ? this.averageDocumentLength : 1;
		const scores = new Map<string, number>();
		const matchedTokens = new Set<string>();
		const matchedDocuments = new Set<string>();
		const docMatchedTermCount = new Map<string, number>();

		for (const [path] of this.documents) {
			scores.set(path, 0);
		}

		for (const [token, queryTermFrequency] of queryTermFrequencies) {
			const posting = this.invertedIndex.get(token);
			if (!posting) {
				continue;
			}
			matchedTokens.add(token);

			const docFrequency = posting.size;
			const idf = Math.log(1 + (allDocCount - docFrequency + 0.5) / (docFrequency + 0.5));

			for (const [path, termFrequency] of posting) {
				const doc = this.documents.get(path);
				if (!doc) {
					continue;
				}
				matchedDocuments.add(path);
				docMatchedTermCount.set(path, (docMatchedTermCount.get(path) ?? 0) + 1);

				const denominator =
					termFrequency + params.k1 * (1 - params.b + params.b * (doc.length / safeAverageLength));
				const partialScore = idf * ((termFrequency * (params.k1 + 1)) / denominator) * queryTermFrequency;
				scores.set(path, (scores.get(path) ?? 0) + partialScore);
			}
		}

		const ranked = [...this.documents.values()]
			.map((doc) => ({
				file: doc.file,
				path: doc.file.path,
				score: scores.get(doc.file.path) ?? 0,
				matchedTermCount: docMatchedTermCount.get(doc.file.path) ?? 0,
			}))
			.filter((doc) => doc.score > 0)
			.sort((left, right) => {
				if (left.score !== right.score) {
					return right.score - left.score;
				}

				if (left.matchedTermCount !== right.matchedTermCount) {
					return right.matchedTermCount - left.matchedTermCount;
				}

				return left.path.localeCompare(right.path);
			});

		const topResults = ranked.slice(0, topN);
		const topScore = topResults[0]?.score ?? 0;
		const threshold = topScore * cutoffRatio;
		let selected = topResults.filter((item) => item.score >= threshold);

		if (selected.length < minK) {
			selected = topResults.slice(0, Math.min(minK, topResults.length));
		}

		const elapsedMs = Date.now() - startedAt;
		this.logger.debug("BM25 search stats", {
			query,
			documentCount: this.documents.size,
			queryTokenCount: queryTokens.length,
			matchedTokenCount: matchedTokens.size,
			matchedDocumentCount: matchedDocuments.size,
			nonZeroScoreCount: ranked.length,
			topN,
			minK,
			cutoffRatio,
			topScore,
			threshold,
			selectedCount: selected.length,
			elapsedMs,
		});

		return {
			topResults: topResults.map(({ file, path, score }) => ({ file, path, score })),
			selected: selected.map(({ file, path, score }) => ({ file, path, score })),
			topScore,
			threshold,
			elapsedMs,
			queryTokens,
			matchedTokens: [...matchedTokens],
			matchedDocumentCount: matchedDocuments.size,
			nonZeroScoreCount: ranked.length,
		};
	}

	private async syncIndex(): Promise<void> {
		const startedAt = Date.now();
		const markdownFiles = this.app.vault.getMarkdownFiles();
		const filesByPath = new Map(markdownFiles.map((file) => [file.path, file]));

		if (this.documents.size === 0 && this.cachedIndexForHydration) {
			this.hydrateFromCachedIndex(filesByPath);
		}
		const shouldRunFullRescan =
			this.fullRescanNeeded ||
			this.documents.size === 0 ||
			this.dirtySyncCountSinceFullRescan >= FULL_RESCAN_EVERY_DIRTY_SYNCS;

		if (shouldRunFullRescan) {
			for (const [path] of this.documents) {
				if (filesByPath.has(path)) {
					continue;
				}
				this.removeIndexedDocument(path);
			}

			for (const file of markdownFiles) {
				const indexed = this.documents.get(file.path);
				const mtime = file.stat?.mtime ?? 0;
				const size = file.stat?.size ?? 0;
				if (!indexed) {
					await this.upsertIndexedDocument(file);
					continue;
				}

				indexed.file = file;
				if (indexed.mtime !== mtime || indexed.size !== size) {
					await this.upsertIndexedDocument(file);
				}
			}

			this.fullRescanNeeded = false;
			this.pendingModifiedPaths.clear();
			this.pendingDeletedPaths.clear();
			this.dirtySyncCountSinceFullRescan = 0;
		} else {
			for (const deletedPath of this.pendingDeletedPaths) {
				this.removeIndexedDocument(deletedPath);
			}

			for (const modifiedPath of this.pendingModifiedPaths) {
				const file = filesByPath.get(modifiedPath);
				if (!file) {
					this.removeIndexedDocument(modifiedPath);
					continue;
				}

				await this.upsertIndexedDocument(file);
			}

			this.pendingModifiedPaths.clear();
			this.pendingDeletedPaths.clear();
			this.dirtySyncCountSinceFullRescan += 1;
		}

		this.averageDocumentLength = this.computeAverageDocumentLength();
		this.dirty = false;
		this.cachedIndexForHydration = null;

		this.logger.debug("BM25 index synchronized", {
			documentCount: this.documents.size,
			termCount: this.invertedIndex.size,
			elapsedMs: Date.now() - startedAt,
		});
	}

	private countTokens(tokens: string[]): Map<string, number> {
		const counts = new Map<string, number>();
		for (const token of tokens) {
			counts.set(token, (counts.get(token) ?? 0) + 1);
		}
		return counts;
	}

	private addTokensWithWeight(target: Map<string, number>, tokens: string[], weight: number): void {
		for (const token of tokens) {
			target.set(token, (target.get(token) ?? 0) + weight);
		}
	}

	private hydrateFromCachedIndex(filesByPath: Map<string, TFile>): void {
		if (!this.cachedIndexForHydration) {
			return;
		}

		this.documents = new Map();
		this.invertedIndex = new Map();
		for (const cachedDocument of Object.values(this.cachedIndexForHydration.documents)) {
			const file = filesByPath.get(cachedDocument.path);
			if (!file) {
				continue;
			}

			const termFreq = new Map<string, number>();
			for (const [token, frequency] of Object.entries(cachedDocument.termFreq)) {
				if (!token || !Number.isFinite(frequency) || frequency <= 0) {
					continue;
				}
				termFreq.set(token, frequency);
			}
			if (termFreq.size === 0) {
				continue;
			}

			this.documents.set(cachedDocument.path, {
				file,
				length: cachedDocument.length,
				mtime: cachedDocument.mtime,
				size: cachedDocument.size,
				termFreq,
			});
			this.addDocumentTerms(cachedDocument.path, termFreq);
		}
	}

	private addDocumentTerms(path: string, termFreq: Map<string, number>): void {
		for (const [token, frequency] of termFreq) {
			const posting = this.invertedIndex.get(token) ?? new Map<string, number>();
			posting.set(path, frequency);
			this.invertedIndex.set(token, posting);
		}
	}

	private removeDocumentTerms(path: string, termFreq: Map<string, number>): void {
		for (const token of termFreq.keys()) {
			const posting = this.invertedIndex.get(token);
			if (!posting) {
				continue;
			}
			posting.delete(path);
			if (posting.size === 0) {
				this.invertedIndex.delete(token);
			}
		}
	}

	private removeIndexedDocument(path: string): void {
		const existing = this.documents.get(path);
		if (!existing) {
			return;
		}

		this.removeDocumentTerms(path, existing.termFreq);
		this.documents.delete(path);
	}

	private async upsertIndexedDocument(file: TFile): Promise<void> {
		const path = file.path;
		const existing = this.documents.get(path);
		if (existing) {
			this.removeDocumentTerms(path, existing.termFreq);
		}

		const content = await this.app.vault.cachedRead(file);
		const headingText = extractMarkdownHeadings(content);
		const bodyTokens = tokenizeForBm25(content);
		const headingTokens = tokenizeForBm25(headingText);
		const pathTokens = tokenizePathForBm25(path);

		const termFreq = new Map<string, number>();
		this.addTokensWithWeight(termFreq, bodyTokens, FIELD_WEIGHT_BODY);
		this.addTokensWithWeight(termFreq, headingTokens, FIELD_WEIGHT_HEADINGS);
		this.addTokensWithWeight(termFreq, pathTokens, FIELD_WEIGHT_PATH);

		const weightedLength =
			bodyTokens.length * FIELD_WEIGHT_BODY +
			headingTokens.length * FIELD_WEIGHT_HEADINGS +
			pathTokens.length * FIELD_WEIGHT_PATH;
		const mtime = file.stat?.mtime ?? 0;
		const size = file.stat?.size ?? 0;

		this.documents.set(path, {
			file,
			length: weightedLength,
			mtime,
			size,
			termFreq,
		});
		this.addDocumentTerms(path, termFreq);
	}

	private computeAverageDocumentLength(): number {
		if (this.documents.size === 0) {
			return 0;
		}

		let totalLength = 0;
		for (const doc of this.documents.values()) {
			totalLength += doc.length;
		}
		return totalLength / this.documents.size;
	}
}
