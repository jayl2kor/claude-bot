/**
 * Tests for EvaluationStore — covers create, listPending, saveResult, cleanup.
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EvaluationStore, type EvaluationResult } from "./store.js";
import type { EvaluationRequest } from "./types.js";

function makeTempDir(): string {
	return join(tmpdir(), `eval-store-test-${randomUUID()}`);
}

function makeRequest(overrides: Partial<EvaluationRequest> = {}): EvaluationRequest {
	const now = Date.now();
	return {
		id: randomUUID(),
		petId: "pet-a",
		channelId: "ch-1",
		userId: "user-1",
		promptSummary: "사용자: 안녕하세요",
		responseSummary: "봇: 안녕하세요!",
		timestamp: now,
		status: "pending",
		feedback: null,
		expiresAt: now + 24 * 60 * 60 * 1000,
		...overrides,
	};
}

function makeResult(id: string, overrides: Partial<EvaluationResult> = {}): EvaluationResult {
	return {
		id,
		evaluatorId: "pet-b",
		score: 8,
		feedback: "좋은 응답입니다",
		strengths: ["친절함"],
		improvements: ["더 자세히"],
		evaluatedAt: Date.now(),
		...overrides,
	};
}

describe("EvaluationStore", () => {
	let storeDir: string;
	let store: EvaluationStore;

	beforeEach(async () => {
		storeDir = makeTempDir();
		await mkdir(storeDir, { recursive: true });
		store = new EvaluationStore(storeDir);
	});

	// -------------------------------------------------------------------------
	// create / readRequest
	// -------------------------------------------------------------------------

	describe("create", () => {
		it("saves a request and reads it back", async () => {
			const req = makeRequest();
			await store.create(req);
			const read = await store.readRequest(req.id);
			expect(read).toEqual(req);
		});

		it("returns null for a non-existent id", async () => {
			const result = await store.readRequest("does-not-exist");
			expect(result).toBeNull();
		});

		it("creates the directory if it does not exist", async () => {
			const nestedStore = new EvaluationStore(join(storeDir, "nested", "dir"));
			const req = makeRequest();
			await expect(nestedStore.create(req)).resolves.not.toThrow();
			const read = await nestedStore.readRequest(req.id);
			expect(read).toEqual(req);
		});
	});

	// -------------------------------------------------------------------------
	// saveResult / readResult
	// -------------------------------------------------------------------------

	describe("saveResult", () => {
		it("saves a result and reads it back", async () => {
			const req = makeRequest();
			await store.create(req);
			const result = makeResult(req.id);
			await store.saveResult(result);
			const read = await store.readResult(req.id);
			expect(read).toEqual(result);
		});

		it("returns null when result file does not exist", async () => {
			const result = await store.readResult("no-result");
			expect(result).toBeNull();
		});
	});

	// -------------------------------------------------------------------------
	// listPending
	// -------------------------------------------------------------------------

	describe("listPending", () => {
		it("returns empty array when no requests exist", async () => {
			const pending = await store.listPending("pet-b");
			expect(pending).toEqual([]);
		});

		it("returns requests not created by evaluatorId", async () => {
			const req = makeRequest({ petId: "pet-a" });
			await store.create(req);
			const pending = await store.listPending("pet-b");
			expect(pending).toHaveLength(1);
			expect(pending[0]!.id).toBe(req.id);
		});

		it("excludes requests created by evaluatorId (no self-evaluation)", async () => {
			const req = makeRequest({ petId: "pet-b" });
			await store.create(req);
			const pending = await store.listPending("pet-b");
			expect(pending).toHaveLength(0);
		});

		it("excludes requests that already have a result", async () => {
			const req = makeRequest({ petId: "pet-a" });
			await store.create(req);
			await store.saveResult(makeResult(req.id));
			const pending = await store.listPending("pet-b");
			expect(pending).toHaveLength(0);
		});

		it("excludes expired requests", async () => {
			const req = makeRequest({
				petId: "pet-a",
				expiresAt: Date.now() - 1000, // already expired
			});
			await store.create(req);
			const pending = await store.listPending("pet-b");
			expect(pending).toHaveLength(0);
		});

		it("returns multiple pending requests from different pets", async () => {
			const req1 = makeRequest({ petId: "pet-a" });
			const req2 = makeRequest({ petId: "pet-c" });
			await store.create(req1);
			await store.create(req2);
			const pending = await store.listPending("pet-b");
			expect(pending).toHaveLength(2);
		});
	});

	// -------------------------------------------------------------------------
	// cleanup
	// -------------------------------------------------------------------------

	describe("cleanup", () => {
		it("removes expired request and result files", async () => {
			const req = makeRequest({
				petId: "pet-a",
				expiresAt: Date.now() - 1000,
			});
			await store.create(req);
			await store.saveResult(makeResult(req.id));

			await store.cleanup();

			expect(await store.readRequest(req.id)).toBeNull();
			expect(await store.readResult(req.id)).toBeNull();
		});

		it("keeps non-expired requests", async () => {
			const req = makeRequest({ petId: "pet-a" }); // expires in 24h
			await store.create(req);

			await store.cleanup();

			expect(await store.readRequest(req.id)).not.toBeNull();
		});

		it("does not throw when directory is empty", async () => {
			await expect(store.cleanup()).resolves.not.toThrow();
		});

		it("does not throw when directory does not exist", async () => {
			const ghostStore = new EvaluationStore(join(storeDir, "ghost"));
			await expect(ghostStore.cleanup()).resolves.not.toThrow();
		});
	});

	// -------------------------------------------------------------------------
	// countPending
	// -------------------------------------------------------------------------

	describe("countPending", () => {
		it("returns 0 when no requests exist", async () => {
			expect(await store.countPending("pet-a")).toBe(0);
		});

		it("counts only requests by the given petId without a result", async () => {
			const req1 = makeRequest({ petId: "pet-a" });
			const req2 = makeRequest({ petId: "pet-a" });
			const req3 = makeRequest({ petId: "pet-b" }); // different pet
			await store.create(req1);
			await store.create(req2);
			await store.create(req3);
			expect(await store.countPending("pet-a")).toBe(2);
		});

		it("does not count evaluated requests", async () => {
			const req = makeRequest({ petId: "pet-a" });
			await store.create(req);
			await store.saveResult(makeResult(req.id));
			expect(await store.countPending("pet-a")).toBe(0);
		});

		it("does not count expired requests", async () => {
			const req = makeRequest({ petId: "pet-a", expiresAt: Date.now() - 1 });
			await store.create(req);
			expect(await store.countPending("pet-a")).toBe(0);
		});
	});
});
