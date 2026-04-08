/**
 * File-based report history store for growth reports.
 * Persists report history for delta comparison between reports.
 */

import { FileMemoryStore } from "../memory/store.js";
import type { ReportHistoryStore } from "./reporter.js";
import { type ReportHistory, ReportHistorySchema } from "./types.js";

export class FileReportHistoryStore implements ReportHistoryStore {
	private readonly store: FileMemoryStore<typeof ReportHistorySchema>;

	constructor(memoryDir: string) {
		this.store = new FileMemoryStore(memoryDir, ReportHistorySchema);
	}

	async save(history: ReportHistory): Promise<void> {
		await this.store.write(history.id, history);
	}

	async getLatest(): Promise<ReportHistory | null> {
		const all = await this.store.readAll();
		if (all.length === 0) return null;

		return all
			.map((e) => e.value)
			.sort((a, b) => b.generatedAt - a.generatedAt)[0];
	}
}
