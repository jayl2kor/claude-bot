import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ModelStatsTracker } from "./stats.js";

let testDir: string;

beforeEach(async () => {
	testDir = join(tmpdir(), `model-stats-test-${randomUUID()}`);
	await mkdir(testDir, { recursive: true });
});

afterEach(async () => {
	await rm(testDir, { recursive: true, force: true });
});

describe("ModelStatsTracker - record and retrieve", () => {
	it("records a haiku usage", async () => {
		const tracker = new ModelStatsTracker(testDir);
		await tracker.record("haiku");
		const stats = await tracker.getDailyStats();
		expect(stats).not.toBeNull();
		expect(stats?.haiku.count).toBe(1);
		expect(stats?.sonnet.count).toBe(0);
		expect(stats?.opus.count).toBe(0);
	});

	it("aggregates multiple records", async () => {
		const tracker = new ModelStatsTracker(testDir);
		await tracker.record("haiku");
		await tracker.record("haiku");
		await tracker.record("sonnet");
		await tracker.record("opus");
		await tracker.record("opus");
		await tracker.record("opus");
		const stats = await tracker.getDailyStats();
		expect(stats?.haiku.count).toBe(2);
		expect(stats?.sonnet.count).toBe(1);
		expect(stats?.opus.count).toBe(3);
	});

	it("returns null for missing date", async () => {
		const tracker = new ModelStatsTracker(testDir);
		expect(await tracker.getDailyStats("2020-01-01")).toBeNull();
	});

	it("tracks override count", async () => {
		const tracker = new ModelStatsTracker(testDir);
		await tracker.record("opus", true);
		await tracker.record("haiku");
		await tracker.record("sonnet", true);
		const stats = await tracker.getDailyStats();
		expect(stats?.overrideCount).toBe(2);
	});
});

describe("ModelStatsTracker - session cache", () => {
	it("returns undefined for unknown key", () => {
		const tracker = new ModelStatsTracker(testDir);
		expect(tracker.getSessionModel("unknown")).toBeUndefined();
	});

	it("stores and retrieves model", () => {
		const tracker = new ModelStatsTracker(testDir);
		const now = Date.now();
		tracker.setSessionModel("u1:c1", "opus", now);
		expect(tracker.getSessionModel("u1:c1")).toEqual({
			model: "opus",
			timestamp: now,
		});
	});

	it("overwrites model", () => {
		const tracker = new ModelStatsTracker(testDir);
		const now = Date.now();
		tracker.setSessionModel("u1:c1", "opus", now);
		tracker.setSessionModel("u1:c1", "haiku", now + 1000);
		expect(tracker.getSessionModel("u1:c1")).toEqual({
			model: "haiku",
			timestamp: now + 1000,
		});
	});
});

describe("ModelStatsTracker - persistence", () => {
	it("persists across instances", async () => {
		const t1 = new ModelStatsTracker(testDir);
		await t1.record("haiku");
		await t1.record("haiku");
		await t1.record("opus");
		const t2 = new ModelStatsTracker(testDir);
		const stats = await t2.getDailyStats();
		expect(stats?.haiku.count).toBe(2);
		expect(stats?.opus.count).toBe(1);
	});
});
