import assert from "node:assert/strict";
import test from "node:test";
import { mergeModelRefresh } from "../extensions/model-refresh.ts";

const model = (id, name = id) => ({ id, name });

test("keeps cached models while applying fresh metadata", () => {
	const result = mergeModelRefresh(
		[model("configured")],
		[model("default", "cached default"), model("shared", "cached metadata")],
		[model("shared", "fresh metadata"), model("new")],
	);

	assert.deepEqual(result.map(({ id }) => id), ["configured", "default", "shared", "new"]);
	assert.equal(result.find(({ id }) => id === "default").name, "cached default");
	assert.equal(result.find(({ id }) => id === "shared").name, "fresh metadata");
});

test("seeds cached models into the initial provider catalog", () => {
	const result = mergeModelRefresh([model("configured")], [model("cached-default")], []);

	assert.deepEqual(result.map(({ id }) => id), ["configured", "cached-default"]);
});

test("allows a forced refresh to prune cached models", () => {
	const result = mergeModelRefresh(
		[model("configured")],
		[model("stale")],
		[model("new")],
		false,
	);

	assert.deepEqual(result.map(({ id }) => id), ["configured", "new"]);
});
