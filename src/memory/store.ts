/**
 * Generic file-based memory store with zod schema validation.
 * Reference: OpenClaw extensions/memory-core + Claude-code bridgePointer.ts
 *
 * Atomic writes (temp → rename), schema validation on read,
 * corrupted files return null instead of throwing.
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
import type { z } from "zod";
import { isENOENT } from "../utils/errors.js";
import { logger } from "../utils/logger.js";

type Out<S extends z.ZodTypeAny> = z.output<S>;

export class FileMemoryStore<S extends z.ZodTypeAny> {
	constructor(
		private readonly baseDir: string,
		private readonly schema: S,
	) {}

	async read(key: string): Promise<Out<S> | null> {
		try {
			const raw = await readFile(this.filePath(key), "utf8");
			const parsed = JSON.parse(raw);
			const result = this.schema.safeParse(parsed);
			if (!result.success) {
				logger.warn("Memory schema validation failed", {
					key,
					errors: result.error.message,
				});
				return null;
			}
			return result.data as Out<S>;
		} catch (err) {
			if (isENOENT(err)) return null;
			logger.warn("Failed to read memory", { key, error: String(err) });
			return null;
		}
	}

	async write(key: string, value: Out<S>): Promise<void> {
		const target = this.filePath(key);
		const tmp = `${target}.${randomUUID()}.tmp`;

		await mkdir(dirname(target), { recursive: true });
		await writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
		await rename(tmp, target);
	}

	async delete(key: string): Promise<void> {
		try {
			await unlink(this.filePath(key));
		} catch (err) {
			if (!isENOENT(err)) throw err;
		}
	}

	async list(): Promise<string[]> {
		try {
			const files = await readdir(this.baseDir);
			return files
				.filter((f) => f.endsWith(".json"))
				.map((f) => f.slice(0, -5));
		} catch (err) {
			if (isENOENT(err)) return [];
			throw err;
		}
	}

	async readAll(): Promise<Array<{ key: string; value: Out<S> }>> {
		const keys = await this.list();
		const results = await Promise.all(
			keys.map(async (key) => {
				const value = await this.read(key);
				return value !== null ? { key, value } : null;
			}),
		);
		return results.filter(
			(r): r is { key: string; value: Out<S> } => r !== null,
		);
	}

	private filePath(key: string): string {
		const safe = key.replace(/[^a-zA-Z0-9_-]/g, "_");
		return join(this.baseDir, `${safe}.json`);
	}
}
