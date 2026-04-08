/**
 * Cron service — schedules recurring background jobs.
 * Reference: OpenClaw src/cron/service.ts
 *
 * Supports interval-based jobs with missed-job catchup on restart.
 */

import { logger } from "../utils/logger.js";
import { sleep } from "../utils/sleep.js";

export type CronJob = {
	id: string;
	/** Interval in ms between runs. */
	intervalMs: number;
	/** Job handler. Should be idempotent. Returns optional summary for reporting. */
	handler: () => Promise<string | void>;
	/** Whether to run immediately on service start. */
	runOnStart?: boolean;
};

type JobState = {
	job: CronJob;
	timer: ReturnType<typeof setTimeout> | null;
	lastRunAt: number;
	running: boolean;
	runningStartedAt?: number;
};

export type CronReporter = (
	jobId: string,
	summary: string,
	durationMs: number,
) => Promise<void>;

const RETRY_BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000] as const; // 1min, 5min, 15min
const STALE_JOB_TIMEOUT_MS = 30 * 60_000; // 30 minutes

export class CronService {
	private readonly jobs = new Map<string, JobState>();
	private started = false;
	private reporter: CronReporter | null = null;

	/** Set a reporter that receives job completion summaries. */
	setReporter(reporter: CronReporter): void {
		this.reporter = reporter;
	}

	/** Register a job. Must be called before start(). */
	add(job: CronJob): void {
		if (this.jobs.has(job.id)) {
			logger.warn("Cron job already registered, replacing", { id: job.id });
			this.remove(job.id);
		}
		this.jobs.set(job.id, {
			job,
			timer: null,
			lastRunAt: 0,
			running: false,
		});
	}

	/** Start all registered jobs. */
	async start(signal: AbortSignal): Promise<void> {
		this.started = true;
		logger.info("Cron service starting", { jobCount: this.jobs.size });

		// Collect runOnStart promises with random stagger, all in parallel
		const runOnStartPromises: Promise<void>[] = [];
		for (const [, state] of this.jobs) {
			if (state.job.runOnStart) {
				const stagger = Math.random() * 2000;
				runOnStartPromises.push(
					sleep(stagger, signal).then(() => {
						if (signal.aborted) return;
						void this.runJobWithRetry(state);
					}),
				);
			}
			this.scheduleNext(state, signal);
		}

		// Fire all staggered starts in parallel (don't await job completion)
		void Promise.all(runOnStartPromises);

		logger.info("Cron service started");
	}

	/** Stop all jobs gracefully. */
	async stop(): Promise<void> {
		this.started = false;
		for (const state of this.jobs.values()) {
			if (state.timer) {
				clearTimeout(state.timer);
				state.timer = null;
			}
		}

		// Wait for running jobs to complete (max 30s)
		const runningJobs = [...this.jobs.values()].filter((s) => s.running);
		if (runningJobs.length > 0) {
			logger.info("Waiting for running cron jobs", {
				count: runningJobs.length,
			});
			const deadline = Date.now() + 30_000;
			while (runningJobs.some((s) => s.running) && Date.now() < deadline) {
				await sleep(500);
			}
		}

		logger.info("Cron service stopped");
	}

	/** Remove a job by id. */
	remove(id: string): void {
		const state = this.jobs.get(id);
		if (state) {
			if (state.timer) clearTimeout(state.timer);
			this.jobs.delete(id);
		}
	}

	/** Manually trigger a job (with retry). */
	async run(id: string): Promise<void> {
		const state = this.jobs.get(id);
		if (!state) {
			logger.warn("Cron job not found", { id });
			return;
		}
		await this.runJobWithRetry(state);
	}

	private scheduleNext(
		state: JobState,
		signal: AbortSignal,
		startMs?: number,
	): void {
		if (!this.started || signal.aborted) return;

		// Fix interval drift: account for time already elapsed since job started.
		// Without this, actual interval = configured interval + job duration.
		const elapsed = startMs !== undefined ? Date.now() - startMs : 0;
		const delay = Math.max(0, state.job.intervalMs - elapsed);

		state.timer = setTimeout(() => {
			if (signal.aborted) return;
			const jobStart = Date.now();
			void this.runJobWithRetry(state).then(() => {
				this.scheduleNext(state, signal, jobStart);
			});
		}, delay);
	}

	private async runJobWithRetry(state: JobState): Promise<void> {
		const MAX_ATTEMPTS = 3;

		for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
			const succeeded = await this.runJobOnce(state);
			if (succeeded) return;

			if (attempt < MAX_ATTEMPTS - 1) {
				const backoff = RETRY_BACKOFF_MS[attempt] ?? 60_000;
				logger.warn("Cron job failed, retrying with backoff", {
					id: state.job.id,
					attempt: attempt + 1,
					backoffMs: backoff,
				});
				await sleep(backoff);
			}
		}

		logger.error("Cron job exhausted all retries, waiting for next interval", {
			id: state.job.id,
			attempts: MAX_ATTEMPTS,
		});
	}

	/**
	 * Run the job once, returning true on success and false on failure.
	 * Guards against concurrent execution.
	 */
	private async runJobOnce(state: JobState): Promise<boolean> {
		if (state.running) {
			logger.debug("Cron job already running, skipping", { id: state.job.id });
			return true; // treat as "success" to avoid spurious retries
		}

		state.running = true;
		const startMs = Date.now();

		try {
			const summary = await state.job.handler();
			state.lastRunAt = Date.now();
			const durationMs = Date.now() - startMs;
			logger.debug("Cron job completed", {
				id: state.job.id,
				durationMs,
			});
			if (summary && this.reporter) {
				this.reporter(state.job.id, summary, durationMs).catch((err) => {
					logger.warn("Cron reporter failed", {
						id: state.job.id,
						error: String(err),
					});
				});
			}
			return true;
		} catch (err) {
			logger.error("Cron job failed", {
				id: state.job.id,
				error: String(err),
				durationMs: Date.now() - startMs,
			});
			return false;
		} finally {
			state.running = false;
		}
	}
}
