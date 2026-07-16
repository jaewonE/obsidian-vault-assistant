import process from "process";
import { delimiter, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Logger } from "../logging/logger";

export class NotebookLMMcpBinaryMissingError extends Error {
	constructor() {
		super(
			"Could not find notebooklm-mcp on PATH or in ~/.local/bin. Install notebooklm-mcp-cli globally (pip/uv/pipx) and restart Obsidian.",
		);
		this.name = "NotebookLMMcpBinaryMissingError";
	}
}

interface JsonObject {
	[key: string]: unknown;
}

interface ToolCallOptions {
	idempotent?: boolean;
	retryOnConnectionIssue?: boolean;
	requestTimeoutMs?: number;
	resetTimeoutOnProgress?: boolean;
	maxTotalTimeoutMs?: number;
}

function isRecord(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null;
}

function errorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}

/**
 * macOS GUI apps often receive a minimal PATH that omits the pipx default
 * location. Preserve the inherited environment while making the standard
 * user-local bin directory available to the MCP subprocess.
 */
export function buildMcpChildEnvironment(source: Record<string, string | undefined>): Record<string, string> {
	const environment: Record<string, string> = {};
	for (const [key, value] of Object.entries(source)) {
		if (typeof value === "string") {
			environment[key] = value;
		}
	}

	const homeDirectory = environment.HOME;
	if (!homeDirectory) {
		return environment;
	}

	const localBin = join(homeDirectory, ".local", "bin");
	const existingPaths = (environment.PATH ?? "")
		.split(delimiter)
		.filter((pathEntry) => pathEntry.length > 0);
	if (!existingPaths.includes(localBin)) {
		environment.PATH = [localBin, ...existingPaths].join(delimiter);
	}
	return environment;
}

export class NotebookLMMcpClient {
	private readonly logger: Logger;
	private client: Client | null = null;
	private transport: StdioClientTransport | null = null;
	private connectPromise: Promise<void> | null = null;
	private reconnectTimer: number | null = null;
	private debugMode = false;
	private shouldStop = false;
	private connected = false;

	constructor(logger: Logger) {
		this.logger = logger;
	}

	isConnected(): boolean {
		return this.connected;
	}

	async start(debugMode: boolean): Promise<void> {
		this.shouldStop = false;
		this.debugMode = debugMode;
		await this.connectIfNeeded();
	}

	async restart(debugMode: boolean): Promise<void> {
		this.logger.debug("Restarting MCP server", { debugMode });
		await this.stop();
		await this.start(debugMode);
	}

	async stop(): Promise<void> {
		this.logger.debug("Stopping MCP server subprocess");
		this.shouldStop = true;
		this.connected = false;

		if (this.reconnectTimer !== null) {
			window.clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}

		const client = this.client;
		this.client = null;
		this.transport = null;

		if (client) {
			try {
				await client.close();
			} catch (error) {
				this.logger.warn("Failed to close MCP client cleanly", errorMessage(error));
			}
		}

		this.logger.debug("MCP server subprocess stopped");
	}

	async callTool<T>(name: string, args: Record<string, unknown> = {}, options: ToolCallOptions = {}): Promise<T> {
		const invoke = async (): Promise<T> => {
			await this.connectIfNeeded();
			if (!this.client) {
				throw new Error("MCP client is not connected");
			}

			this.logger.debug(`MCP tool call: ${name}`, args);
			const rawResult = await this.client.callTool(
				{ name, arguments: args },
				undefined,
				{
					timeout: options.requestTimeoutMs,
					resetTimeoutOnProgress: options.resetTimeoutOnProgress,
					maxTotalTimeout: options.maxTotalTimeoutMs,
				},
			);
			const parsed = this.parseToolResult(rawResult);
			this.logger.debug(`MCP tool response: ${name}`, parsed);
			return parsed as T;
		};

		try {
			return await invoke();
		} catch (error) {
			if (error instanceof NotebookLMMcpBinaryMissingError) {
				throw error;
			}

			const canRetry =
				(options.retryOnConnectionIssue ?? true) &&
				(options.idempotent ?? false) &&
				this.isConnectionIssue(error);
			if (!canRetry) {
				throw error;
			}

			this.logger.warn(`MCP call failed, retrying once: ${name}`, errorMessage(error));
			this.connected = false;
			await this.connectFresh();
			return await invoke();
		}
	}

	private async connectIfNeeded(): Promise<void> {
		if (this.connected && this.client && this.transport) {
			return;
		}

		if (this.connectPromise) {
			await this.connectPromise;
			return;
		}

		this.connectPromise = this.connectFresh().finally(() => {
			this.connectPromise = null;
		});
		await this.connectPromise;
	}

	private async connectFresh(): Promise<void> {
		if (this.shouldStop) {
			return;
		}

		const args = ["--transport", "stdio"];
		if (this.debugMode) {
			args.push("--debug");
		}

		const env = buildMcpChildEnvironment(process.env);

		const transport = new StdioClientTransport({
			command: "notebooklm-mcp",
			args,
			env,
			stderr: "pipe",
		});
		const client = new Client(
			{
				name: "obsidian-notebooklm-plugin",
				version: "1.0.0",
			},
			{
				capabilities: {},
			},
		);

		const stderrStream = transport.stderr;
		if (stderrStream) {
			stderrStream.on("data", (chunk: Buffer | string) => {
				if (!this.debugMode) {
					return;
				}

				const text = typeof chunk === "string" ? chunk : chunk.toString("utf-8");
				this.logger.debug("MCP stderr", text.trim());
			});
		}

		client.onerror = (error) => {
			this.connected = false;
			this.logger.warn("MCP client error", errorMessage(error));
		};
		client.onclose = () => {
			this.connected = false;
			this.logger.warn("MCP client connection closed");
			this.scheduleReconnect();
		};

		this.logger.debug("Starting MCP server subprocess", {
			command: "notebooklm-mcp",
			args,
			pathIncludesUserLocalBin: env.PATH?.split(delimiter).includes(join(env.HOME ?? "", ".local", "bin")),
		});

		try {
			await client.connect(transport);
		} catch (error) {
			const message = errorMessage(error);
			if (message.includes("ENOENT") || message.includes("notebooklm-mcp")) {
				throw new NotebookLMMcpBinaryMissingError();
			}
			throw error;
		}

		this.client = client;
		this.transport = transport;
		this.connected = true;
		this.logger.debug("MCP server connected", { pid: transport.pid });
	}

	private scheduleReconnect(): void {
		if (this.shouldStop || this.reconnectTimer !== null) {
			return;
		}

		this.reconnectTimer = window.setTimeout(() => {
			this.reconnectTimer = null;
			if (this.shouldStop) {
				return;
			}

			void this.connectFresh().catch((error) => {
				this.logger.warn("Auto-reconnect failed", errorMessage(error));
				this.scheduleReconnect();
			});
		}, 1500);
	}

	private parseToolResult(rawResult: unknown): unknown {
		if (!isRecord(rawResult)) {
			return rawResult;
		}

		if (Object.prototype.hasOwnProperty.call(rawResult, "toolResult")) {
			return rawResult.toolResult;
		}

		if (Object.prototype.hasOwnProperty.call(rawResult, "structuredContent")) {
			return rawResult.structuredContent;
		}

		const content = rawResult.content;
		if (!Array.isArray(content)) {
			return rawResult;
		}

		const textBlocks = content
			.map((item) => (isRecord(item) && typeof item.text === "string" ? item.text : null))
			.filter((item): item is string => item !== null);

		if (textBlocks.length === 0) {
			return rawResult;
		}

		if (textBlocks.length === 1) {
			const onlyText = textBlocks[0];
			if (onlyText === undefined) {
				return rawResult;
			}

			const parsed = this.tryParseJson(onlyText);
			return parsed ?? { text: onlyText };
		}

		const parsedBlocks = textBlocks.map((text) => this.tryParseJson(text));
		if (parsedBlocks.every((item) => item !== null)) {
			return parsedBlocks;
		}

		return { text: textBlocks.join("\n\n") };
	}

	private tryParseJson(text: string): unknown | null {
		const trimmed = text.trim();
		if (!(trimmed.startsWith("{") || trimmed.startsWith("[") || trimmed.startsWith('"'))) {
			return null;
		}

		try {
			return JSON.parse(trimmed);
		} catch (_error) {
			return null;
		}
	}

	private isConnectionIssue(error: unknown): boolean {
		const message = errorMessage(error).toLowerCase();
		return (
			message.includes("not connected") ||
			message.includes("connection closed") ||
			message.includes("transport") ||
			message.includes("eof") ||
			message.includes("socket")
		);
	}
}
