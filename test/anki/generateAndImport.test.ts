import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import test from "node:test";
import type { AnkiConnectInvoker, JsonObject } from "../../src/anki/importer";
import {
	AnkiGenerationError,
	DEFAULT_ANKI_GENERATION_TIMEOUT_MS,
	generateAndImportToAnki,
	type GenerationPlan,
	type NlmCommandResult,
} from "../../src/anki/generateAndImport";

const PLAN: GenerationPlan = {
	main_topic: "Kafka Fundamentals",
	summary: "A source-grounded overview of Kafka fundamentals for beginner learners.",
	keywords: ["kafka", "broker", "topic"],
	deck_name: "kafka-fundamentals",
	tags: ["kafka", "streaming"],
	make_prompt: "Create Korean flashcards for beginners using only the selected Kafka source concepts.",
};

function jsonResult(value: unknown): NlmCommandResult {
	return { stdout: JSON.stringify(value), stderr: "" };
}

function fakeRunner(
	downloaded: unknown,
	sourceIds = ["source-1", "source-2"],
	studioResponses: unknown[] = [[
		{ id: "artifact-flashcards", type: "flashcards", status: "completed" },
		{ id: "artifact-quiz", type: "quiz", status: "completed" },
	]],
): {
	run: (args: string[]) => Promise<NlmCommandResult>;
	calls: string[][];
} {
	const calls: string[][] = [];
	let studioResponseIndex = 0;
	return {
		calls,
		async run(args) {
			calls.push(args);
			if (args[0] === "notebook") {
				return jsonResult({ sources: sourceIds.map((id) => ({ id })) });
			}
			if (args[0] === "query") {
				return jsonResult({ answer: JSON.stringify(PLAN) });
			}
			if (args[0] === "flashcards" || args[0] === "quiz") {
				return { stdout: `Artifact ID: artifact-${args[0]}`, stderr: "" };
			}
			if (args[0] === "studio") {
				const response = studioResponses[Math.min(studioResponseIndex, studioResponses.length - 1)];
				studioResponseIndex += 1;
				return jsonResult(response);
			}
			if (args[0] === "download") {
				const outputIndex = args.indexOf("--output");
				const outputPath = args[outputIndex + 1];
				assert.ok(outputPath);
				await writeFile(outputPath, JSON.stringify(downloaded), "utf8");
				return { stdout: "Downloaded", stderr: "" };
			}
			throw new Error(`Unexpected command: ${args.join(" ")}`);
		},
	};
}

function fakeAnkiClient(): { client: AnkiConnectInvoker; calls: Array<{ action: string; params: JsonObject }> } {
	const calls: Array<{ action: string; params: JsonObject }> = [];
	let importedCards = 0;
	const client: AnkiConnectInvoker = {
		async invoke<T>(action: string, params: JsonObject = {}): Promise<T> {
			calls.push({ action, params });
			if (action === "modelNames") return ["Basic"] as T;
			if (action === "modelFieldNames") return ["Front", "Back"] as T;
			if (action === "createDeck") return 1 as T;
			if (action === "multi") {
				const actions = params.actions;
				assert.ok(Array.isArray(actions));
				importedCards = actions.length;
				return actions.map((_, index) => ({ error: null, result: index + 1 })) as T;
			}
			if (action === "findNotes") {
				return Array.from({ length: importedCards }, (_, index) => index + 1) as T;
			}
			throw new Error(`Unexpected AnkiConnect action: ${action}`);
		},
	};
	return { client, calls };
}

test("generates flashcards only from the current selected source IDs and verifies the Anki upload", async () => {
	const runner = fakeRunner({
		title: "Kafka flashcards",
		cards: [{ front: "브로커란 무엇인가?", back: "Kafka 서버입니다." }],
	});
	const anki = fakeAnkiClient();
	const progress: string[] = [];

	const result = await generateAndImportToAnki("notebook-1", "flashcards", {
		sourceIds: ["source-2"],
		run: runner.run,
		ankiClient: anki.client,
		sleep: async () => undefined,
		onProgress: (update) => progress.push(`${update.phase}:${update.detail}`),
	});

	assert.deepEqual(result.selectedSourceIds, ["source-2"]);
	assert.equal(result.anki.deck, "kafka-fundamentals");
	assert.equal(result.anki.verifiedNotes, 1);
	const query = runner.calls.find((call) => call[0] === "query");
	const create = runner.calls.find((call) => call[0] === "flashcards");
	assert.deepEqual(query?.slice(-2), ["--source-ids", "source-2"]);
	assert.deepEqual(create?.slice(0, 5), ["flashcards", "create", "notebook-1", "--source-ids", "source-2"]);
	assert.ok(progress.some((item) => item.startsWith("generation:")));
	assert.ok(progress.some((item) => item.startsWith("sync:")));
	assert.deepEqual(anki.calls.map((item) => item.action), [
		"modelNames",
		"modelFieldNames",
		"createDeck",
		"multi",
		"findNotes",
	]);
});

test("waits through NotebookLM's not-found and unknown transitional artifact states", async () => {
	const runner = fakeRunner(
		{
			title: "Kafka flashcards",
			cards: [{ front: "브로커", back: "Kafka 서버" }],
		},
		undefined,
		[
			[],
			[{ id: "artifact-flashcards", type: "flashcards", status: "unknown" }],
			[{ id: "artifact-flashcards", type: "flashcards", status: "completed" }],
		],
	);
	const anki = fakeAnkiClient();
	const progress: string[] = [];

	const result = await generateAndImportToAnki("notebook-1", "flashcards", {
		sourceIds: ["source-1"],
		run: runner.run,
		ankiClient: anki.client,
		sleep: async () => undefined,
		onProgress: (update) => progress.push(update.detail),
	});

	assert.equal(result.anki.verifiedNotes, 1);
	assert.ok(progress.some((detail) => detail.includes("(not found)")));
	assert.ok(progress.some((detail) => detail.includes("(unknown)")));
	assert.equal(runner.calls.filter((call) => call[0] === "studio").length, 3);
});

test("allows ten minutes for NotebookLM artifact generation by default", () => {
	assert.equal(DEFAULT_ANKI_GENERATION_TIMEOUT_MS, 10 * 60 * 1_000);
});

test("rejects a source that is no longer selected in the NotebookLM notebook before artifact creation", async () => {
	const runner = fakeRunner({ title: "Unused", cards: [{ front: "F", back: "B" }] }, ["source-1"]);
	const anki = fakeAnkiClient();

	await assert.rejects(
		generateAndImportToAnki("notebook-1", "flashcards", {
			sourceIds: ["missing-source"],
			run: runner.run,
			ankiClient: anki.client,
			sleep: async () => undefined,
		}),
		AnkiGenerationError,
	);
	assert.equal(runner.calls.some((call) => call[0] === "flashcards"), false);
});

test("uses a direct dotted deck path over a root deck during Anki import", async () => {
	const runner = fakeRunner({
		title: "Kafka quiz",
		questions: [{
			question: "Kafka는 무엇인가요?",
			answerOptions: [
				{ text: "분산 이벤트 스트리밍 플랫폼", isCorrect: true, rationale: "Kafka의 핵심 역할입니다." },
				{ text: "관계형 데이터베이스", isCorrect: false, rationale: "Kafka는 관계형 DB가 아닙니다." },
			],
		}],
	});
	const anki = fakeAnkiClient();

	const result = await generateAndImportToAnki("notebook-1", "quiz", {
		sourceIds: ["source-1"],
		maxCount: 7,
		invalidSourceRatio: 0.2,
		ankiDeck: "DE.kafka",
		deckRoot: "Ignored Root",
		run: runner.run,
		ankiClient: anki.client,
		sleep: async () => undefined,
	});

	assert.equal(result.anki.deck, "DE::kafka");
	const query = runner.calls.find((call) => call[0] === "query");
	const create = runner.calls.find((call) => call[0] === "quiz");
	assert.ok(query);
	assert.ok(create);
	assert.equal(create[create.indexOf("--count") + 1], "7");
	assert.match(query[3] ?? "", /as close to 7 questions as the selected sources support/i);
	const focus = create[create.indexOf("--focus") + 1] ?? "";
	assert.match(focus, /as close to 7 questions as possible/i);
	assert.match(focus, /Korean \(ko-KR\)/i);
	assert.ok(focus.indexOf(PLAN.make_prompt) < focus.indexOf("Mandatory generation requirements"));
});

test("tolerates stale selected sources only below the requested invalid-source-ratio", async () => {
	const runner = fakeRunner({
		title: "Kafka flashcards",
		cards: [{ front: "브로커", back: "Kafka 서버" }],
	});
	const anki = fakeAnkiClient();

	const result = await generateAndImportToAnki("notebook-1", "flashcards", {
		sourceIds: ["source-1", "missing-source"],
		invalidSourceRatio: 0.6,
		deckRoot: "DE.kafka",
		run: runner.run,
		ankiClient: anki.client,
		sleep: async () => undefined,
	});

	assert.deepEqual(result.selectedSourceIds, ["source-1"]);
	assert.equal(result.anki.deck, "DE::kafka::kafka-fundamentals");
});
