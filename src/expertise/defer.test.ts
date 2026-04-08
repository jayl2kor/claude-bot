/**
 * Tests for DelegationBuilder — covers:
 * - Building delegation prompt from deferTo mapping
 * - Online/offline target pet status
 * - Empty deferTo returns null
 * - Token budget
 */

import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { StatusReader } from "../status/reader.js";
import type { PetStatus } from "../status/types.js";
import { DelegationBuilder } from "./defer.js";

function makeStatusReader(others: PetStatus[] = []): StatusReader {
	return {
		readOthers: async () => others,
		toPromptSection: async () => null,
	} as unknown as StatusReader;
}

function makePetStatus(overrides: Partial<PetStatus> = {}): PetStatus {
	return {
		petId: "reboong",
		personaName: "리붕이",
		activeSessionCount: 1,
		sessions: [],
		heartbeatAt: Date.now(),
		startedAt: Date.now() - 60000,
		...overrides,
	};
}

describe("DelegationBuilder", () => {
	it("returns null when deferTo is empty", async () => {
		const builder = new DelegationBuilder({}, undefined);
		const section = await builder.toPromptSection();
		expect(section).toBeNull();
	});

	it("builds delegation section with deferTo entries", async () => {
		const deferTo = { frontend: "리붕이", devops: "꼬붕이" };
		const builder = new DelegationBuilder(deferTo, undefined);
		const section = await builder.toPromptSection();
		expect(section).not.toBeNull();
		expect(section).toContain("리붕이");
		expect(section).toContain("꼬붕이");
		expect(section).toContain("frontend");
		expect(section).toContain("devops");
	});

	it("includes section header", async () => {
		const builder = new DelegationBuilder({ frontend: "리붕이" }, undefined);
		const section = await builder.toPromptSection();
		expect(section).toContain("# 전문 분야 및 위임");
	});

	it("shows online status when target pet is running", async () => {
		const statusReader = makeStatusReader([
			makePetStatus({ personaName: "리붕이" }),
		]);
		const builder = new DelegationBuilder({ frontend: "리붕이" }, statusReader);
		const section = await builder.toPromptSection();
		expect(section).not.toBeNull();
		// Should indicate online
		expect(section).toContain("온라인");
	});

	it("shows offline fallback when target pet is not running", async () => {
		const statusReader = makeStatusReader([]); // empty — no pets online
		const builder = new DelegationBuilder({ frontend: "리붕이" }, statusReader);
		const section = await builder.toPromptSection();
		expect(section).not.toBeNull();
		// Should indicate offline with fallback
		expect(section).toContain("직접 도와줘");
	});

	it("handles no status reader (offline fallback for all)", async () => {
		const builder = new DelegationBuilder({ frontend: "리붕이" }, undefined);
		const section = await builder.toPromptSection();
		expect(section).not.toBeNull();
		expect(section).toContain("직접 도와줘");
	});

	it("handles multiple deferTo entries with mixed online/offline", async () => {
		const statusReader = makeStatusReader([
			makePetStatus({ personaName: "리붕이" }),
			// coboonge is NOT in the list — offline
		]);
		const builder = new DelegationBuilder(
			{ frontend: "리붕이", backend: "꼬붕이" },
			statusReader,
		);
		const section = await builder.toPromptSection();
		expect(section).not.toBeNull();
		expect(section).toContain("리붕이");
		expect(section).toContain("꼬붕이");
		// 리붕이 should be online
		expect(section).toContain("온라인");
		// 꼬붕이 should have offline fallback
		expect(section).toContain("직접 도와줘");
	});
});
