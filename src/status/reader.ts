/**
 * Status reader — reads other pets' status from the shared directory.
 * Used by ContextBuilder to inject "리붕이 뭐해?" answers.
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { isENOENT } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import { PetStatusSchema, type PetStatus } from "./types.js";

const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

export class StatusReader {
	constructor(
		private readonly sharedDir: string,
		private readonly selfPetId: string,
	) {}

	/** Read all other pets' statuses (excluding self, excluding stale). */
	async readOthers(): Promise<PetStatus[]> {
		try {
			const files = await readdir(this.sharedDir);
			const statuses: PetStatus[] = [];

			for (const file of files) {
				if (!file.endsWith(".json")) continue;

				const petId = file.replace(".json", "");
				if (petId === this.selfPetId) continue;

				try {
					const raw = await readFile(join(this.sharedDir, file), "utf8");
					const parsed = PetStatusSchema.safeParse(JSON.parse(raw));
					if (!parsed.success) continue;

					// Skip stale
					if (Date.now() - parsed.data.heartbeatAt > STALE_THRESHOLD_MS) continue;

					statuses.push(parsed.data);
				} catch {
					// Corrupted or mid-write — skip
				}
			}

			return statuses;
		} catch (err) {
			if (isENOENT(err)) return [];
			logger.warn("Status read failed", { error: String(err) });
			return [];
		}
	}

	/** Format other pets' statuses for system prompt injection. */
	async toPromptSection(): Promise<string | null> {
		const others = await this.readOthers();
		if (others.length === 0) return null;

		const lines = ["# 다른 펫들의 현재 상태"];

		for (const pet of others) {
			const uptime = Math.floor((Date.now() - pet.startedAt) / 60_000);

			if (pet.activeSessionCount === 0) {
				lines.push(`- **${pet.personaName}** (${pet.petId}): 대기 중 (${uptime}분 가동)`);
			} else {
				const activities = pet.sessions
					.filter((s) => s.currentActivity)
					.map((s) => s.currentActivity!.summary)
					.join(", ");
				lines.push(
					`- **${pet.personaName}** (${pet.petId}): ${pet.activeSessionCount}개 세션 활성 — ${activities || "작업 중"} (${uptime}분 가동)`,
				);
			}
		}

		return lines.join("\n");
	}
}
