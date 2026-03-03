import assert from "node:assert/strict";
import test from "node:test";
import { searchSlashCommandSuggestions } from "../../src/ui/slashCommands";

test("returns all root slash commands for empty term", () => {
	const suggestions = searchSlashCommandSuggestions("");
	assert.deepEqual(
		suggestions.map((item) => item.text),
		["/source", "/create", "/setting", "/research"],
	);
});

test("filters root slash commands by typed text", () => {
	const suggestions = searchSlashCommandSuggestions("s");
	assert.deepEqual(
		suggestions.map((item) => item.text),
		["/source", "/setting"],
	);
});

test("filters root slash commands by research prefix", () => {
	const suggestions = searchSlashCommandSuggestions("re");
	assert.deepEqual(
		suggestions.map((item) => item.text),
		["/research"],
	);
});

test("shows source subcommands after root command is completed", () => {
	const suggestions = searchSlashCommandSuggestions("source ");
	assert.deepEqual(
		suggestions.map((item) => item.text),
		["/source add", "/source get"],
	);
});

test("filters source subcommands by typed subcommand text", () => {
	const suggestions = searchSlashCommandSuggestions("source ad");
	assert.deepEqual(
		suggestions.map((item) => item.text),
		["/source add"],
	);
});

test("returns no suggestions when subcommand does not match", () => {
	const suggestions = searchSlashCommandSuggestions("source edit");
	assert.equal(suggestions.length, 0);
});

test("shows research subcommands after root command is completed", () => {
	const suggestions = searchSlashCommandSuggestions("research ");
	assert.deepEqual(
		suggestions.map((item) => item.text),
		["/research links", "/research deep"],
	);
});

test("filters research subcommands", () => {
	const suggestions = searchSlashCommandSuggestions("research de");
	assert.deepEqual(
		suggestions.map((item) => item.text),
		["/research deep"],
	);
});
