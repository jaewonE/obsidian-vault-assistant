import assert from "node:assert/strict";
import test from "node:test";
import {
	buildAnkiHistoryFailureMessage,
	buildAnkiHistorySuccessMessage,
} from "../../src/plugin/ankiHistory";

test("summarizes a fully imported Anki artifact for conversation history", () => {
	assert.equal(
		buildAnkiHistorySuccessMessage({
			type: "flashcards",
			sourceTitles: ["00", "01"],
			sourceCount: 13,
			generatedCards: 30,
			createdCards: 30,
			skippedDuplicates: 0,
			deck: "DE::OOOO",
		}),
		"00 외 12 소스에 대한 Flashcards 30개를 생성해 ANKI의 DE 덱 하위에 OOOO로 추가하였습니다.",
	);
});

test("reports duplicate-aware imports and failures in the conversation language", () => {
	assert.equal(
		buildAnkiHistorySuccessMessage({
			type: "quiz",
			sourceTitles: ["Kafka"],
			sourceCount: 1,
			generatedCards: 20,
			createdCards: 17,
			skippedDuplicates: 3,
			deck: "Review",
		}),
		"Kafka 소스에 대한 Quiz 20개를 생성해 ANKI의 Review 덱에 17개를 추가했으며, 중복 3개는 건너뛰었습니다.",
	);
	assert.equal(
		buildAnkiHistoryFailureMessage({
			type: "quiz",
			sourceTitles: [],
			sourceCount: 2,
			error: "AnkiConnect is unavailable.",
		}),
		"선택한 2개 소스에 대한 Quiz 생성에 실패했습니다: AnkiConnect is unavailable.",
	);
});
