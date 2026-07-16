import assert from "node:assert/strict";
import test from "node:test";
import {
	extractQueryCitations,
	getLocalCitationSourceKind,
	normalizeQueryCitations,
	parseCitationMarker,
} from "../../src/plugin/citations";

test("extracts citation number to source id mappings and evidence passages", () => {
	const citations = extractQueryCitations({
		answer: "A [1] B [2]",
		citations: {
			"1": "source-document",
			"2": "source-image",
		},
		references: [
			{
				citation_number: 2,
				source_id: "source-image",
				cited_text: "The chart shows the requested trend.",
			},
			{
				citation_number: 1,
				source_id: "source-document",
				cited_text: "The document supports claim A.",
			},
		],
	});

	assert.deepEqual(citations, [
		{
			citationNumber: 1,
			sourceId: "source-document",
			citedText: "The document supports claim A.",
		},
		{
			citationNumber: 2,
			sourceId: "source-image",
			citedText: "The chart shows the requested trend.",
		},
	]);
});

test("uses reference entries when a query response omits the citations map", () => {
	const citations = extractQueryCitations({
		data: {
			references: [
				{ citation_number: "3", source_id: "source-search", cited_text: "Search evidence." },
				{ citation_number: 0, source_id: "ignored" },
				{ citation_number: 4, source_id: "   " },
			],
		},
	});

	assert.deepEqual(citations, [
		{
			citationNumber: 3,
			sourceId: "source-search",
			citedText: "Search evidence.",
		},
	]);
});

test("classifies local image citations separately from document citations", () => {
	assert.equal(getLocalCitationSourceKind("figures/benchmark.PNG"), "image");
	assert.equal(getLocalCitationSourceKind("notes/benchmark.pdf"), "document");
});

test("parses one or more citation numbers from a rendered marker", () => {
	assert.deepEqual(parseCitationMarker("[3]"), [3]);
	assert.deepEqual(parseCitationMarker("[3,4]"), [3, 4]);
	assert.deepEqual(parseCitationMarker("[3, 4, 12]"), [3, 4, 12]);
	assert.deepEqual(parseCitationMarker("[3, source-4]"), []);
});

test("normalizes passage citations to one citation number per source", () => {
	const normalized = normalizeQueryCitations("First fact [3,4]. Second fact [2]. Repeated fact [4].", [
		{ citationNumber: 2, sourceId: "source-second", citedText: "Second source evidence." },
		{ citationNumber: 3, sourceId: "source-first", citedText: "First source evidence A." },
		{ citationNumber: 4, sourceId: "source-first", citedText: "First source evidence B." },
	]);

	assert.equal(normalized.answer, "First fact [1]. Second fact [2]. Repeated fact [1].");
	assert.deepEqual(normalized.citations, [
		{ citationNumber: 1, sourceId: "source-first", citedText: "First source evidence A." },
		{ citationNumber: 2, sourceId: "source-second", citedText: "Second source evidence." },
	]);
});

test("leaves citation markers with an unmapped number unchanged", () => {
	const normalized = normalizeQueryCitations("Mapped [3]. Incomplete [3,99].", [
		{ citationNumber: 3, sourceId: "source-first" },
	]);

	assert.equal(normalized.answer, "Mapped [1]. Incomplete [3,99].");
	assert.deepEqual(normalized.citations, [{ citationNumber: 1, sourceId: "source-first" }]);
});
