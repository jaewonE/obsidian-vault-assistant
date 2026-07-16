import assert from "node:assert/strict";
import test from "node:test";
import { extractQueryCitations, getLocalCitationSourceKind } from "../../src/plugin/citations";

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
