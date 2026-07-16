import assert from "node:assert/strict";
import test from "node:test";
import { AnkiConnectClient, parseNlmDocument, type AnkiConnectRequestUrlOptions } from "../../src/anki/importer";

test("uses the injected Obsidian requestUrl bridge for AnkiConnect requests", async () => {
	const requests: AnkiConnectRequestUrlOptions[] = [];
	const client = new AnkiConnectClient(async (request) => {
		requests.push(request);
		return {
			status: 200,
			text: JSON.stringify({ error: null, result: ["Basic"] }),
		};
	});

	assert.deepEqual(await client.invoke("modelNames"), ["Basic"]);
	assert.deepEqual(requests, [
		{
			url: "http://127.0.0.1:8765",
			method: "POST",
			contentType: "application/json",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ action: "modelNames", params: {}, version: 6 }),
			throw: false,
		},
	]);
});

test("renders quiz wrapper labels in Korean", () => {
	const parsed = parseNlmDocument({
		title: "Kafka 퀴즈",
		questions: [{
			question: "Kafka의 역할은 무엇인가요?",
			hint: "이벤트 스트리밍을 생각하세요.",
			answerOptions: [
				{ text: "분산 이벤트 스트리밍", isCorrect: true, rationale: "Kafka의 핵심 역할입니다." },
				{ text: "관계형 데이터베이스", isCorrect: false, rationale: "Kafka는 데이터베이스가 아닙니다." },
			],
		}],
	});

	assert.match(parsed.cards[0]?.front ?? "", /문항 1/);
	assert.match(parsed.cards[0]?.front ?? "", /힌트/);
	assert.match(parsed.cards[0]?.front ?? "", /선택지/);
	assert.match(parsed.cards[0]?.back ?? "", /정답/);
	assert.match(parsed.cards[0]?.back ?? "", /모든 선택지 해설/);
});
