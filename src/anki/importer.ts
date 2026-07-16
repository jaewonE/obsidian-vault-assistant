export const ANKI_CONNECT_URL = "http://127.0.0.1:8765";
export const ANKI_CONNECT_VERSION = 6;
export const BASIC_MODEL = "Basic";

export type JsonObject = Record<string, unknown>;

export interface BasicCard {
	front: string;
	back: string;
}

export interface ParsedNlmDocument {
	cards: BasicCard[];
	title: string;
	kind: "quiz" | "flashcards";
}

export interface AnkiConnectAction {
	action: string;
	params: JsonObject;
	version: number;
}

export interface AnkiConnectRequestUrlOptions {
	url: string;
	method: "POST";
	contentType: "application/json";
	headers: { "Content-Type": "application/json" };
	body: string;
	throw: boolean;
}

export interface AnkiConnectRequestUrlResponse {
	status: number;
	text: string;
}

export type AnkiConnectRequestUrl = (
	options: AnkiConnectRequestUrlOptions,
) => Promise<AnkiConnectRequestUrlResponse>;

interface AnkiConnectEnvelope<T> {
	error: string | null;
	result: T;
}

interface AddNoteResponse {
	error: string | null;
	result: number | null;
}

export interface ImportSummary {
	source: string;
	deck: string;
	tag: string;
	cards: number;
	status: "imported and verified";
	created: number;
	skippedDuplicates: number;
	verifiedNotes: number;
}

export class AnkiImportError extends Error {
	override name = "AnkiImportError";
}

function expectObject(value: unknown, context: string): JsonObject {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new AnkiImportError(`${context} must be an object.`);
	}
	return value as JsonObject;
}

function expectString(value: unknown, context: string): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new AnkiImportError(`${context} must be a non-empty string.`);
	}
	return value.trim();
}

function expectArray(value: unknown, context: string): unknown[] {
	if (!Array.isArray(value) || value.length === 0) {
		throw new AnkiImportError(`${context} must be a non-empty array.`);
	}
	return value;
}

export function textToHtml(value: string): string {
	return value
		.replace(/&/gu, "&amp;")
		.replace(/</gu, "&lt;")
		.replace(/>/gu, "&gt;")
		.replace(/"/gu, "&quot;")
		.replace(/'/gu, "&#39;")
		.replace(/\n/gu, "<br>");
}

function deckComponent(value: string): string {
	const normalised = value
		.normalize("NFKC")
		.replace(/[^\p{L}\p{N}._-]+/gu, "-")
		.replace(/^[.-]+|[.-]+$/gu, "")
		.toLowerCase();
	return normalised || "untitled";
}

export function deckForGeneratedPlan(deckName: string): string {
	return deckName.normalize("NFKC");
}

export function tagForGeneratedArtifact(
	artifactId: string,
	kind: ParsedNlmDocument["kind"],
): string {
	return `nlm-json-import::generated::${kind}::${deckComponent(artifactId)}`;
}

function optionLabel(index: number): string {
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
	return alphabet[index] ?? String(index + 1);
}

function parseQuiz(document: JsonObject, sourceName: string): ParsedNlmDocument {
	const questions = expectArray(document.questions, `${sourceName}.questions`);
	const cards = questions.map((rawQuestion, questionIndex) => {
		const question = expectObject(rawQuestion, `${sourceName}.questions[${questionIndex}]`);
		const questionText = expectString(question.question, `${sourceName}.questions[${questionIndex}].question`);
		const options = expectArray(question.answerOptions, `${sourceName}.questions[${questionIndex}].answerOptions`);
		const parsedOptions = options.map((rawOption, optionIndex) => {
			const option = expectObject(
				rawOption,
				`${sourceName}.questions[${questionIndex}].answerOptions[${optionIndex}]`,
			);
			const text = expectString(option.text, `question ${questionIndex + 1}, option ${optionIndex + 1}.text`);
			if (typeof option.isCorrect !== "boolean") {
				throw new AnkiImportError(`question ${questionIndex + 1}, option ${optionIndex + 1}.isCorrect must be boolean.`);
			}
			const rationale = expectString(
				option.rationale,
				`question ${questionIndex + 1}, option ${optionIndex + 1}.rationale`,
			);
			return { text, isCorrect: option.isCorrect, rationale };
		});

		const correct = parsedOptions.filter((option) => option.isCorrect);
		if (correct.length === 0) {
			throw new AnkiImportError(`question ${questionIndex + 1} has no correct answer.`);
		}

		const front = [
			`<b>문항 ${questionIndex + 1}.</b> ${textToHtml(questionText)}`,
			question.hint === undefined
				? ""
				: `<br><br><i>힌트:</i> ${textToHtml(expectString(question.hint, `question ${questionIndex + 1}.hint`))}`,
			"<br><br><b>선택지</b><ol>",
			...parsedOptions.map(
				(option, optionIndex) => `<li><b>${optionLabel(optionIndex)}.</b> ${textToHtml(option.text)}</li>`,
			),
			"</ol>",
		].join("");
		const back = [
			"<b>정답</b><ul>",
			...correct.map(
				(option) => `<li>${textToHtml(option.text)}<br><i>해설:</i> ${textToHtml(option.rationale)}</li>`,
			),
			"</ul><hr><b>모든 선택지 해설</b><ol>",
			...parsedOptions.map((option) => {
				const marker = option.isCorrect ? "✓" : "✗";
				return `<li><b>${marker} ${textToHtml(option.text)}</b><br>${textToHtml(option.rationale)}</li>`;
			}),
			"</ol>",
		].join("");
		return { front, back };
	});

	return {
		title: expectString(document.title, `${sourceName}.title`),
		kind: "quiz",
		cards,
	};
}

function parseFlashcards(document: JsonObject, sourceName: string): ParsedNlmDocument {
	const rawCards = expectArray(document.cards, `${sourceName}.cards`);
	const cards = rawCards.map((rawCard, cardIndex) => {
		const card = expectObject(rawCard, `${sourceName}.cards[${cardIndex}]`);
		return {
			front: textToHtml(expectString(card.front, `${sourceName}.cards[${cardIndex}].front`)),
			back: textToHtml(expectString(card.back, `${sourceName}.cards[${cardIndex}].back`)),
		};
	});
	return {
		title: expectString(document.title, `${sourceName}.title`),
		kind: "flashcards",
		cards,
	};
}

export function parseNlmDocument(data: unknown, sourceName = "NotebookLM artifact"): ParsedNlmDocument {
	const document = expectObject(data, sourceName);
	const hasQuestions = "questions" in document;
	const hasCards = "cards" in document;
	if (hasQuestions === hasCards) {
		throw new AnkiImportError(`${sourceName} must contain exactly one of questions or cards.`);
	}
	return hasQuestions ? parseQuiz(document, sourceName) : parseFlashcards(document, sourceName);
}

export function ankiRequest(action: string, params: JsonObject = {}): AnkiConnectAction {
	return { action, params, version: ANKI_CONNECT_VERSION };
}

function resolveObsidianRequestUrl(): AnkiConnectRequestUrl {
	// The production bundle is CommonJS, so this resolves through Obsidian's
	// plugin module loader. A native dynamic import("obsidian") is not supported
	// by that loader and fails before a request can reach AnkiConnect.
	// eslint-disable-next-line @typescript-eslint/no-require-imports, no-undef -- Obsidian injects this loader-specific CommonJS resolver.
	const { requestUrl } = require("obsidian") as { requestUrl?: AnkiConnectRequestUrl };
	if (typeof requestUrl !== "function") {
		throw new Error("Obsidian requestUrl is unavailable.");
	}
	return requestUrl;
}

export class AnkiConnectClient {
	constructor(private readonly requestUrlOverride?: AnkiConnectRequestUrl) {}

	async invoke<T>(action: string, params: JsonObject = {}): Promise<T> {
		let response: { status: number; text: string };
		try {
			const requestUrl = this.requestUrlOverride ?? resolveObsidianRequestUrl();
			response = await requestUrl({
				url: ANKI_CONNECT_URL,
				method: "POST",
				contentType: "application/json",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(ankiRequest(action, params)),
				throw: false,
			});
		} catch (error) {
			throw new AnkiImportError(
				`Cannot connect to AnkiConnect at ${ANKI_CONNECT_URL}. Ensure Anki and AnkiConnect are running. (${error instanceof Error ? error.message : String(error)})`,
			);
		}
		if (response.status < 200 || response.status >= 300) {
			throw new AnkiImportError(`AnkiConnect ${action} returned HTTP ${response.status}.`);
		}
		let payload: unknown;
		try {
			payload = JSON.parse(response.text) as unknown;
		} catch {
			throw new AnkiImportError(`AnkiConnect ${action} returned invalid JSON.`);
		}
		const envelope = expectObject(payload, `AnkiConnect ${action} response`) as Partial<AnkiConnectEnvelope<T>>;
		if (!("error" in envelope) || !("result" in envelope)) {
			throw new AnkiImportError(`AnkiConnect ${action} returned an invalid response.`);
		}
		if (envelope.error !== null) {
			throw new AnkiImportError(`AnkiConnect ${action} failed: ${String(envelope.error)}`);
		}
		return envelope.result as T;
	}
}

export interface AnkiConnectInvoker {
	invoke<T>(action: string, params?: JsonObject): Promise<T>;
}

export async function assertAnkiConnectReady(client: AnkiConnectInvoker): Promise<void> {
	const modelNames = await client.invoke<unknown>("modelNames");
	if (!Array.isArray(modelNames) || !modelNames.every((modelName) => typeof modelName === "string")) {
		throw new AnkiImportError("AnkiConnect modelNames returned an invalid response.");
	}
}

export async function assertBasicModel(client: AnkiConnectInvoker): Promise<void> {
	const fields = await client.invoke<unknown>("modelFieldNames", { modelName: BASIC_MODEL });
	if (!Array.isArray(fields) || fields.length !== 2 || fields[0] !== "Front" || fields[1] !== "Back") {
		throw new AnkiImportError(`The ${BASIC_MODEL} model must have exactly Front and Back fields; received ${JSON.stringify(fields)}.`);
	}
}

export interface AnkiImportTarget {
	source: string;
	deck: string;
	tag: string;
	baseTags: string[];
}

export async function importParsedNlmDocument(
	client: AnkiConnectInvoker,
	parsed: ParsedNlmDocument,
	target: AnkiImportTarget,
): Promise<ImportSummary> {
	const summary = {
		source: target.source,
		deck: target.deck,
		tag: target.tag,
		cards: parsed.cards.length,
		status: "imported and verified" as const,
	};

	await client.invoke("createDeck", { deck: target.deck });
	const actions = parsed.cards.map((card) =>
		ankiRequest("addNote", {
			note: {
				deckName: target.deck,
				modelName: BASIC_MODEL,
				fields: { Front: card.front, Back: card.back },
				options: { allowDuplicate: false, duplicateScope: "deck" },
				tags: [...new Set([...target.baseTags, target.tag])],
			},
		}),
	);
	const responses = await client.invoke<unknown>("multi", { actions });
	if (!Array.isArray(responses) || responses.length !== parsed.cards.length) {
		throw new AnkiImportError(`${target.source}: addNote returned an unexpected number of responses.`);
	}

	let created = 0;
	let skippedDuplicates = 0;
	const errors: unknown[] = [];
	for (const rawResponse of responses) {
		const actionResponse = expectObject(rawResponse, "AnkiConnect addNote response") as Partial<AddNoteResponse>;
		if (actionResponse.error !== null && actionResponse.error !== undefined) {
			if (String(actionResponse.error).toLowerCase().includes("duplicate")) {
				skippedDuplicates += 1;
			} else {
				errors.push(actionResponse.error);
			}
		} else if (actionResponse.result !== null && actionResponse.result !== undefined) {
			created += 1;
		} else {
			errors.push("addNote returned neither an ID nor an error");
		}
	}
	if (errors.length > 0) {
		throw new AnkiImportError(`${target.source}: addNote failed: ${JSON.stringify(errors)}`);
	}

	const noteIds = await client.invoke<unknown>("findNotes", {
		query: `deck:"${target.deck}" tag:"${target.tag}"`,
	});
	if (!Array.isArray(noteIds) || noteIds.length !== parsed.cards.length) {
		throw new AnkiImportError(
			`${target.source}: verification found ${Array.isArray(noteIds) ? noteIds.length : JSON.stringify(noteIds)} notes; expected ${parsed.cards.length}.`,
		);
	}
	return {
		...summary,
		created,
		skippedDuplicates,
		verifiedNotes: noteIds.length,
	};
}
