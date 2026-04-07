/**
 * Activity tracker — records user activity patterns for proactive care.
 */

import { z } from "zod";
import { FileMemoryStore } from "./store.js";

const ActivityRecordSchema = z.object({
	userId: z.string(),
	hourlyDistribution: z.array(z.number()).length(24).default(Array(24).fill(0) as number[]),
	sessionStartAt: z.number().nullable().default(null),
	lastActivityAt: z.number().default(0),
	lastAlertAt: z.number().default(0),
	alertsToday: z.number().default(0),
	alertsResetDate: z.string().default(""),
});

export type ActivityRecord = z.output<typeof ActivityRecordSchema>;

export class ActivityTracker {
	private readonly store: FileMemoryStore<typeof ActivityRecordSchema>;

	constructor(memoryDir: string) {
		this.store = new FileMemoryStore(memoryDir, ActivityRecordSchema);
	}

	async recordActivity(userId: string, timestamp: number): Promise<void> {
		const existing = (await this.store.read(userId)) ?? createDefault(userId);
		const hour = new Date(timestamp).getHours();
		const today = new Date(timestamp).toISOString().slice(0, 10);

		const hourly = [...existing.hourlyDistribution];
		hourly[hour] = (hourly[hour] ?? 0) + 1;

		const updated: ActivityRecord = {
			...existing,
			hourlyDistribution: hourly,
			lastActivityAt: timestamp,
			sessionStartAt: existing.sessionStartAt ?? timestamp,
			// Reset daily alert counter
			alertsToday: existing.alertsResetDate === today ? existing.alertsToday : 0,
			alertsResetDate: today,
		};

		await this.store.write(userId, updated);
	}

	async getRecord(userId: string): Promise<ActivityRecord | null> {
		return this.store.read(userId);
	}

	async markAlerted(userId: string, timestamp: number): Promise<void> {
		const existing = await this.store.read(userId);
		if (!existing) return;

		await this.store.write(userId, {
			...existing,
			lastAlertAt: timestamp,
			alertsToday: existing.alertsToday + 1,
		});
	}

	async resetSession(userId: string): Promise<void> {
		const existing = await this.store.read(userId);
		if (!existing) return;

		await this.store.write(userId, {
			...existing,
			sessionStartAt: null,
		});
	}

	async listActiveUsers(): Promise<ActivityRecord[]> {
		const entries = await this.store.readAll();
		const cutoff = Date.now() - 30 * 60 * 1000; // Active in last 30 min
		return entries.map((e) => e.value).filter((r) => r.lastActivityAt > cutoff);
	}
}

function createDefault(userId: string): ActivityRecord {
	return {
		userId,
		hourlyDistribution: Array(24).fill(0) as number[],
		sessionStartAt: null,
		lastActivityAt: 0,
		lastAlertAt: 0,
		alertsToday: 0,
		alertsResetDate: "",
	};
}
