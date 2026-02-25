import type { App, TFile } from "obsidian";
import { Logger } from "../logging/logger";
import { extractMarkdownHeadings } from "./markdownFields";
import { tokenizeForBm25, tokenizePathForBm25 } from "./tokenization";

interface IndexedDocument {
	file: TFile;
	length: number;
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

	private async rebuildIndex(): Promise<void> {
		const startedAt = Date.now();
		const markdownFiles = this.app.vault.getMarkdownFiles();
		const nextDocuments = new Map<string, IndexedDocument>();
		const nextInvertedIndex = new Map<string, Map<string, number>>();
		let totalLength = 0;

		await Promise.all(
			markdownFiles.map(async (file) => {
				const content = await this.app.vault.cachedRead(file);
				const headingText = extractMarkdownHeadings(content);
				const bodyTokens = tokenizeForBm25(content);
				const headingTokens = tokenizeForBm25(headingText);
				const pathTokens = tokenizePathForBm25(file.path);

				const termFreq = new Map<string, number>();
				this.addTokensWithWeight(termFreq, bodyTokens, FIELD_WEIGHT_BODY);
				this.addTokensWithWeight(termFreq, headingTokens, FIELD_WEIGHT_HEADINGS);
				this.addTokensWithWeight(termFreq, pathTokens, FIELD_WEIGHT_PATH);

				const weightedLength =
					bodyTokens.length * FIELD_WEIGHT_BODY +
					headingTokens.length * FIELD_WEIGHT_HEADINGS +
					pathTokens.length * FIELD_WEIGHT_PATH;
				totalLength += weightedLength;

				nextDocuments.set(file.path, {
					file,
					length: weightedLength,
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
}
