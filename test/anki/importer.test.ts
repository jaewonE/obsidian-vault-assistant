import assert from "node:assert/strict";
import test from "node:test";
import { AnkiConnectClient, type AnkiConnectRequestUrlOptions } from "../../src/anki/importer";

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
