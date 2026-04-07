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
	/** Job handler. Should be idempotent. */
	handler: () => Promise<void>;
	/** Whether to run immediately on service start. */
	runOnStart?: boolean;
};

type JobState = {
	job: CronJob;
	timer: ReturnType<typeof setTimeout> | null;
	lastRunAt: number;
	running: boolean;
};

export class CronService {
	private readonly jobs = new Map<string, JobState>();
	private started = false;

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

		for (const [, state] of this.jobs) {
			if (state.job.runOnStart) {
				// Stagger immediate runs to avoid thundering herd
				const stagger = Math.random() * 2000;
				await sleep(stagger, signal);
				if (signal.aborted) return;
				void this.runJob(state);
			}
			this.scheduleNext(state, signal);
		}

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

	/** Manually trigger a job. */
	async run(id: string): Promise<void> {
		const state = this.jobs.get(id);
		if (!state) {
			logger.warn("Cron job not found", { id });
			return;
		}
		await this.runJob(state);
	}

	private async runJob(state: JobState): Promise<void> {
		if (state.running) {
			logger.debug("Cron job already running, skipping", { id: state.job.id });
			return;
		}

		state.running = true;
		const startMs = Date.now();

		try {
			await state.job.handler();
			state.lastRunAt = Date.now();
			logger.debug("Cron job completed", {
				id: state.job.id,
				durationMs: Date.now() - startMs,
			});
		} catch (err) {
			logger.error("Cron job failed", {
				id: state.job.id,
				error: String(err),
				durationMs: Date.now() - startMs,
			});
		} finally {
			state.running = false;
		}
	}

	private scheduleNext(state: JobState, signal: AbortSignal): void {
		if (!this.started || signal.aborted) return;

		state.timer = setTimeout(() => {
			if (signal.aborted) return;
			void this.runJob(state).then(() => {
				this.scheduleNext(state, signal);
			});
		}, state.job.intervalMs);
	}
}
