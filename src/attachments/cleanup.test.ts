/**
 * Tests for UploadCleanup — covers:
 * - Removes date directories older than retention period
 * - Keeps recent date directories
 * - Handles missing upload directory
 * - Handles empty upload directory
 */

import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanOldUploads } from "./cleanup.js";

const TEST_DIR = join(import.meta.dirname ?? ".", ".test-cleanup");

beforeEach(async () => {
	await mkdir(TEST_DIR, { recursive: true });
});

afterEach(async () => {
	await rm(TEST_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Date directory cleanup
// ---------------------------------------------------------------------------

describe("cleanOldUploads", () => {
	it("removes directories older than retention days", async () => {
		// Create directories: today, 5 days ago, 10 days ago
		const today = formatDate(new Date());
		const fiveDaysAgo = formatDate(daysAgo(5));
		const tenDaysAgo = formatDate(daysAgo(10));

		await mkdir(join(TEST_DIR, today), { recursive: true });
		await mkdir(join(TEST_DIR, fiveDaysAgo), { recursive: true });
		await mkdir(join(TEST_DIR, tenDaysAgo), { recursive: true });

		// Add a file to each directory
		await writeFile(join(TEST_DIR, today, "file.txt"), "today");
		await writeFile(join(TEST_DIR, fiveDaysAgo, "file.txt"), "old");
		await writeFile(join(TEST_DIR, tenDaysAgo, "file.txt"), "older");

		// Retention: 7 days
		const removed = await cleanOldUploads(TEST_DIR, 7);

		// Only the 10-day-old directory should be removed
		expect(removed).toBe(1);
		const remaining = await readdir(TEST_DIR);
		expect(remaining).toContain(today);
		expect(remaining).toContain(fiveDaysAgo);
		expect(remaining).not.toContain(tenDaysAgo);
	});

	it("keeps all directories when none exceed retention", async () => {
		const today = formatDate(new Date());
		const yesterday = formatDate(daysAgo(1));

		await mkdir(join(TEST_DIR, today), { recursive: true });
		await mkdir(join(TEST_DIR, yesterday), { recursive: true });

		const removed = await cleanOldUploads(TEST_DIR, 7);

		expect(removed).toBe(0);
		const remaining = await readdir(TEST_DIR);
		expect(remaining.length).toBe(2);
	});

	it("removes all old directories when all exceed retention", async () => {
		const old1 = formatDate(daysAgo(30));
		const old2 = formatDate(daysAgo(60));

		await mkdir(join(TEST_DIR, old1), { recursive: true });
		await mkdir(join(TEST_DIR, old2), { recursive: true });
		await writeFile(join(TEST_DIR, old1, "a.txt"), "a");
		await writeFile(join(TEST_DIR, old2, "b.txt"), "b");

		const removed = await cleanOldUploads(TEST_DIR, 7);

		expect(removed).toBe(2);
		const remaining = await readdir(TEST_DIR);
		expect(remaining.length).toBe(0);
	});

	it("handles missing upload directory gracefully", async () => {
		const removed = await cleanOldUploads(join(TEST_DIR, "nonexistent"), 7);
		expect(removed).toBe(0);
	});

	it("handles empty upload directory", async () => {
		const removed = await cleanOldUploads(TEST_DIR, 7);
		expect(removed).toBe(0);
	});

	it("ignores non-date-formatted directories", async () => {
		await mkdir(join(TEST_DIR, "random-dir"), { recursive: true });
		await mkdir(join(TEST_DIR, "not-a-date"), { recursive: true });
		await mkdir(join(TEST_DIR, formatDate(daysAgo(30))), { recursive: true });

		const removed = await cleanOldUploads(TEST_DIR, 7);

		// Only the old date directory should be removed
		expect(removed).toBe(1);
		const remaining = await readdir(TEST_DIR);
		expect(remaining).toContain("random-dir");
		expect(remaining).toContain("not-a-date");
	});

	it("ignores files (non-directories) in the upload directory", async () => {
		await writeFile(join(TEST_DIR, "2020-01-01"), "not a directory");
		const removed = await cleanOldUploads(TEST_DIR, 7);
		expect(removed).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function daysAgo(n: number): Date {
	const d = new Date();
	d.setDate(d.getDate() - n);
	return d;
}

function formatDate(d: Date): string {
	return d.toISOString().slice(0, 10);
}
