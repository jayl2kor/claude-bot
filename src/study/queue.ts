/**
 * Study queue — manages study requests with sequential processing,
 * daily rate limiting, and persistence.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isENOENT } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import type { TopicResearcher } from "./researcher.js";
import type {
	StudyConfig,
	StudyQueueState,
	StudyRequest,
	StudyResult,
} from "./types.js";
import { StudyQueueStateSchema } from "./types.js";

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export type EnqueueResult = {
	readonly success: boolean;
	readonly request?: StudyRequest;
	readonly reason?: string;
};

export type StudyNotifyFn = (
	topic: string,
	result: StudyResult | null,
	error?: string,
) => void;

export class StudyQueue {
	private state: StudyQueueState = {
		requests: [],
		dailyCount: 0,
		dailyResetAt: Date.now() + ONE_DAY_MS,
	};
	private isProcessing = false;
	private loaded = false;
	private readonly filePath: string;
	private researcher: TopicResearcher | null = null;
	private notifyFn: StudyNotifyFn | null = null;

	constructor(
		private readonly config: StudyConfig,
		dataDir: string,
	) {
		this.filePath = join(dataDir, "study-queue.json");
	}

	/** Set the researcher instance (injected after construction). */
	setResearcher(researcher: TopicResearcher): void {
		this.researcher = researcher;
	}

	/** Set the notification callback. */
	setNotifyFn(fn: StudyNotifyFn): void {
		this.notifyFn = fn;
	}

	/**
	 * Enqueue a new study topic.
	 * Returns success/failure with reason.
	 */
	async enqueue(topic: string): Promise<EnqueueResult> {
		await this.ensureLoaded();
		this.checkDailyReset();

		if (this.state.dailyCount >= this.config.maxDailySessions) {
			return {
				success: false,
				reason: `일일 학습 한도(${this.config.maxDailySessions}회)에 도달했습니다. 내일 다시 시도해주세요.`,
			};
		}

		const request: StudyRequest = {
			id: randomUUID(),
			topic,
			status: "queued",
			requestedAt: Date.now(),
		};

		this.state = {
			...this.state,
			requests: [...this.state.requests, request],
			dailyCount: this.state.dailyCount + 1,
		};

		await this.persist();

		// Trigger background processing (fire and forget)
		void this.processNext();

		return { success: true, request };
	}

	/** Get current queue state. */
	async getState(): Promise<StudyQueueState> {
		await this.ensureLoaded();
		return { ...this.state };
	}

	/**
	 * Process the next queued item.
	 * Uses a simple mutex (isProcessing flag) for sequential processing.
	 */
	private async processNext(): Promise<void> {
		if (this.isProcessing) return;
		if (!this.researcher) {
			logger.warn("StudyQueue: no researcher set, skipping processing");
			return;
		}

		const nextIdx = this.state.requests.findIndex((r) => r.status === "queued");
		if (nextIdx < 0) return;

		this.isProcessing = true;

		try {
			// Update status to in_progress
			const request = this.state.requests[nextIdx];
			if (!request) return;
			this.state = {
				...this.state,
				requests: this.state.requests.map((r, i) =>
					i === nextIdx ? { ...r, status: "in_progress" as const } : r,
				),
			};
			await this.persist();

			// Run research
			const result = await this.researcher.research(request.topic);

			// Update status to completed
			this.state = {
				...this.state,
				requests: this.state.requests.map((r) =>
					r.id === request.id
						? {
								...r,
								status: "completed" as const,
								completedAt: Date.now(),
								result,
							}
						: r,
				),
			};
			await this.persist();

			// Notify completion
			this.notifyFn?.(request.topic, result);

			logger.info("Study completed", {
				topic: request.topic,
				subtopics: result.subtopics.length,
			});
		} catch (err) {
			const errorMsg = err instanceof Error ? err.message : "Unknown error";

			// Update status to failed
			const failedRequest = this.state.requests[nextIdx];
			if (failedRequest) {
				this.state = {
					...this.state,
					requests: this.state.requests.map((r) =>
						r.id === failedRequest.id
							? {
									...r,
									status: "failed" as const,
									error: errorMsg,
								}
							: r,
					),
				};
				await this.persist();

				// Notify failure
				this.notifyFn?.(failedRequest.topic, null, errorMsg);
			}

			logger.error("Study failed", { error: errorMsg });
		} finally {
			this.isProcessing = false;
		}

		// Process next item in queue
		void this.processNext();
	}

	/** Ensure state is loaded from disk. */
	private async ensureLoaded(): Promise<void> {
		if (this.loaded) return;
		this.loaded = true;

		try {
			const raw = await readFile(this.filePath, "utf8");
			const parsed = JSON.parse(raw);
			const result = StudyQueueStateSchema.safeParse(parsed);

			if (result.success) {
				this.state = result.data;

				// Recovery: reset in_progress → queued (crash recovery)
				this.state = {
					...this.state,
					requests: this.state.requests.map((r) =>
						r.status === "in_progress"
							? { ...r, status: "queued" as const }
							: r,
					),
				};

				// Check daily reset
				this.checkDailyReset();

				await this.persist();
			}
		} catch (err) {
			if (!isENOENT(err)) {
				logger.warn("Failed to load study queue state", {
					error: String(err),
				});
			}
		}
	}

	/** Check if daily count should be reset. */
	private checkDailyReset(): void {
		if (Date.now() >= this.state.dailyResetAt) {
			this.state = {
				...this.state,
				dailyCount: 0,
				dailyResetAt: Date.now() + ONE_DAY_MS,
			};
		}
	}

	/** Persist state to disk. */
	private async persist(): Promise<void> {
		try {
			await mkdir(dirname(this.filePath), { recursive: true });
			const tmp = `${this.filePath}.${randomUUID()}.tmp`;
			await writeFile(tmp, JSON.stringify(this.state, null, 2), "utf8");
			// Atomic rename
			const { rename } = await import("node:fs/promises");
			await rename(tmp, this.filePath);
		} catch (err) {
			logger.warn("Failed to persist study queue state", {
				error: String(err),
			});
		}
	}
}
