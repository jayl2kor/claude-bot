/**
 * Shared task store — file-based IPC for pet collaboration.
 * Uses atomic writes to prevent corruption under concurrent access.
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
import type { CollaborationTask } from "./types.js";

export class TaskStore {
	constructor(private readonly baseDir: string) {}

	async create(task: CollaborationTask): Promise<void> {
		await this.write(task.id, task);
	}

	async read(taskId: string): Promise<CollaborationTask | null> {
		try {
			const raw = await readFile(this.filePath(taskId), "utf8");
			return JSON.parse(raw) as CollaborationTask;
		} catch (err) {
			if (isENOENT(err)) return null;
			logger.warn("Task read failed", { taskId, error: String(err) });
			return null;
		}
	}

	async update(
		taskId: string,
		updater: (task: CollaborationTask) => CollaborationTask,
	): Promise<CollaborationTask | null> {
		const task = await this.read(taskId);
		if (!task) return null;
		const updated = updater(task);
		await this.write(taskId, { ...updated, updatedAt: Date.now() });
		return updated;
	}

	async delete(taskId: string): Promise<void> {
		try {
			await unlink(this.filePath(taskId));
		} catch (err) {
			if (!isENOENT(err)) throw err;
		}
	}

	/** Find tasks assigned to a specific pet that are pending/assigned. */
	async findForPet(petId: string): Promise<CollaborationTask[]> {
		const all = await this.listAll();
		return all.filter(
			(t) =>
				t.assignments.some(
					(a) =>
						a.petId === petId &&
						(a.status === "pending" || a.status === "assigned"),
				) &&
				t.status !== "completed" &&
				t.status !== "failed",
		);
	}

	/** Find expired tasks. */
	async findExpired(): Promise<CollaborationTask[]> {
		const all = await this.listAll();
		return all.filter(
			(t) => t.expiresAt < Date.now() && t.status !== "completed",
		);
	}

	async listAll(): Promise<CollaborationTask[]> {
		try {
			const files = await readdir(this.baseDir);
			const tasks: CollaborationTask[] = [];
			for (const f of files) {
				if (!f.endsWith(".json")) continue;
				const task = await this.read(f.replace(".json", ""));
				if (task) tasks.push(task);
			}
			return tasks;
		} catch (err) {
			if (isENOENT(err)) return [];
			throw err;
		}
	}

	private filePath(taskId: string): string {
		return join(this.baseDir, `${taskId}.json`);
	}

	private async write(taskId: string, task: CollaborationTask): Promise<void> {
		const target = this.filePath(taskId);
		const tmp = `${target}.${randomUUID()}.tmp`;
		await mkdir(dirname(target), { recursive: true });
		await writeFile(tmp, JSON.stringify(task, null, 2), "utf8");
		await rename(tmp, target);
	}
}
