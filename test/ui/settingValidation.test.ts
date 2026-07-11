import assert from "node:assert/strict";
import test from "node:test";
import { normalizeYamlPropertyKey } from "../../src/ui/settingValidation";

test("normalizes a one-word YAML property", () => {
	assert.deepEqual(normalizeYamlPropertyKey("  parents  "), {
		value: "parents",
		discardedExtraWords: false,
	});
});

test("keeps only the first YAML property word and reports discarded words", () => {
	assert.deepEqual(normalizeYamlPropertyKey("parent key ignored"), {
		value: "parent",
		discardedExtraWords: true,
	});
});

test("allows a blank YAML property", () => {
	assert.deepEqual(normalizeYamlPropertyKey("   "), {
		value: "",
		discardedExtraWords: false,
	});
});
