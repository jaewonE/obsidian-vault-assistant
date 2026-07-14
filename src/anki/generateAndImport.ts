import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import process from "process";
import {
	AnkiConnectClient,
	AnkiImportError,
	assertAnkiConnectReady,
	assertBasicModel,
	deckForGeneratedPlan,
	importParsedNlmDocument,
	parseNlmDocument,
	tagForGeneratedArtifact,
	type AnkiConnectInvoker,
	type ImportSummary,
} from "./importer";
import { GENERATION_GLOBAL_PROMPT, GENERATION_PLAN_PROMPT } from "./prompts";

const execFileAsync = promisify(execFile);

export type AnkiArtifactType = "quiz" | "flashcards";

export interface GenerationPlan {
	main_topic: string;
	summary: string;
	keywords: string[];
	deck_name: string;
	tags: string[];
	make_prompt: string;
}

export interface NlmCommandResult {
	stdout: string;
	stderr: string;
}

export type NlmCommandRunner = (args: string[]) => Promise<NlmCommandResult>;

export type AnkiGenerationPhase = "generation" | "sync";

export interface AnkiGenerationProgress {
	phase: AnkiGenerationPhase;
	detail: string;
}

export interface GenerateAndImportOptions {
	/** Current composer selection only. Every ID must still belong to the notebook. */
	sourceIds: string[];
	run?: NlmCommandRunner;
	nlmBin?: string;
	pollIntervalMs?: number;
	timeoutMs?: number;
	tempRoot?: string;
	sleep?: (milliseconds: number) => Promise<void>;
	ankiClient?: AnkiConnectInvoker;
	onProgress?: (progress: AnkiGenerationProgress) => void;
}

export interface AnkiGenerationResult {
	type: AnkiArtifactType;
	artifactId: string;
	selectedSourceIds: string[];
	generationPlan: GenerationPlan;
	anki: ImportSummary;
}

export class AnkiGenerationError extends Error {
	override name = "AnkiGenerationError";
}

interface NotebookDetails {
	sources?: Array<{ id?: unknown }>;
}

interface ArtifactStatus {
	id?: unknown;
	artifact_id?: unknown;
	type?: unknown;
	status?: unknown;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function nonEmptyString(value: unknown, context: string): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new AnkiGenerationError(`${context} must be a non-empty string.`);
	}
	return value.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonOutput(stdout: string, context: string): unknown {
	const text = stdout.trim();
	if (text.length === 0) {
		throw new AnkiGenerationError(`${context} returned empty output.`);
	}
	try {
		return JSON.parse(text) as unknown;
	} catch {
		const starts = [text.indexOf("{"), text.indexOf("[")].filter((index) => index >= 0);
		const end = Math.max(text.lastIndexOf("}"), text.lastIndexOf("]"));
		if (starts.length > 0 && end >= Math.min(...starts)) {
			try {
				return JSON.parse(text.slice(Math.min(...starts), end + 1)) as unknown;
			} catch {
				// Fall through to the contextual error below.
			}
		}
		throw new AnkiGenerationError(`${context} did not return valid JSON.`);
	}
}

function createDefaultRunner(nlmBin: string): NlmCommandRunner {
	return async (args) => {
		try {
			const result = await execFileAsync(nlmBin, args, {
				encoding: "utf8",
				maxBuffer: 20 * 1024 * 1024,
			});
			return {
				stdout: String(result.stdout),
				stderr: String(result.stderr),
			};
		} catch (error) {
			const commandError = error as Error & { stdout?: unknown; stderr?: unknown };
			const stdout = commandOutputText(commandError.stdout);
			const stderr = commandOutputText(commandError.stderr);
			const detail = [stderr, stdout].filter(Boolean).join("\n");
			throw new AnkiGenerationError(
				`nlm ${args.join(" ")} failed${detail ? `: ${detail}` : `: ${messageOf(error)}`}`,
			);
		}
	};
}

function commandOutputText(value: unknown): string {
	if (typeof value === "string") {
		return value.trim();
	}
	if (value instanceof Uint8Array) {
		return new TextDecoder().decode(value).trim();
	}
	return "";
}

function validateArtifactType(value: unknown): AnkiArtifactType {
	if (value !== "quiz" && value !== "flashcards") {
		throw new AnkiGenerationError(`type must be either quiz or flashcards; received ${String(value)}.`);
	}
	return value;
}

function validateMaxCount(value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
		throw new AnkiGenerationError(`maxCount must be a positive integer; received ${String(value)}.`);
	}
	return value;
}

function normaliseSourceIds(sourceIds: readonly string[]): string[] {
	const normalised = sourceIds.map((sourceId) => nonEmptyString(sourceId, "source-id"));
	const unique = [...new Set(normalised)];
	if (unique.length === 0) {
		throw new AnkiGenerationError("Select at least one current source before running an Anki command.");
	}
	return unique;
}

function notebookSourceIds(details: unknown, notebookId: string): string[] {
	if (!isRecord(details)) {
		throw new AnkiGenerationError(`Notebook ${notebookId} returned an invalid details object.`);
	}
	const sources = details.sources;
	const ids = Array.isArray(sources)
		? sources
				.filter(isRecord)
				.map((source) => source.id)
				.filter((id): id is string => typeof id === "string" && id.trim().length > 0)
		: [];
	if (ids.length === 0) {
		throw new AnkiGenerationError(`Notebook ${notebookId} has no usable sources.`);
	}
	return ids;
}

function validateCurrentSourceSelection(allSourceIds: string[], requestedSourceIds: string[]): string[] {
	const requested = normaliseSourceIds(requestedSourceIds);
	const known = new Set(allSourceIds);
	const invalid = requested.filter((sourceId) => !known.has(sourceId));
	if (invalid.length > 0) {
		throw new AnkiGenerationError(
			`Selected sources are no longer available in NotebookLM: ${invalid.join(", ")}. Re-select the sources and retry.`,
		);
	}
	return requested;
}

function boundedString(value: unknown, context: string, minimum: number, maximum: number): string {
	const text = nonEmptyString(value, context);
	if (text.length < minimum || text.length > maximum) {
		throw new AnkiGenerationError(`${context} must be ${minimum}-${maximum} characters; received ${text.length}.`);
	}
	return text;
}

function planStringArray(
	value: unknown,
	context: string,
	minimum: number,
	maximum: number,
	pattern?: RegExp,
): string[] {
	if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
		throw new AnkiGenerationError(`${context} must contain ${minimum}-${maximum} items.`);
	}
	const items = value.map((item, index) => boundedString(item, `${context}[${index}]`, 1, 120));
	if (pattern && items.some((item) => !pattern.test(item))) {
		throw new AnkiGenerationError(`${context} contains an item with unsupported characters.`);
	}
	return [...new Set(items)];
}

function validateGenerationPlan(value: unknown): GenerationPlan {
	if (!isRecord(value)) {
		throw new AnkiGenerationError("Planning reply must be a JSON object.");
	}
	const deckName = boundedString(value.deck_name, "planning.deck_name", 2, 60);
	if (!/^[\p{L}\p{N}._-]+$/u.test(deckName) || deckName.includes("::")) {
		throw new AnkiGenerationError("planning.deck_name must be one deck component without :: or spaces.");
	}
	return {
		main_topic: boundedString(value.main_topic, "planning.main_topic", 2, 80),
		summary: boundedString(value.summary, "planning.summary", 20, 700),
		keywords: planStringArray(value.keywords, "planning.keywords", 3, 10),
		deck_name: deckName,
		tags: planStringArray(value.tags, "planning.tags", 2, 8, /^[\p{L}\p{N}_-]+$/u),
		make_prompt: boundedString(value.make_prompt, "planning.make_prompt", 30, 4_000),
	};
}

function jsonFromReplyText(answer: string): unknown {
	const trimmed = answer.trim();
	const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/iu);
	const candidate = (fenced?.[1] ?? trimmed).trim();
	try {
		return JSON.parse(candidate) as unknown;
	} catch {
		const start = candidate.indexOf("{");
		const end = candidate.lastIndexOf("}");
		if (start >= 0 && end > start) {
			try {
				return JSON.parse(candidate.slice(start, end + 1)) as unknown;
			} catch {
				// Fall through to the JSON-only error below.
			}
		}
		throw new AnkiGenerationError("Planning reply was not a valid JSON object.");
	}
}

function queryAnswerValue(value: unknown, depth = 0): unknown {
	if (typeof value === "string") return value;
	if (!isRecord(value) || depth >= 3) return undefined;
	for (const key of ["answer", "response", "text", "content", "message", "result", "data"]) {
		if (!(key in value)) continue;
		const answer = queryAnswerValue(value[key], depth + 1);
		if (answer !== undefined) return answer;
	}
	return undefined;
}

function planFromQueryPayload(payload: unknown): GenerationPlan {
	if (isRecord(payload) && "main_topic" in payload) {
		return validateGenerationPlan(payload);
	}
	if (isRecord(payload)) {
		for (const key of ["answer", "response", "result", "data"]) {
			const candidate = payload[key];
			if (isRecord(candidate) && "main_topic" in candidate) {
				return validateGenerationPlan(candidate);
			}
		}
	}
	const answer = queryAnswerValue(payload);
	if (typeof answer === "string") {
		return validateGenerationPlan(jsonFromReplyText(answer));
	}
	if (isRecord(answer)) {
		return validateGenerationPlan(answer);
	}
	throw new AnkiGenerationError("nlm query JSON did not contain a planning answer.");
}

export function formatPromptTemplate(template: string, values: Record<string, string>): string {
	let formatted = template;
	for (const [name, value] of Object.entries(values)) {
		formatted = formatted.split(`{{${name}}}`).join(value);
	}
	const unresolved = formatted.match(/\{\{[^}]+\}\}/gu);
	if (unresolved) {
		throw new AnkiGenerationError(`Prompt template has unresolved placeholders: ${unresolved.join(", ")}.`);
	}
	return formatted.trim();
}

async function createGenerationPlan(
	run: NlmCommandRunner,
	notebookId: string,
	type: AnkiArtifactType,
	selectedSourceIds: string[],
	onProgress: (progress: AnkiGenerationProgress) => void,
): Promise<GenerationPlan> {
	const sourceScope = `${selectedSourceIds.length} explicitly selected source${selectedSourceIds.length === 1 ? "" : "s"} in the notebook`;
	const baseQuestion = formatPromptTemplate(GENERATION_PLAN_PROMPT, {
		artifact_type: type,
		source_scope: sourceScope,
	});
	let lastError = "unknown planning response error";
	for (let attempt = 1; attempt <= 3; attempt += 1) {
		onProgress({
			phase: "generation",
			detail: attempt === 1
				? "Creating a source-grounded card plan..."
				: `Retrying the card plan format (${attempt}/3)...`,
		});
		const question = attempt === 1
			? baseQuestion
			: `${baseQuestion}\n\nJSON FORMAT RETRY ${attempt}/3: The previous reply could not be parsed or did not meet the required schema. Reply with exactly one valid JSON object and no Markdown, prose, or code fence.`;
		try {
			const response = await run([
				"query",
				"notebook",
				notebookId,
				question,
				"--json",
				"--source-ids",
				selectedSourceIds.join(","),
			]);
			return planFromQueryPayload(parseJsonOutput(response.stdout, "nlm query notebook"));
		} catch (error) {
			lastError = messageOf(error);
		}
	}
	throw new AnkiGenerationError(
		`NotebookLM planning reply was not valid JSON with the required schema after 3 attempts: ${lastError}`,
	);
}

function artifactIdFromCreateOutput(output: string): string {
	const match = output.match(/Artifact ID:\s*([^\s\r\n]+)/i);
	if (!match?.[1]) {
		throw new AnkiGenerationError("nlm did not return an artifact ID after generation started.");
	}
	return match[1];
}

function artifactIdentifier(artifact: ArtifactStatus): string | undefined {
	const id = artifact.id ?? artifact.artifact_id;
	return typeof id === "string" ? id : undefined;
}

function validateCliJson(value: unknown, type: AnkiArtifactType): unknown {
	if (!isRecord(value)) {
		throw new AnkiGenerationError("nlm download did not return a JSON object.");
	}
	nonEmptyString(value.title, "downloaded JSON title");
	if (type === "quiz" && (!Array.isArray(value.questions) || value.questions.length === 0)) {
		throw new AnkiGenerationError("Downloaded quiz JSON is not in CLI format: questions is missing or empty.");
	}
	if (type === "flashcards" && (!Array.isArray(value.cards) || value.cards.length === 0)) {
		throw new AnkiGenerationError("Downloaded flashcards JSON is not in CLI format: cards is missing or empty.");
	}
	return value;
}

async function waitForArtifact(
	run: NlmCommandRunner,
	notebookId: string,
	artifactId: string,
	type: AnkiArtifactType,
	pollIntervalMs: number,
	timeoutMs: number,
	sleep: (milliseconds: number) => Promise<void>,
	onProgress: (progress: AnkiGenerationProgress) => void,
): Promise<void> {
	const startedAt = Date.now();
	let lastStatus = "not found";
	while (Date.now() - startedAt <= timeoutMs) {
		onProgress({ phase: "generation", detail: `Waiting for NotebookLM ${type} generation (${lastStatus})...` });
		const response = await run(["studio", "status", notebookId, "--full", "--json"]);
		const payload = parseJsonOutput(response.stdout, "nlm studio status");
		if (!Array.isArray(payload)) {
			throw new AnkiGenerationError("nlm studio status returned an invalid artifact list.");
		}
		const artifact = payload.find((item): item is ArtifactStatus =>
			isRecord(item) && artifactIdentifier(item as ArtifactStatus) === artifactId,
		);
		if (artifact) {
			if (artifact.type !== type) {
				throw new AnkiGenerationError(`Artifact ${artifactId} has type ${String(artifact.type)}; expected ${type}.`);
			}
			lastStatus = typeof artifact.status === "string" ? artifact.status : "unknown";
			if (lastStatus === "completed") return;
			if (lastStatus === "failed") {
				throw new AnkiGenerationError(`NotebookLM failed to generate ${type} artifact ${artifactId}.`);
			}
		}
		await sleep(pollIntervalMs);
	}
	throw new AnkiGenerationError(`Timed out waiting for ${type} artifact ${artifactId}; last status: ${lastStatus}.`);
}

export async function generateAndImportToAnki(
	notebookId: string,
	type: AnkiArtifactType,
	options: GenerateAndImportOptions,
): Promise<AnkiGenerationResult> {
	const id = nonEmptyString(notebookId, "notebook-id");
	const artifactType = validateArtifactType(type);
	const run = options.run ?? createDefaultRunner(options.nlmBin ?? process.env.NLM_BIN ?? "nlm");
	const ankiClient = options.ankiClient ?? new AnkiConnectClient();
	const pollIntervalMs = options.pollIntervalMs ?? 3_000;
	const timeoutMs = options.timeoutMs ?? 5 * 60 * 1_000;
	const sleep = options.sleep ?? ((milliseconds: number) => new Promise<void>((resolvePromise) => window.setTimeout(resolvePromise, milliseconds)));
	const onProgress = options.onProgress ?? (() => undefined);
	const maxCount = validateMaxCount(30);

	try {
		onProgress({ phase: "generation", detail: "Checking AnkiConnect before card generation..." });
		await assertAnkiConnectReady(ankiClient);
		await assertBasicModel(ankiClient);

		onProgress({ phase: "generation", detail: "Verifying the current NotebookLM source selection..." });
		const notebookResponse = await run(["notebook", "get", id, "--json"]);
		const allSourceIds = notebookSourceIds(parseJsonOutput(notebookResponse.stdout, "nlm notebook get") as NotebookDetails, id);
		const selectedSourceIds = validateCurrentSourceSelection(allSourceIds, options.sourceIds);
		const generationPlan = await createGenerationPlan(run, id, artifactType, selectedSourceIds, onProgress);
		const globalPrompt = formatPromptTemplate(GENERATION_GLOBAL_PROMPT, {
			artifact_type: artifactType,
			artifact_label: artifactType === "quiz" ? "questions" : "cards",
			max_count: String(maxCount),
		});
		const focusPrompt = `${globalPrompt}\n\n--- Source-specific generation instruction ---\n${generationPlan.make_prompt}`;

		onProgress({ phase: "generation", detail: `Starting NotebookLM ${artifactType} generation...` });
		const createArgs = [artifactType, "create", id, "--source-ids", selectedSourceIds.join(",")];
		if (artifactType === "quiz") {
			createArgs.push("--count", String(maxCount));
		}
		createArgs.push("--focus", focusPrompt, "--confirm");
		const createResponse = await run(createArgs);
		const artifactId = artifactIdFromCreateOutput(`${createResponse.stdout}\n${createResponse.stderr}`);
		await waitForArtifact(run, id, artifactId, artifactType, pollIntervalMs, timeoutMs, sleep, onProgress);

		onProgress({ phase: "generation", detail: `Downloading completed ${artifactType} cards...` });
		const temporaryDirectory = await mkdtemp(join(options.tempRoot ?? tmpdir(), "obsidian-anki-"));
		try {
			const outputPath = join(temporaryDirectory, `${artifactType}.json`);
			await run([
				"download",
				artifactType,
				id,
				"--id",
				artifactId,
				"--format",
				"json",
				"--output",
				outputPath,
			]);
			const data = validateCliJson(JSON.parse(await readFile(outputPath, "utf8")) as unknown, artifactType);
			const parsed = parseNlmDocument(data, `NotebookLM ${artifactType} artifact ${artifactId}`);
			const deck = deckForGeneratedPlan(generationPlan.deck_name);

			onProgress({ phase: "sync", detail: `Syncing ${parsed.cards.length} card${parsed.cards.length === 1 ? "" : "s"} to Anki deck ${deck}...` });
			const anki = await importParsedNlmDocument(ankiClient, parsed, {
				source: `NotebookLM ${artifactType} artifact ${artifactId}`,
				deck,
				tag: tagForGeneratedArtifact(artifactId, parsed.kind),
				baseTags: ["nlm-json-import", ...generationPlan.tags],
			});
			onProgress({ phase: "sync", detail: `Anki sync verified: ${anki.verifiedNotes} card${anki.verifiedNotes === 1 ? "" : "s"}.` });
			return { type: artifactType, artifactId, selectedSourceIds, generationPlan, anki };
		} finally {
			await rm(temporaryDirectory, { recursive: true, force: true });
		}
	} catch (error) {
		if (error instanceof AnkiGenerationError || error instanceof AnkiImportError) {
			throw error;
		}
		throw new AnkiGenerationError(messageOf(error));
	}
}
