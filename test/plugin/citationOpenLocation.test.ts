import assert from "node:assert/strict";
import test from "node:test";
import { getCitationSplitSide, selectCitationEdgePane } from "../../src/plugin/citationOpenLocation";

test("maps citation opening preferences to split sides", () => {
	assert.equal(getCitationSplitSide("current-tab"), null);
	assert.equal(getCitationSplitSide("new-tab"), null);
	assert.equal(getCitationSplitSide("left-split"), "left");
	assert.equal(getCitationSplitSide("right-split"), "right");
});

test("uses the outermost split pane only when at least two panes exist", () => {
	assert.equal(selectCitationEdgePane([{ value: "only", left: 20, right: 400 }], "right"), null);

	const panes = [
		{ value: "left", left: 0, right: 300 },
		{ value: "middle", left: 300, right: 700 },
		{ value: "right", left: 700, right: 1200 },
	];
	assert.equal(selectCitationEdgePane(panes, "left"), "left");
	assert.equal(selectCitationEdgePane(panes, "right"), "right");
});
