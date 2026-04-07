/**
 * Collaboration manager — creates tasks, assigns roles, waits for results, merges.
 */

import { randomUUID } from "node:crypto";
import { spawnClaude } from "../executor/spawner.js";
import type { ChannelPlugin } from "../plugins/types.js";
import { logger } from "../utils/logger.js";
import { sleep } from "../utils/sleep.js";
import { TaskStore } from "./task-store.js";
import type { CollaborationTask, TaskResult } from "./types.js";

const TASK_TTL_MS = 5 * 60 * 1000; // 5 minutes
const POLL_INTERVAL_MS = 3_000; // 3 seconds

export type CollabManagerConfig = {
	petId: string;
	role: string;
	sharedDir: string;
	skipPermissions: boolean;
	model: string;
};

export class CollaborationManager {
	readonly store: TaskStore;

	constructor(private readonly config: CollabManagerConfig) {
		this.store = new TaskStore(config.sharedDir);
	}

	/**
	 * Create a collaboration task and wait for all pets to complete.
	 * Called by the pet that receives the original message.
	 */
	async createAndWait(
		prompt: string,
		channelId: string,
		userId: string,
		userName: string,
		_plugin: ChannelPlugin,
		replyTo?: string,
	): Promise<string> {
		const taskId = randomUUID();
		const now = Date.now();

		const task: CollaborationTask = {
			id: taskId,
			prompt,
			createdBy: this.config.petId,
			channelId,
			userId,
			userName,
			replyTo,
			status: "pending",
			createdAt: now,
			updatedAt: now,
			expiresAt: now + TASK_TTL_MS,
			assignments: [
				{
					petId: this.config.petId,
					role: this.config.role,
					description: `${this.config.role} 파트를 담당합니다`,
					status: "assigned",
					assignedAt: now,
				},
			],
			results: [],
		};

		await this.store.create(task);
		logger.info("Collaboration task created", {
			taskId,
			petId: this.config.petId,
		});

		// Do own part immediately
		await this.executeAssignment(taskId, this.config.petId);

		// Wait for others to complete (poll)
		const finalTask = await this.waitForCompletion(taskId);

		if (!finalTask || finalTask.results.length === 0) {
			return "협업 작업이 타임아웃되었습니다.";
		}

		// Merge results if multiple
		if (finalTask.results.length === 1) {
			return finalTask.results[0]!.output;
		}

		return this.mergeResults(finalTask);
	}

	/**
	 * Poll for and execute tasks assigned to this pet.
	 * Called by the cron job.
	 */
	async pollAndExecute(): Promise<void> {
		const tasks = await this.store.findForPet(this.config.petId);

		for (const task of tasks) {
			// Skip if this pet already has a result
			if (task.results.some((r) => r.petId === this.config.petId)) continue;

			// Skip if created by this pet (already executed in createAndWait)
			if (task.createdBy === this.config.petId) continue;

			logger.info("Executing assigned collaboration task", {
				taskId: task.id,
				petId: this.config.petId,
			});
			await this.executeAssignment(task.id, this.config.petId);
		}

		// Clean up expired tasks
		const expired = await this.store.findExpired();
		for (const task of expired) {
			await this.store.update(task.id, (t) => ({ ...t, status: "failed" }));
			logger.warn("Collaboration task expired", { taskId: task.id });
		}
	}

	private async executeAssignment(
		taskId: string,
		petId: string,
	): Promise<void> {
		const task = await this.store.read(taskId);
		if (!task) return;

		const assignment = task.assignments.find((a) => a.petId === petId);
		if (!assignment) return;

		// Mark in progress
		await this.store.update(taskId, (t) => ({
			...t,
			assignments: t.assignments.map((a) =>
				a.petId === petId ? { ...a, status: "in_progress" as const } : a,
			),
		}));

		// Execute via Claude
		const prompt = [
			`협업 작업입니다. 당신의 역할: ${assignment.role}`,
			`원본 요청: ${task.prompt}`,
			`당신의 담당 설명: ${assignment.description}`,
			"역할에 맞는 부분만 집중해서 처리해주세요.",
		].join("\n");

		try {
			const handle = spawnClaude({
				prompt,
				model: this.config.model,
				maxTurns: 5,
				skipPermissions: this.config.skipPermissions,
			});

			let result = "";
			handle.onResult((r) => {
				result = r.result;
			});
			await handle.done;

			// Store result
			const taskResult: TaskResult = {
				petId,
				role: assignment.role,
				output: result || "결과 없음",
				completedAt: Date.now(),
			};

			await this.store.update(taskId, (t) => ({
				...t,
				results: [...t.results, taskResult],
				assignments: t.assignments.map((a) =>
					a.petId === petId ? { ...a, status: "completed" as const } : a,
				),
			}));

			logger.info("Collaboration assignment completed", { taskId, petId });
		} catch (err) {
			logger.error("Collaboration assignment failed", {
				taskId,
				petId,
				error: String(err),
			});
			await this.store.update(taskId, (t) => ({
				...t,
				assignments: t.assignments.map((a) =>
					a.petId === petId ? { ...a, status: "failed" as const } : a,
				),
			}));
		}
	}

	private async waitForCompletion(
		taskId: string,
	): Promise<CollaborationTask | null> {
		const deadline = Date.now() + TASK_TTL_MS;

		while (Date.now() < deadline) {
			const task = await this.store.read(taskId);
			if (!task) return null;

			// All assignments completed or failed
			const allDone = task.assignments.every(
				(a) => a.status === "completed" || a.status === "failed",
			);
			if (allDone) {
				await this.store.update(taskId, (t) => ({ ...t, status: "completed" }));
				return await this.store.read(taskId);
			}

			await sleep(POLL_INTERVAL_MS);
		}

		// Timeout — return partial results
		return this.store.read(taskId);
	}

	private async mergeResults(task: CollaborationTask): Promise<string> {
		const parts = task.results
			.map((r) => `## ${r.role} (${r.petId})\n${r.output}`)
			.join("\n\n---\n\n");

		// Use Claude to merge
		const handle = spawnClaude({
			prompt: [
				"아래는 여러 팀원의 작업 결과입니다. 하나의 통합된 응답으로 합쳐주세요.",
				`원본 요청: ${task.prompt}`,
				"",
				parts,
			].join("\n"),
			model: "haiku",
			maxTurns: 1,
		});

		let merged = "";
		handle.onResult((r) => {
			merged = r.result;
		});
		await handle.done;

		return merged || parts;
	}
}
