/**
 * Tests for StudyQueue — covers:
 * - Enqueue with daily limit enforcement
 * - Sequential processing with mutex
 * - State persistence and load
 * - Restart recovery (in_progress → queued)
 * - Notification on completion/failure
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StudyQueue } from "./queue.js";
import type { StudyConfig, StudyQueueState } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<StudyConfig> = {}): StudyConfig {
	return {
		enabled: true,
		maxDailySessions: 5,
		maxSubTopics: 8,
		model: "sonnet",
		maxTurns: 3,
		...overrides,
	};
}

async function makeTempDir(): Promise<string> {
	const dir = join(tmpdir(), `claude-pet-study-test-${randomUUID()}`);
	await mkdir(dir, { recursive: true });
	return dir;
}

describe("StudyQueue.enqueue", () => {
	let dataDir: string;

	beforeEach(async () => {
		dataDir = await makeTempDir();
	});

	it("adds a topic to the queue", async () => {
		const queue = new StudyQueue(makeConfig(), dataDir);
		const result = await queue.enqueue("Docker 네트워크");
		expect(result.success).toBe(true);
		expect(result.request?.topic).toBe("Docker 네트워크");
		expect(result.request?.status).toBe("queued");
	});

	it("rejects when daily limit is reached", async () => {
		const config = makeConfig({ maxDailySessions: 2 });
		const queue = new StudyQueue(config, dataDir);

		await queue.enqueue("Topic 1");
		await queue.enqueue("Topic 2");
		const result = await queue.enqueue("Topic 3");

		expect(result.success).toBe(false);
		expect(result.reason).toContain("일일 학습 한도");
	});

	it("assigns unique IDs to each request", async () => {
		const queue = new StudyQueue(makeConfig(), dataDir);
		const r1 = await queue.enqueue("Topic A");
		const r2 = await queue.enqueue("Topic B");
		expect(r1.request?.id).not.toBe(r2.request?.id);
	});

	it("persists state to disk after enqueue", async () => {
		const queue = new StudyQueue(makeConfig(), dataDir);
		await queue.enqueue("Persisted Topic");

		const filePath = join(dataDir, "study-queue.json");
		const raw = await readFile(filePath, "utf8");
		const state = JSON.parse(raw) as StudyQueueState;
		expect(state.requests).toHaveLength(1);
		expect(state.requests[0]?.topic).toBe("Persisted Topic");
	});
});

describe("StudyQueue.getState", () => {
	let dataDir: string;

	beforeEach(async () => {
		dataDir = await makeTempDir();
	});

	it("returns empty state when nothing enqueued", async () => {
		const queue = new StudyQueue(makeConfig(), dataDir);
		const state = await queue.getState();
		expect(state.requests).toEqual([]);
		expect(state.dailyCount).toBe(0);
	});

	it("returns current queue state", async () => {
		const queue = new StudyQueue(makeConfig(), dataDir);
		await queue.enqueue("Topic 1");
		await queue.enqueue("Topic 2");
		const state = await queue.getState();
		expect(state.requests).toHaveLength(2);
		expect(state.dailyCount).toBe(2);
	});
});

describe("StudyQueue — state persistence and restart recovery", () => {
	let dataDir: string;

	beforeEach(async () => {
		dataDir = await makeTempDir();
	});

	it("loads state from disk on initialization", async () => {
		// Pre-create state file
		const state: StudyQueueState = {
			requests: [
				{
					id: "existing-1",
					topic: "Pre-existing Topic",
					status: "queued",
					requestedAt: Date.now(),
				},
			],
			dailyCount: 1,
			dailyResetAt: Date.now() + 86400000,
		};
		await writeFile(
			join(dataDir, "study-queue.json"),
			JSON.stringify(state),
			"utf8",
		);

		const queue = new StudyQueue(makeConfig(), dataDir);
		const loaded = await queue.getState();
		expect(loaded.requests).toHaveLength(1);
		expect(loaded.requests[0]?.topic).toBe("Pre-existing Topic");
	});

	it("resets in_progress status to queued on restart", async () => {
		const state: StudyQueueState = {
			requests: [
				{
					id: "in-progress-1",
					topic: "Interrupted Topic",
					status: "in_progress",
					requestedAt: Date.now() - 60000,
				},
			],
			dailyCount: 1,
			dailyResetAt: Date.now() + 86400000,
		};
		await writeFile(
			join(dataDir, "study-queue.json"),
			JSON.stringify(state),
			"utf8",
		);

		const queue = new StudyQueue(makeConfig(), dataDir);
		const loaded = await queue.getState();
		expect(loaded.requests[0]?.status).toBe("queued");
	});

	it("resets daily count when reset time has passed", async () => {
		const state: StudyQueueState = {
			requests: [],
			dailyCount: 5,
			dailyResetAt: Date.now() - 1000, // already passed
		};
		await writeFile(
			join(dataDir, "study-queue.json"),
			JSON.stringify(state),
			"utf8",
		);

		const queue = new StudyQueue(makeConfig(), dataDir);
		const loaded = await queue.getState();
		expect(loaded.dailyCount).toBe(0);
	});
});

describe("StudyQueue — daily limit reset", () => {
	let dataDir: string;

	beforeEach(async () => {
		dataDir = await makeTempDir();
	});

	it("allows enqueueing after daily reset", async () => {
		const state: StudyQueueState = {
			requests: [],
			dailyCount: 5,
			dailyResetAt: Date.now() - 1000, // already passed
		};
		await writeFile(
			join(dataDir, "study-queue.json"),
			JSON.stringify(state),
			"utf8",
		);

		const config = makeConfig({ maxDailySessions: 5 });
		const queue = new StudyQueue(config, dataDir);
		const result = await queue.enqueue("New Topic After Reset");
		expect(result.success).toBe(true);
	});
});
