/**
 * Tests for cron jobs:
 * - skipPermissions is passed through to spawnClaude
 * - runMemoryReflection saves parsed results to the knowledge store
 */

import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionHandle } from "../executor/spawner.js";
import { KnowledgeManager } from "../memory/knowledge.js";
import { ReflectionManager } from "../memory/reflection.js";
import { RelationshipManager } from "../memory/relationships.js";

// ---------------------------------------------------------------------------
// Mock spawnClaude so tests don't spawn real processes
// ---------------------------------------------------------------------------

const mockSpawnClaude = vi.fn();
vi.mock("../executor/spawner.js", () => ({
	spawnClaude: (...args: unknown[]) => mockSpawnClaude(...args),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(): string {
	return join(tmpdir(), `cron-jobs-test-${randomUUID()}`);
}

function makeHandle(resultText: string): SessionHandle {
	const resultCallbacks: Array<(r: { text: string; isError: boolean }) => void> =
		[];
	return {
		sessionId: undefined,
		claudeSessionId: undefined,
		done: Promise.resolve("completed" as const),
		activities: [],
		lastStderr: [],
		currentActivity: null,
		onText: vi.fn(),
		onResult: (cb) => {
			resultCallbacks.push(cb);
			// Immediately call with result
			cb({ text: resultText, isError: false });
		},
		kill: vi.fn(),
		forceKill: vi.fn(),
		writeStdin: vi.fn(),
	} as unknown as SessionHandle;
}

// ---------------------------------------------------------------------------
// Minimal deps factory
// ---------------------------------------------------------------------------

async function makeMinimalDeps(overrides: Partial<{
	resultText: string;
	skipPermissions: boolean;
}> = {}) {
	const resultText =
		overrides.resultText ??
		JSON.stringify({
			commonThemes: ["theme-A", "theme-B"],
			patterns: ["pattern-X"],
			growth: "became more empathetic",
		});

	const handle = makeHandle(resultText);
	mockSpawnClaude.mockReturnValue(handle);

	const knowledgeDir = makeTempDir();
	const archiveDir = join(knowledgeDir, "..", "archive-knowledge");
	await mkdir(knowledgeDir, { recursive: true });
	const knowledge = new KnowledgeManager(knowledgeDir, archiveDir);

	const reflectionsDir = makeTempDir();
	await mkdir(reflectionsDir, { recursive: true });
	const reflections = new ReflectionManager(reflectionsDir);

	const relationshipsDir = makeTempDir();
	await mkdir(relationshipsDir, { recursive: true });
	const relationships = new RelationshipManager(relationshipsDir);

	// Seed some reflections so the handler doesn't bail out early
	for (let i = 0; i < 4; i++) {
		await reflections.save({
			id: randomUUID(),
			sessionKey: `sess-${i}`,
			userId: "user1",
			summary: `summary ${i}`,
			insights: [],
			createdAt: Date.now() - i * 1000,
		});
	}

	return {
		petId: "test-pet",
		persona: { updateSoul: vi.fn() } as never,
		knowledge,
		reflections,
		relationships,
		sessionStore: { list: vi.fn().mockResolvedValue([]) } as never,
		activityTracker: { listActiveUsers: vi.fn().mockResolvedValue([]) } as never,
		history: { listChannels: vi.fn().mockResolvedValue([]) } as never,
		plugins: [],
		skipPermissions: overrides.skipPermissions ?? true,
	};
}

// ---------------------------------------------------------------------------
// Tests: skipPermissions is passed through
// ---------------------------------------------------------------------------

describe("runMemoryReflection — skipPermissions", () => {
	beforeEach(() => {
		mockSpawnClaude.mockClear();
	});

	it("passes skipPermissions: true to spawnClaude when deps.skipPermissions is true", async () => {
		const deps = await makeMinimalDeps({ skipPermissions: true });

		// Import after mock is set up
		const { createBuiltinJobs } = await import("./jobs.js");
		const jobs = createBuiltinJobs(deps);
		const reflectionJob = jobs.find((j) => j.id === "memory-reflection");
		expect(reflectionJob).toBeDefined();

		await reflectionJob!.handler();

		expect(mockSpawnClaude).toHaveBeenCalledWith(
			expect.objectContaining({ skipPermissions: true }),
		);
	});

	it("passes skipPermissions: false to spawnClaude when deps.skipPermissions is false", async () => {
		const deps = await makeMinimalDeps({ skipPermissions: false });

		const { createBuiltinJobs } = await import("./jobs.js");
		const jobs = createBuiltinJobs(deps);
		const reflectionJob = jobs.find((j) => j.id === "memory-reflection");
		expect(reflectionJob).toBeDefined();

		await reflectionJob!.handler();

		expect(mockSpawnClaude).toHaveBeenCalledWith(
			expect.objectContaining({ skipPermissions: false }),
		);
	});
});

// ---------------------------------------------------------------------------
// Tests: runMemoryReflection saves results to knowledge store
// ---------------------------------------------------------------------------

describe("runMemoryReflection — saves results to knowledge store", () => {
	beforeEach(() => {
		mockSpawnClaude.mockClear();
	});

	it("saves commonThemes, patterns, and growth as knowledge items", async () => {
		const deps = await makeMinimalDeps({
			resultText: JSON.stringify({
				commonThemes: ["programming", "relationships"],
				patterns: ["asks many questions"],
				growth: "more confident in code reviews",
			}),
		});

		const { createBuiltinJobs } = await import("./jobs.js");
		const jobs = createBuiltinJobs(deps);
		const reflectionJob = jobs.find((j) => j.id === "memory-reflection");
		await reflectionJob!.handler();

		const all = await deps.knowledge.listAll();
		expect(all.length).toBeGreaterThanOrEqual(4); // 2 themes + 1 pattern + 1 growth

		const topics = all.map((k) => k.topic);
		expect(topics).toContain("common-theme");
		expect(topics).toContain("conversation-pattern");
		expect(topics).toContain("growth-point");

		const contents = all.map((k) => k.content);
		expect(contents).toContain("programming");
		expect(contents).toContain("relationships");
		expect(contents).toContain("asks many questions");
		expect(contents).toContain("more confident in code reviews");
	});

	it("saves items with source: inferred and tag memory-reflection", async () => {
		const deps = await makeMinimalDeps({
			resultText: JSON.stringify({
				commonThemes: ["topic-X"],
				patterns: [],
				growth: "",
			}),
		});

		const { createBuiltinJobs } = await import("./jobs.js");
		const jobs = createBuiltinJobs(deps);
		const reflectionJob = jobs.find((j) => j.id === "memory-reflection");
		await reflectionJob!.handler();

		const all = await deps.knowledge.listAll();
		const themeEntry = all.find((k) => k.content === "topic-X");
		expect(themeEntry).toBeDefined();
		expect(themeEntry?.source).toBe("inferred");
		expect(themeEntry?.tags).toContain("memory-reflection");
	});

	it("does not crash on malformed JSON from Claude", async () => {
		const deps = await makeMinimalDeps({
			resultText: "not json at all",
		});

		const { createBuiltinJobs } = await import("./jobs.js");
		const jobs = createBuiltinJobs(deps);
		const reflectionJob = jobs.find((j) => j.id === "memory-reflection");

		// Should not throw
		await expect(reflectionJob!.handler()).resolves.toBeUndefined();

		// No knowledge items saved
		const all = await deps.knowledge.listAll();
		expect(all).toHaveLength(0);
	});

	it("skips saving when there are fewer than 3 reflections", async () => {
		const deps = await makeMinimalDeps();

		// Clear reflections and add only 2
		const reflectionsDir = makeTempDir();
		await mkdir(reflectionsDir, { recursive: true });
		const thinReflections = new ReflectionManager(reflectionsDir);
		for (let i = 0; i < 2; i++) {
			await thinReflections.save({
				id: randomUUID(),
				sessionKey: `sess-${i}`,
				userId: "user1",
				summary: `summary ${i}`,
				insights: [],
				createdAt: Date.now() - i * 1000,
			});
		}
		deps.reflections = thinReflections;

		const { createBuiltinJobs } = await import("./jobs.js");
		const jobs = createBuiltinJobs(deps);
		const reflectionJob = jobs.find((j) => j.id === "memory-reflection");
		await reflectionJob!.handler();

		// spawnClaude should NOT have been called
		expect(mockSpawnClaude).not.toHaveBeenCalled();

		const all = await deps.knowledge.listAll();
		expect(all).toHaveLength(0);
	});
});
