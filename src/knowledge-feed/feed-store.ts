/**
 * Feed store — file-based store for shared knowledge feed entries.
 * Uses atomic writes (temp file + rename) to prevent corruption.
 * Follows the TaskStore pattern from src/collaboration/task-store.ts.
 */

import { randomUUID } from "node:crypto";
import {
	mkdir,
	readFile,
	readdir,
	rename,
	unlink,
	writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { isENOENT } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import type { FeedEntry } from "./types.js";

export class FeedStore {
	constructor(private readonly baseDir: string) {}

	/** Write a feed entry atomically. */
	async write(entry: FeedEntry): Promise<void> {
		const target = this.filePath(entry.id);
		const tmp = `${target}.${randomUUID()}.tmp`;
		await mkdir(dirname(target), { recursive: true });
		await writeFile(tmp, JSON.stringify(entry, null, 2), "utf8");
		await rename(tmp, target);
	}

	/** Read a feed entry by ID. */
	async read(id: string): Promise<FeedEntry | null> {
		try {
			const raw = await readFile(this.filePath(id), "utf8");
			return JSON.parse(raw) as FeedEntry;
		} catch (err) {
			if (isENOENT(err)) return null;
			logger.warn("Feed entry read failed", { id, error: String(err) });
			return null;
		}
	}

	/** Remove a feed entry by ID. */
	async remove(id: string): Promise<void> {
		try {
			await unlink(this.filePath(id));
		} catch (err) {
			if (!isENOENT(err)) throw err;
		}
	}

	/** List all entries published after the given timestamp, sorted ascending. */
	async listSince(timestamp: number): Promise<FeedEntry[]> {
		const all = await this.listAll();
		return all
			.filter((e) => e.publishedAt > timestamp)
			.sort((a, b) => a.publishedAt - b.publishedAt);
	}

	/** Find entries older than the given TTL (in ms). */
	async findExpired(ttlMs: number): Promise<FeedEntry[]> {
		const cutoff = Date.now() - ttlMs;
		const all = await this.listAll();
		return all.filter((e) => e.publishedAt < cutoff);
	}

	/** List all entries in the store. */
	private async listAll(): Promise<FeedEntry[]> {
		try {
			const files = await readdir(this.baseDir);
			const entries: FeedEntry[] = [];
			for (const f of files) {
				if (!f.endsWith(".json")) continue;
				const id = f.replace(".json", "");
				const entry = await this.read(id);
				if (entry) entries.push(entry);
			}
			return entries;
		} catch (err) {
			if (isENOENT(err)) return [];
			throw err;
		}
	}

	private filePath(id: string): string {
		return join(this.baseDir, `${id}.json`);
	}
}
