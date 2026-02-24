import { App, TFile } from "obsidian";
import { Logger } from "../logging/logger";

interface IndexedDocument {
	file: TFile;
	length: number;
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
}

export class BM25 {
	private readonly app: App;
	private readonly logger: Logger;
	private documents: Map<string, IndexedDocument> = new Map();
	private invertedIndex: Map<string, Map<string, number>> = new Map();
	private averageDocumentLength = 0;
	private dirty = true;

	constructor(app: App, logger: Logger) {
		this.app = app;
		this.logger = logger;
	}

	markDirty(): void {
		this.dirty = true;
	}

	async search(query: string, params: BM25SearchParams): Promise<BM25SearchResult> {
		if (this.dirty) {
			await this.rebuildIndex();
		}

		const startedAt = Date.now();
		const topN = Math.max(1, Math.floor(params.topN));
		const minK = Math.max(1, Math.floor(params.minK));
		const cutoffRatio = Math.max(0, Math.min(1, params.cutoffRatio));

		const queryTokens = this.tokenize(query);
		const queryTermFrequencies = this.countTokens(queryTokens);
		const allDocCount = this.documents.size;
		const safeAverageLength = this.averageDocumentLength > 0 ? this.averageDocumentLength : 1;
		const scores = new Map<string, number>();

		for (const [path] of this.documents) {
			scores.set(path, 0);
		}

		for (const [token, queryTermFrequency] of queryTermFrequencies) {
			const posting = this.invertedIndex.get(token);
			if (!posting) {
				continue;
			}

			const docFrequency = posting.size;
			const idf = Math.log(1 + (allDocCount - docFrequency + 0.5) / (docFrequency + 0.5));

			for (const [path, termFrequency] of posting) {
				const doc = this.documents.get(path);
				if (!doc) {
					continue;
				}

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
			}))
			.sort((left, right) => {
				if (left.score !== right.score) {
					return right.score - left.score;
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
			topN,
			minK,
			cutoffRatio,
			topScore,
			threshold,
			selectedCount: selected.length,
			elapsedMs,
		});

		return {
			topResults,
			selected,
			topScore,
			threshold,
			elapsedMs,
		};
	}

	private async rebuildIndex(): Promise<void> {
		const startedAt = Date.now();
		const markdownFiles = this.app.vault.getMarkdownFiles();
		const nextDocuments = new Map<string, IndexedDocument>();
		const nextInvertedIndex = new Map<string, Map<string, number>>();
		let totalLength = 0;

		await Promise.all(
			markdownFiles.map(async (file) => {
				const content = await this.app.vault.cachedRead(file);
				const tokens = this.tokenize(content);
				const termFreq = this.countTokens(tokens);
				totalLength += tokens.length;

				nextDocuments.set(file.path, {
					file,
					length: tokens.length,
					termFreq,
				});

				for (const [token, frequency] of termFreq) {
					const posting = nextInvertedIndex.get(token) ?? new Map<string, number>();
					posting.set(file.path, frequency);
					nextInvertedIndex.set(token, posting);
				}
			}),
		);

		this.documents = nextDocuments;
		this.invertedIndex = nextInvertedIndex;
		this.averageDocumentLength = markdownFiles.length > 0 ? totalLength / markdownFiles.length : 0;
		this.dirty = false;

		this.logger.debug("BM25 index rebuilt", {
			documentCount: markdownFiles.length,
			termCount: this.invertedIndex.size,
			elapsedMs: Date.now() - startedAt,
		});
	}

	private tokenize(text: string): string[] {
		const normalized = text.toLowerCase().replace(/[^a-z0-9\s]/g, " ");
		return normalized
			.split(/\s+/)
			.map((token) => token.trim())
			.filter((token) => token.length > 0);
	}

	private countTokens(tokens: string[]): Map<string, number> {
		const counts = new Map<string, number>();
		for (const token of tokens) {
			counts.set(token, (counts.get(token) ?? 0) + 1);
		}
		return counts;
	}
}
