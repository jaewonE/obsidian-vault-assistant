import assert from "node:assert/strict";
import test from "node:test";
import { NotebookLMMcpClient } from "../../src/mcp/NotebookLMMcpClient";

class SilentLogger {
	debug(): void {}
	info(): void {}
	warn(): void {}
	error(): void {}
}

test("retries connection issue once for idempotent calls", async () => {
	const client = new NotebookLMMcpClient(new SilentLogger() as never) as never as {
		callTool<T>(name: string, args?: Record<string, unknown>, options?: { idempotent?: boolean }): Promise<T>;
		client: { callTool: () => Promise<unknown> };
		connectIfNeeded: () => Promise<void>;
		connectFresh: () => Promise<void>;
		isConnectionIssue: (error: unknown) => boolean;
	};

	let attempts = 0;
	let reconnects = 0;
	client.connectIfNeeded = async () => {};
	client.connectFresh = async () => {
		reconnects += 1;
	};
	client.isConnectionIssue = () => true;
	client.client = {
		callTool: async () => {
			attempts += 1;
			if (attempts === 1) {
				throw new Error("connection closed");
			}
			return { structuredContent: { ok: true } };
		},
	};

	const result = await client.callTool<{ ok: boolean }>("server_info", {}, { idempotent: true });
	assert.deepEqual(result, { ok: true });
	assert.equal(attempts, 2);
	assert.equal(reconnects, 1);
});

test("does not retry connection issue for non-idempotent calls", async () => {
	const client = new NotebookLMMcpClient(new SilentLogger() as never) as never as {
		callTool<T>(name: string, args?: Record<string, unknown>, options?: { idempotent?: boolean }): Promise<T>;
		client: { callTool: () => Promise<unknown> };
		connectIfNeeded: () => Promise<void>;
		connectFresh: () => Promise<void>;
		isConnectionIssue: (error: unknown) => boolean;
	};

	let attempts = 0;
	let reconnects = 0;
	client.connectIfNeeded = async () => {};
	client.connectFresh = async () => {
		reconnects += 1;
	};
	client.isConnectionIssue = () => true;
	client.client = {
		callTool: async () => {
			attempts += 1;
			throw new Error("connection closed");
		},
	};

	await assert.rejects(
		() => client.callTool("source_add", {}, { idempotent: false }),
		/connection closed/,
	);
	assert.equal(attempts, 1);
	assert.equal(reconnects, 0);
});

test("does not retry when retryOnConnectionIssue is disabled", async () => {
	const client = new NotebookLMMcpClient(new SilentLogger() as never) as never as {
		callTool<T>(
			name: string,
			args?: Record<string, unknown>,
			options?: { idempotent?: boolean; retryOnConnectionIssue?: boolean },
		): Promise<T>;
		client: { callTool: () => Promise<unknown> };
		connectIfNeeded: () => Promise<void>;
		connectFresh: () => Promise<void>;
		isConnectionIssue: (error: unknown) => boolean;
	};

	let attempts = 0;
	let reconnects = 0;
	client.connectIfNeeded = async () => {};
	client.connectFresh = async () => {
		reconnects += 1;
	};
	client.isConnectionIssue = () => true;
	client.client = {
		callTool: async () => {
			attempts += 1;
			throw new Error("connection closed");
		},
	};

	await assert.rejects(
		() => client.callTool("server_info", {}, { idempotent: true, retryOnConnectionIssue: false }),
		/connection closed/,
	);
	assert.equal(attempts, 1);
	assert.equal(reconnects, 0);
});
