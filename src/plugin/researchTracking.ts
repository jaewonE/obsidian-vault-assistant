export type ResearchMode = "fast" | "deep";

export type ResearchTerminalStatus = "completed" | "no_research" | "error" | "timeout";

export interface ResearchStatusSourceItem {
	index?: number;
	title?: string;
	url?: string;
	result_type_name?: string;
}

export interface ResearchStatusResponse {
	status?: string;
	task_id?: string;
	sources_found?: number;
	report?: string;
	sources?: ResearchStatusSourceItem[];
	message?: string;
	error?: string;
}

export interface ResearchStatusPollRequest {
	notebookId: string;
	taskId: string | null;
	query: string;
}

export interface ResearchStatusTrackerUpdate {
	pollCount: number;
	consecutiveErrors: number;
	currentTaskId: string | null;
	response: ResearchStatusResponse | null;
}

export interface ResearchStatusTrackerParams {
	mode: ResearchMode;
	notebookId: string;
	query: string;
	startTaskId: string | null;
	pollStatus: (request: ResearchStatusPollRequest) => Promise<ResearchStatusResponse>;
	onUpdate?: (update: ResearchStatusTrackerUpdate) => void;
	delay?: (ms: number) => Promise<void>;
	maxWaitMs?: number;
	maxConsecutiveErrors?: number;
	avgDeepSeconds?: number;
	jitterMs?: () => number;
}

export interface ResearchStatusTrackerResult {
	status: ResearchTerminalStatus;
	startTaskId: string | null;
	taskId: string | null;
	taskIdChanged: boolean;
	pollCount: number;
	response: ResearchStatusResponse | null;
}

const AVG_DEEP_SECONDS = 282;

function normalizeStatus(value: unknown): string {
	return typeof value === "string" ? value.toLocaleLowerCase() : "in_progress";
}

function defaultDelay(ms: number): Promise<void> {
	return new Promise((resolve) => window.setTimeout(resolve, Math.max(0, ms)));
}

function baseIntervalMs(mode: ResearchMode, elapsedMs: number, pollCount: number, avgDeepSeconds: number): number {
	if (mode === "fast") {
		if (pollCount === 0) {
			return 1000;
		}
		return 5000;
	}

	if (pollCount === 0) {
		return 2000;
	}

	const avgMs = Math.max(1, Math.floor(avgDeepSeconds)) * 1000;
	if (elapsedMs < avgMs) {
		return 20000;
	}
	if (elapsedMs < avgMs + 90_000) {
		return 10000;
	}
	return 5000;
}

function withBackoff(baseMs: number, consecutiveErrors: number): number {
	if (consecutiveErrors <= 0) {
		return baseMs;
	}
	return Math.min(baseMs * 2 ** consecutiveErrors, 60_000);
}

export function getResearchImportIndices(
	mode: ResearchMode,
	sources: ResearchStatusSourceItem[],
): number[] {
	if (mode === "fast") {
		return sources
			.map((source, fallbackIndex) =>
				typeof source.index === "number" && Number.isFinite(source.index)
					? source.index
					: fallbackIndex,
			)
			.filter((index) => Number.isInteger(index) && index >= 0);
	}

	return sources
		.map((source, fallbackIndex) => ({
			index:
				typeof source.index === "number" && Number.isFinite(source.index)
					? source.index
					: fallbackIndex,
			isWeb: source.result_type_name === "web",
			hasUrl: typeof source.url === "string" && source.url.trim().length > 0,
		}))
		.filter((item) => item.isWeb && item.hasUrl)
		.map((item) => item.index)
		.filter((index) => Number.isInteger(index) && index >= 0);
}

export async function trackResearchStatus(
	params: ResearchStatusTrackerParams,
): Promise<ResearchStatusTrackerResult> {
	const delay = params.delay ?? defaultDelay;
	const maxWaitMs = params.maxWaitMs ?? 30 * 60 * 1000;
	const maxConsecutiveErrors = params.maxConsecutiveErrors ?? 8;
	const avgDeepSeconds = params.avgDeepSeconds ?? AVG_DEEP_SECONDS;
	const jitterMs = params.jitterMs ?? (() => Math.floor(Math.random() * 1000));

	const startedAtMs = Date.now();
	const deadline = startedAtMs + Math.max(1000, maxWaitMs);
	let currentTaskId = params.startTaskId;
	let pollCount = 0;
	let consecutiveErrors = 0;
	let finalResponse: ResearchStatusResponse | null = null;
	let taskIdChanged = false;

	while (Date.now() < deadline) {
		const elapsedMs = Date.now() - startedAtMs;
		const baseMs = baseIntervalMs(params.mode, elapsedMs, pollCount, avgDeepSeconds);
		const jitter = consecutiveErrors > 0 ? Math.max(0, jitterMs()) : 0;
		const waitMs = withBackoff(baseMs, consecutiveErrors) + jitter;
		await delay(waitMs);

		let response: ResearchStatusResponse;
		try {
			response = await params.pollStatus({
				notebookId: params.notebookId,
				taskId: currentTaskId,
				query: params.query,
			});
		} catch {
			consecutiveErrors += 1;
			pollCount += 1;
			params.onUpdate?.({
				pollCount,
				consecutiveErrors,
				currentTaskId,
				response: null,
			});
			if (consecutiveErrors >= maxConsecutiveErrors) {
				return {
					status: "error",
					startTaskId: params.startTaskId,
					taskId: currentTaskId,
					taskIdChanged,
					pollCount,
					response: finalResponse,
				};
			}
			continue;
		}

		const responseTaskId = typeof response.task_id === "string" ? response.task_id : null;
		if (responseTaskId && responseTaskId !== currentTaskId) {
			currentTaskId = responseTaskId;
			taskIdChanged = true;
		}

		const normalized = normalizeStatus(response.status);
		const isTransientFailure = normalized === "error" || normalized === "timeout";
		if (isTransientFailure) {
			consecutiveErrors += 1;
		} else {
			consecutiveErrors = 0;
		}
		pollCount += 1;
		finalResponse = response;
		params.onUpdate?.({
			pollCount,
			consecutiveErrors,
			currentTaskId,
			response,
		});

		if (normalized === "completed" || normalized === "no_research") {
			return {
				status: normalized,
				startTaskId: params.startTaskId,
				taskId: currentTaskId,
				taskIdChanged,
				pollCount,
				response,
			};
		}

		if (isTransientFailure && consecutiveErrors >= maxConsecutiveErrors) {
			return {
				status: "error",
				startTaskId: params.startTaskId,
				taskId: currentTaskId,
				taskIdChanged,
				pollCount,
				response,
			};
		}
	}

	return {
		status: "timeout",
		startTaskId: params.startTaskId,
		taskId: currentTaskId,
		taskIdChanged,
		pollCount,
		response: finalResponse,
	};
}
