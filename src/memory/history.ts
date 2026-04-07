/**
 * Chat history manager — stores and searches channel conversation history.
 * Append-based storage per channel, with keyword and time-range search.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isENOENT } from "../utils/errors.js";
import { logger } from "../utils/logger.js";

const MAX_ENTRIES_PER_CHANNEL = 1000;

export type ChatHistoryEntry = {
	messageId: string;
	userId: string;
	userName: string;
	channelId: string;
	content: string;
	timestamp: number;
	isBot: boolean;
};

export type HistorySearchOptions = {
	keyword?: string;
	userId?: string;
	afterTimestamp?: number;
	limit?: number;
};

export class ChatHistoryManager {
	constructor(private readonly baseDir: string) {}

	/** Append a message to channel history. */
	async append(entry: ChatHistoryEntry): Promise<void> {
		try {
			const entries = await this.loadChannel(entry.channelId);
			entries.push(entry);

			// Trim to max size
			const trimmed = entries.length > MAX_ENTRIES_PER_CHANNEL
				? entries.slice(-MAX_ENTRIES_PER_CHANNEL)
				: entries;

			await this.saveChannel(entry.channelId, trimmed);
		} catch (err) {
			logger.warn("History append failed", { error: String(err) });
		}
	}

	/** Get recent messages from a channel. */
	async getRecent(channelId: string, count = 50): Promise<ChatHistoryEntry[]> {
		const entries = await this.loadChannel(channelId);
		return entries.slice(-count);
	}

	/** Search history with filters. */
	async search(channelId: string, options: HistorySearchOptions): Promise<ChatHistoryEntry[]> {
		const entries = await this.loadChannel(channelId);
		const limit = options.limit ?? 20;

		let results = entries;

		if (options.afterTimestamp) {
			results = results.filter((e) => e.timestamp > options.afterTimestamp!);
		}

		if (options.userId) {
			results = results.filter((e) => e.userId === options.userId);
		}

		if (options.keyword) {
			const kw = options.keyword.toLowerCase();
			results = results.filter((e) => e.content.toLowerCase().includes(kw));
		}

		return results.slice(-limit);
	}

	/** Prune entries older than maxAgeMs, keeping at least minKeep entries. */
	async prune(channelId: string, maxAgeMs: number, minKeep = 500): Promise<number> {
		const entries = await this.loadChannel(channelId);
		if (entries.length <= minKeep) return 0;

		const cutoff = Date.now() - maxAgeMs;
		const fresh = entries.filter((e) => e.timestamp > cutoff);
		const kept = fresh.length < minKeep ? entries.slice(-minKeep) : fresh;
		const pruned = entries.length - kept.length;

		if (pruned > 0) {
			await this.saveChannel(channelId, kept);
		}
		return pruned;
	}

	/** List all channel IDs that have history. */
	async listChannels(): Promise<string[]> {
		const { readdir } = await import("node:fs/promises");
		try {
			const files = await readdir(this.baseDir);
			return files.filter((f) => f.endsWith(".json")).map((f) => f.replace(".json", ""));
		} catch (err) {
			if (isENOENT(err)) return [];
			throw err;
		}
	}

	private channelPath(channelId: string): string {
		const safe = channelId.replace(/[^a-zA-Z0-9_-]/g, "_");
		return join(this.baseDir, `${safe}.json`);
	}

	private async loadChannel(channelId: string): Promise<ChatHistoryEntry[]> {
		try {
			const raw = await readFile(this.channelPath(channelId), "utf8");
			return JSON.parse(raw) as ChatHistoryEntry[];
		} catch (err) {
			if (isENOENT(err)) return [];
			logger.warn("History load failed", { channelId, error: String(err) });
			return [];
		}
	}

	private async saveChannel(channelId: string, entries: ChatHistoryEntry[]): Promise<void> {
		const path = this.channelPath(channelId);
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, JSON.stringify(entries), "utf8");
	}
}
