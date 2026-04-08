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
import type { EvaluationRequest, EvaluationResult, EvaluationStatus } from "./types.js";

export type { EvaluationResult };

export class EvaluationStore {
	constructor(private readonly baseDir: string) {}

	/** Save an evaluation request to {id}.json */
	async create(req: EvaluationRequest): Promise<void> {
		await this.write(this.requestPath(req.id), req);
	}

	/** Update the status of an evaluation request. */
	async updateStatus(id: string, status: EvaluationStatus): Promise<void> {
		const req = await this.readRequest(id);
		if (!req) {
			logger.warn("EvaluationStore: updateStatus — request not found", { id });
			return;
		}
		await this.write(this.requestPath(id), { ...req, status });
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
	 * - are NOT in "evaluating" status (being processed by another evaluator)
	 * - do NOT yet have a result file
	 * - have not expired
	 */
	async listPending(evaluatorId: string): Promise<EvaluationRequest[]> {
		const active = await this.readActiveRequests();
		const pending: EvaluationRequest[] = [];

		for (const req of active) {
			// Skip our own requests
			if (req.petId === evaluatorId) continue;

			// Skip requests already being evaluated
			if (req.status === "evaluating") continue;

			// Skip if already evaluated (result file exists)
			const result = await this.readResult(req.id);
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
		const active = await this.readActiveRequests();
		let count = 0;

		for (const req of active) {
			if (req.petId !== requesterId) continue;

			// Count unevaluated ones
			const result = await this.readResult(req.id);
			if (!result) count++;
		}

		return count;
	}

	/** Return all non-expired EvaluationRequests from the store directory. */
	private async readActiveRequests(): Promise<EvaluationRequest[]> {
		let files: string[];
		try {
			files = await readdir(this.baseDir);
		} catch (err) {
			if (isENOENT(err)) return [];
			throw err;
		}

		const now = Date.now();
		const active: EvaluationRequest[] = [];

		for (const file of files) {
			if (!file.endsWith(".json") || file.endsWith(".result.json")) continue;

			const id = file.replace(".json", "");
			const req = await this.readRequest(id);
			if (!req) continue;

			// Skip expired requests
			if (req.expiresAt < now) continue;

			active.push(req);
		}

		return active;
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
