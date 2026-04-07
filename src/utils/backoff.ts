import { sleep } from "./sleep.js";

export type BackoffConfig = {
	/** Initial delay in ms. Default: 1000 */
	initialMs: number;
	/** Maximum delay cap in ms. Default: 60000 */
	capMs: number;
	/** Give up after this many ms of cumulative errors. Default: 600000 (10min) */
	giveUpMs: number;
};

export const DEFAULT_BACKOFF: BackoffConfig = {
	initialMs: 1_000,
	capMs: 60_000,
	giveUpMs: 600_000,
};

export class ExponentialBackoff {
	private currentMs: number;
	private errorStartTime: number | null = null;

	constructor(private readonly config: BackoffConfig = DEFAULT_BACKOFF) {
		this.currentMs = config.initialMs;
	}

	/**
	 * Wait with exponential backoff + jitter.
	 * Returns false if giveUp threshold exceeded or signal aborted.
	 */
	async wait(signal?: AbortSignal): Promise<boolean> {
		const now = Date.now();

		if (this.errorStartTime === null) {
			this.errorStartTime = now;
		}

		if (now - this.errorStartTime > this.config.giveUpMs) {
			return false;
		}

		// Add jitter: ±25% of current delay
		const jitter = this.currentMs * 0.25 * (Math.random() * 2 - 1);
		const delayMs = Math.max(0, this.currentMs + jitter);

		const slept = await sleep(delayMs, signal);
		if (!slept) return false;

		// Double for next time, capped
		this.currentMs = Math.min(this.currentMs * 2, this.config.capMs);
		return true;
	}

	/** Reset after a successful operation. */
	reset(): void {
		this.currentMs = this.config.initialMs;
		this.errorStartTime = null;
	}

	/** Detect system sleep/wake: elapsed >> expected means we were suspended. */
	static isSleepWake(elapsedMs: number, expectedMs: number): boolean {
		return elapsedMs > expectedMs * 2;
	}
}
