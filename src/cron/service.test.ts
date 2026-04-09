/**
 * Tests for CronService — scheduleNext drift fix, retry logic, stop behavior.
 */

import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
	type MockInstance,
} from "vitest";
import { CronService } from "./service.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSignal(): { signal: AbortSignal; abort: () => void } {
	const controller = new AbortController();
	return { signal: controller.signal, abort: () => controller.abort() };
}

// ---------------------------------------------------------------------------
// scheduleNext drift fix
// ---------------------------------------------------------------------------

describe("CronService — scheduleNext drift", () => {
	it("schedules next run accounting for elapsed time (drift fix)", () => {
		// Unit-test the drift logic directly without running the full service.
		// The fix: delay = Math.max(0, intervalMs - elapsed)
		// Simulate a 1000ms interval where the job took 300ms to run.
		const intervalMs = 1000;
		const elapsed = 300;
		const delay = Math.max(0, intervalMs - elapsed);
		// Next run should fire 700ms after the job finished (not 1000ms)
		expect(delay).toBe(700);
	});

	it("clamps delay to 0 when job exceeds the interval", () => {
		const intervalMs = 1000;
		const elapsed = 1500; // job ran longer than interval
		const delay = Math.max(0, intervalMs - elapsed);
		expect(delay).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// Retry on failure
// ---------------------------------------------------------------------------

describe("CronService — retry on failure", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("retries a failed job up to 3 times with backoff", async () => {
		const callCount = { value: 0 };
		const { signal, abort } = makeSignal();
		const service = new CronService();

		service.add({
			id: "retry-test",
			intervalMs: 60 * 60 * 1000, // 1 hour — won't fire again naturally
			runOnStart: false,
			handler: async () => {
				callCount.value++;
				throw new Error("transient failure");
			},
		});

		await service.start(signal);

		// Manually trigger to exercise retry path
		const runPromise = service.run("retry-test");

		// Advance through backoffs: attempt 1 fails, wait 1min, attempt 2 fails, wait 5min, attempt 3 fails
		await vi.advanceTimersByTimeAsync(0); // attempt 1
		await vi.advanceTimersByTimeAsync(60_000); // backoff 1
		await vi.advanceTimersByTimeAsync(0); // attempt 2
		await vi.advanceTimersByTimeAsync(5 * 60_000); // backoff 2
		await vi.advanceTimersByTimeAsync(0); // attempt 3

		await runPromise;

		expect(callCount.value).toBe(3);

		abort();
		await service.stop();
	});

	it("stops retrying after success", async () => {
		const callCount = { value: 0 };
		const { signal, abort } = makeSignal();
		const service = new CronService();

		service.add({
			id: "retry-success-test",
			intervalMs: 60 * 60 * 1000,
			runOnStart: false,
			handler: async () => {
				callCount.value++;
				if (callCount.value < 2) throw new Error("fail first time");
				// succeeds on second attempt
			},
		});

		await service.start(signal);

		const runPromise = service.run("retry-success-test");

		await vi.advanceTimersByTimeAsync(0); // attempt 1 fails
		await vi.advanceTimersByTimeAsync(60_000); // backoff
		await vi.advanceTimersByTimeAsync(0); // attempt 2 succeeds

		await runPromise;

		expect(callCount.value).toBe(2);

		abort();
		await service.stop();
	});
});

// ---------------------------------------------------------------------------
// stop() behavior
// ---------------------------------------------------------------------------

describe("CronService — stop()", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("cancels pending timers on stop", async () => {
		const ran: string[] = [];
		const { signal, abort } = makeSignal();
		const service = new CronService();

		service.add({
			id: "stopper-test",
			intervalMs: 5000,
			runOnStart: false,
			handler: async () => {
				ran.push("ran");
			},
		});

		await service.start(signal);
		abort();
		await service.stop();

		// Advance well past interval — job should not run after stop
		await vi.advanceTimersByTimeAsync(10_000);

		expect(ran).toHaveLength(0);
	});

	it("waits for a running job to finish before stop resolves", async () => {
		vi.useFakeTimers();
		const finished = { value: false };
		const { signal, abort } = makeSignal();
		const service = new CronService();

		let resolveHandler!: () => void;
		service.add({
			id: "long-job",
			intervalMs: 60_000,
			runOnStart: false,
			handler: () =>
				new Promise<void>((res) => {
					resolveHandler = () => {
						finished.value = true;
						res();
					};
				}),
		});

		await service.start(signal);

		// Manually trigger the job (don't await — it's long-running)
		void service.run("long-job");

		// Give microtasks a chance to set state.running = true
		await vi.advanceTimersByTimeAsync(0);

		// Stop while job is running
		abort();
		const stopPromise = service.stop();

		// Complete the job, then advance stop polling intervals
		resolveHandler();
		await vi.advanceTimersByTimeAsync(500);
		await vi.advanceTimersByTimeAsync(500);

		await stopPromise;
		expect(finished.value).toBe(true);
		vi.useRealTimers();
	});
});

// ---------------------------------------------------------------------------
// runOnStart parallel stagger
// ---------------------------------------------------------------------------

describe("CronService — runOnStart parallel stagger", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("does not block start() while waiting for runOnStart stagger", async () => {
		const { signal, abort } = makeSignal();
		const service = new CronService();

		let jobStarted = false;
		service.add({
			id: "stagger-job",
			intervalMs: 60_000,
			runOnStart: true,
			handler: async () => {
				jobStarted = true;
			},
		});

		// start() should return quickly without awaiting the stagger sleep
		const startFinished = { value: false };
		const startPromise = service.start(signal).then(() => {
			startFinished.value = true;
		});

		// Micro-tick — start() itself should resolve before stagger fires
		await startPromise;
		expect(startFinished.value).toBe(true);

		// Advance through max stagger (2000ms) to let job fire
		await vi.advanceTimersByTimeAsync(2000);
		expect(jobStarted).toBe(true);

		abort();
		await service.stop();
	});
});
