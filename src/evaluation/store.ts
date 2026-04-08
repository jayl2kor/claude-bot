/**
 * EvaluationStore — file-based shared store for peer evaluation requests.
 * Uses atomic writes to prevent corruption under concurrent access.
 *
 * File layout:
 *   {baseDir}/{id}.json         — EvaluationRequest
 *   {baseDir}/{id}.result.json  — EvaluationResult (once evaluated)
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
import type { EvaluationRequest } from "./types.js";

export type EvaluationResult = {
	id: string;
	evaluatorId: string;
	score: number;
	feedback: string;
	strengths: string[];
	improvements: string[];
	evaluatedAt: number;
};

export class EvaluationStore {
	constructor(private readonly baseDir: string) {}

	/** Save an evaluation request to {id}.json */
	async create(req: EvaluationRequest): Promise<void> {
		await this.write(this.requestPath(req.id), req);
	}

	/** Read an evaluation request by id. */
	async readRequest(id: string): Promise<EvaluationRequest | null> {
		try {
			const raw = await readFile(this.requestPath(id), "utf8");
			return JSON.parse(raw) as EvaluationRequest;
		} catch (err) {
			if (isENOENT(err)) return null;
			logger.warn("EvaluationStore: request read failed", {
				id,
				error: String(err),
			});
			return null;
		}
	}

	/** Save an evaluation result to {id}.result.json */
	async saveResult(result: EvaluationResult): Promise<void> {
		await this.write(this.resultPath(result.id), result);
	}

	/** Read an evaluation result by id. */
	async readResult(id: string): Promise<EvaluationResult | null> {
		try {
			const raw = await readFile(this.resultPath(id), "utf8");
			return JSON.parse(raw) as EvaluationResult;
		} catch (err) {
			if (isENOENT(err)) return null;
			logger.warn("EvaluationStore: result read failed", {
				id,
				error: String(err),
			});
			return null;
		}
	}

	/**
	 * Return pending evaluation requests that:
	 * - were NOT created by evaluatorId (don't self-evaluate)
	 * - do NOT yet have a result file
	 * - have not expired
	 */
	async listPending(evaluatorId: string): Promise<EvaluationRequest[]> {
		let files: string[];
		try {
			files = await readdir(this.baseDir);
		} catch (err) {
			if (isENOENT(err)) return [];
			throw err;
		}

		const now = Date.now();
		const pending: EvaluationRequest[] = [];

		for (const file of files) {
			if (!file.endsWith(".json") || file.endsWith(".result.json")) continue;

			const id = file.replace(".json", "");
			const req = await this.readRequest(id);
			if (!req) continue;

			// Skip our own requests
			if (req.petId === evaluatorId) continue;

			// Skip expired requests
			if (req.expiresAt < now) continue;

			// Skip if already evaluated (result file exists)
			const result = await this.readResult(id);
			if (result) continue;

			pending.push(req);
		}

		return pending;
	}

	/** Delete expired request and result files. */
	async cleanup(): Promise<void> {
		let files: string[];
		try {
			files = await readdir(this.baseDir);
		} catch (err) {
			if (isENOENT(err)) return;
			throw err;
		}

		const now = Date.now();

		for (const file of files) {
			if (!file.endsWith(".json") || file.endsWith(".result.json")) continue;

			const id = file.replace(".json", "");
			const req = await this.readRequest(id);
			if (!req) continue;

			if (req.expiresAt < now) {
				await this.removeFile(this.requestPath(id));
				await this.removeFile(this.resultPath(id));
				logger.debug("EvaluationStore: cleaned up expired request", { id });
			}
		}
	}

	/** Count pending requests (for maxPendingCount check). */
	async countPending(requesterId: string): Promise<number> {
		let files: string[];
		try {
			files = await readdir(this.baseDir);
		} catch (err) {
			if (isENOENT(err)) return 0;
			throw err;
		}

		const now = Date.now();
		let count = 0;

		for (const file of files) {
			if (!file.endsWith(".json") || file.endsWith(".result.json")) continue;

			const id = file.replace(".json", "");
			const req = await this.readRequest(id);
			if (!req) continue;
			if (req.petId !== requesterId) continue;
			if (req.expiresAt < now) continue;

			// Count unevaluated ones
			const result = await this.readResult(id);
			if (!result) count++;
		}

		return count;
	}

	private requestPath(id: string): string {
		return join(this.baseDir, `${id}.json`);
	}

	private resultPath(id: string): string {
		return join(this.baseDir, `${id}.result.json`);
	}

	private async write(path: string, data: unknown): Promise<void> {
		const tmp = `${path}.${randomUUID()}.tmp`;
		await mkdir(dirname(path), { recursive: true });
		await writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
		await rename(tmp, path);
	}

	private async removeFile(path: string): Promise<void> {
		try {
			await unlink(path);
		} catch (err) {
			if (!isENOENT(err)) {
				logger.warn("EvaluationStore: failed to remove file", {
					path,
					error: String(err),
				});
			}
		}
	}
}
