/**
 * Tests for SessionManager — covers:
 * - Session key consistency (HIGH #3)
 * - Memory leak via activeSessions growing unbounded (HIGH #4)
 * - Timer cleanup (MEDIUM #7)
 * - Capacity enforcement
 * - Graceful shutdown
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionHandle } from "../executor/spawner.js";
import type { SessionDoneStatus } from "../executor/types.js";
import { SessionManager } from "./manager.js";
import type { SessionManagerConfig } from "./manager.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDonePromise(status: SessionDoneStatus = "completed"): {
	promise: Promise<SessionDoneStatus>;
	resolve: (s: SessionDoneStatus) => void;
} {
	let resolve!: (s: SessionDoneStatus) => void;
	const promise = new Promise<SessionDoneStatus>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

function makeHandle(overrides: Partial<SessionHandle> = {}): SessionHandle {
	const { promise, resolve } = makeDonePromise();
	return {
		sessionId: undefined,
		claudeSessionId: undefined,
		done: promise,
		activities: [],
		lastStderr: [],
		currentActivity: null,
		onText: vi.fn(),
		onResult: vi.fn(),
		kill: vi.fn(),
		forceKill: vi.fn(),
		writeStdin: vi.fn(),
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Module mock for spawnClaude so no real process is launched
// ---------------------------------------------------------------------------

vi.mock("../executor/spawner.js", () => ({
	spawnClaude: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Vitest fake timers
// ---------------------------------------------------------------------------

// We use real timers here to avoid complexity, but we mock spawnClaude.

async function makeManager(
	overrides: Partial<SessionManagerConfig> = {},
): Promise<{ manager: SessionManager; tmpDir: string }> {
	const { tmpdir } = await import("node:os");
	const { randomUUID } = await import("node:crypto");
	const { mkdir } = await import("node:fs/promises");
	const { join } = await import("node:path");
	const tmpDir = join(tmpdir(), `claude-pet-mgr-${randomUUID()}`);
	await mkdir(tmpDir, { recursive: true });
	const manager = new SessionManager({
		maxConcurrentSessions: 5,
		sessionTimeoutMs: 60_000,
		model: "claude-3",
		maxTurns: 5,
		storeDir: tmpDir,
		...overrides,
	});
	return { manager, tmpDir };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SessionManager.sessionKey", () => {
	it("produces userId:channelId format", () => {
		expect(SessionManager.sessionKey("u1", "c1")).toBe("u1:c1");
	});

	it("handles empty strings", () => {
		expect(SessionManager.sessionKey("", "")).toBe(":");
	});

	it("handles special characters in userId and channelId", () => {
		const key = SessionManager.sessionKey("user@domain", "chan/123");
		expect(key).toBe("user@domain:chan/123");
	});
});

describe("SessionManager.isActive / activeCount", () => {
	it("returns false for unknown key", async () => {
		const { manager } = await makeManager();
		expect(manager.isActive("u1:c1")).toBe(false);
	});

	it("starts with activeCount of 0", async () => {
		const { manager } = await makeManager();
		expect(manager.activeCount).toBe(0);
	});
});

describe("SessionManager.getOrCreate", () => {
	let manager: SessionManager;
	let spawnMock: ReturnType<typeof vi.fn>;
	let handles: Array<ReturnType<typeof makeHandle>>;
	let resolvers: Array<(s: SessionDoneStatus) => void>;

	beforeEach(async () => {
		const { spawnClaude } = await import("../executor/spawner.js");
		spawnMock = spawnClaude as ReturnType<typeof vi.fn>;
		spawnMock.mockReset();
		handles = [];
		resolvers = [];

		const result = await makeManager({ maxConcurrentSessions: 3 });
		manager = result.manager;

		// Each call to spawnClaude returns a new controllable handle
		spawnMock.mockImplementation(() => {
			const { promise, resolve } = makeDonePromise();
			resolvers.push(resolve);
			const h = makeHandle({ done: promise });
			handles.push(h);
			return h;
		});
	});

	it("returns a handle on first call", async () => {
		const handle = await manager.getOrCreate("u1", "c1", "hello");
		expect(handle).not.toBeNull();
	});

	it("increments activeCount after creating a session", async () => {
		await manager.getOrCreate("u1", "c1", "hello");
		expect(manager.activeCount).toBe(1);
	});

	it("decrements activeCount after session completes (no memory leak - HIGH #4)", async () => {
		await manager.getOrCreate("u1", "c1", "hello");
		expect(manager.activeCount).toBe(1);

		// Resolve the handle's done promise
		resolvers[0]!("completed");
		// Give the microtask queue a turn
		await new Promise((r) => setTimeout(r, 10));

		expect(manager.activeCount).toBe(0);
	});

	it("returns null when at capacity", async () => {
		// Fill to capacity
		for (let i = 0; i < 3; i++) {
			await manager.getOrCreate(`u${i}`, `c${i}`, "hello");
		}
		expect(manager.activeCount).toBe(3);

		const overCapacity = await manager.getOrCreate("uX", "cX", "overflow");
		expect(overCapacity).toBeNull();
	});

	it("frees capacity after sessions complete (no memory leak - HIGH #4)", async () => {
		for (let i = 0; i < 3; i++) {
			await manager.getOrCreate(`u${i}`, `c${i}`, "hello");
		}

		// Complete all sessions
		for (const resolve of resolvers) {
			resolve("completed");
		}
		await new Promise((r) => setTimeout(r, 20));

		expect(manager.activeCount).toBe(0);

		// Should be able to create a new session now
		const newHandle = await manager.getOrCreate("uNew", "cNew", "test");
		expect(newHandle).not.toBeNull();
	});

	it("invokes onText callback with session key and text", async () => {
		const receivedTexts: Array<{ key: string; text: string }> = [];
		manager.onText((key, text) => receivedTexts.push({ key, text }));

		await manager.getOrCreate("u1", "c1", "hello");

		// Trigger the onText callback registered on the handle
		const textCb = (handles[0]!.onText as ReturnType<typeof vi.fn>).mock
			.calls[0][0] as (text: string) => void;
		textCb("test response");

		expect(receivedTexts).toHaveLength(1);
		expect(receivedTexts[0]!.text).toBe("test response");
	});

	it("invokes onDone callback when session ends", async () => {
		const doneEvents: Array<{ key: string; status: SessionDoneStatus }> = [];
		manager.onDone((key, status) => doneEvents.push({ key, status }));

		await manager.getOrCreate("u1", "c1", "hello");
		resolvers[0]!("completed");
		await new Promise((r) => setTimeout(r, 20));

		expect(doneEvents).toHaveLength(1);
		expect(doneEvents[0]!.status).toBe("completed");
	});
});

describe("SessionManager.shutdown", () => {
	it("kills all active sessions and clears the map", async () => {
		const { spawnClaude } = await import("../executor/spawner.js");
		const spawnMock = spawnClaude as ReturnType<typeof vi.fn>;
		spawnMock.mockReset();

		const { promise: done1, resolve: resolve1 } = makeDonePromise();
		const { promise: done2, resolve: resolve2 } = makeDonePromise();
		const h1 = makeHandle({ done: done1 });
		const h2 = makeHandle({ done: done2 });

		let callCount = 0;
		spawnMock.mockImplementation(() => {
			callCount++;
			return callCount === 1 ? h1 : h2;
		});

		const { manager } = await makeManager();

		await manager.getOrCreate("u1", "c1", "a");
		await manager.getOrCreate("u2", "c2", "b");

		// Resolve both immediately on shutdown
		const shutdownPromise = manager.shutdown();
		resolve1("completed");
		resolve2("completed");
		await shutdownPromise;

		expect(manager.activeCount).toBe(0);
		expect(h1.kill).toHaveBeenCalled();
		expect(h2.kill).toHaveBeenCalled();
	});
});

describe("SessionManager timer cleanup (MEDIUM #7)", () => {
	it("clears timeout timer when session completes before timeout", async () => {
		vi.useFakeTimers();

		const { spawnClaude } = await import("../executor/spawner.js");
		const spawnMock = spawnClaude as ReturnType<typeof vi.fn>;
		spawnMock.mockReset();

		const { promise, resolve } = makeDonePromise();
		const h = makeHandle({ done: promise });
		spawnMock.mockReturnValue(h);

		const { manager } = await makeManager({ sessionTimeoutMs: 5_000 });
		await manager.getOrCreate("u1", "c1", "hello");

		// Complete before timeout
		resolve("completed");
		// Flush microtasks (promise callbacks)
		await Promise.resolve();
		await Promise.resolve();

		// Advance past the timeout — kill should NOT be called (timer was cleared)
		vi.advanceTimersByTime(10_000);
		await Promise.resolve();

		expect(h.kill).not.toHaveBeenCalled();

		vi.useRealTimers();
	});

	it("calls kill when session times out", async () => {
		vi.useFakeTimers();

		const { spawnClaude } = await import("../executor/spawner.js");
		const spawnMock = spawnClaude as ReturnType<typeof vi.fn>;
		spawnMock.mockReset();

		const { promise } = makeDonePromise(); // never resolves
		const h = makeHandle({ done: promise });
		spawnMock.mockReturnValue(h);

		const { manager } = await makeManager({ sessionTimeoutMs: 1_000 });
		await manager.getOrCreate("u1", "c1", "hello");

		vi.advanceTimersByTime(1_500);
		await Promise.resolve();

		expect(h.kill).toHaveBeenCalled();

		vi.useRealTimers();
	});
});

describe("SessionManager.getActiveSessionKeys", () => {
	it("returns empty array when no sessions", async () => {
		const { manager } = await makeManager();
		expect(manager.getActiveSessionKeys()).toEqual([]);
	});

	it("returns keys for all active sessions (HIGH #3: key format check)", async () => {
		const { spawnClaude } = await import("../executor/spawner.js");
		const spawnMock = spawnClaude as ReturnType<typeof vi.fn>;
		spawnMock.mockReset();

		const { promise } = makeDonePromise();
		spawnMock.mockReturnValue(makeHandle({ done: promise }));

		const { manager } = await makeManager();
		await manager.getOrCreate("user1", "channel1", "hello");

		const keys = manager.getActiveSessionKeys();
		expect(keys).toHaveLength(1);
		// The session key stored in activeSessions must contain the base userId:channelId portion
		// HIGH #3: verify the key used for activeSessions matches what's used for the store
		expect(keys[0]).toContain("user1");
		expect(keys[0]).toContain("channel1");
	});
});
