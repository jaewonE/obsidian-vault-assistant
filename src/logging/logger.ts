export class Logger {
	private readonly prefix: string;
	private readonly maxLength: number;
	private readonly isDebugEnabled: () => boolean;

	constructor(isDebugEnabled: () => boolean, prefix = "[NotebookLM]", maxLength = 1600) {
		this.isDebugEnabled = isDebugEnabled;
		this.prefix = prefix;
		this.maxLength = maxLength;
	}

	debug(message: string, payload?: unknown): void {
		if (!this.isDebugEnabled()) {
			return;
		}

		if (payload === undefined) {
			console.debug(`${this.prefix} ${message}`);
			return;
		}

		console.debug(`${this.prefix} ${message}`, this.truncate(payload));
	}

	info(message: string, payload?: unknown): void {
		if (payload === undefined) {
			console.info(`${this.prefix} ${message}`);
			return;
		}

		console.info(`${this.prefix} ${message}`, this.truncate(payload));
	}

	warn(message: string, payload?: unknown): void {
		if (payload === undefined) {
			console.warn(`${this.prefix} ${message}`);
			return;
		}

		console.warn(`${this.prefix} ${message}`, this.truncate(payload));
	}

	error(message: string, payload?: unknown): void {
		if (payload === undefined) {
			console.error(`${this.prefix} ${message}`);
			return;
		}

		console.error(`${this.prefix} ${message}`, this.truncate(payload));
	}

	private truncate(payload: unknown): unknown {
		if (typeof payload === "string") {
			if (payload.length <= this.maxLength) {
				return payload;
			}

			return `${payload.slice(0, this.maxLength)}...`;
		}

		try {
			const serialized = JSON.stringify(payload);
			if (serialized.length <= this.maxLength) {
				return payload;
			}

			return `${serialized.slice(0, this.maxLength)}...`;
		} catch (_error) {
			return payload;
		}
	}
}
