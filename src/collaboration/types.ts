/**
 * Collaboration types for inter-pet task coordination.
 * Shared via filesystem (data/shared/tasks/).
 */

export type TaskStatus = "pending" | "assigned" | "in_progress" | "completed" | "failed";

export type CollaborationTask = {
	id: string;
	/** The original user request. */
	prompt: string;
	/** Who created this task (which pet). */
	createdBy: string;
	/** Channel where the request came from. */
	channelId: string;
	/** User who made the request. */
	userId: string;
	userName: string;
	/** Message ID to reply to. */
	replyTo?: string;
	status: TaskStatus;
	createdAt: number;
	updatedAt: number;
	/** TTL — task expires after this timestamp. */
	expiresAt: number;
	assignments: TaskAssignment[];
	results: TaskResult[];
};

export type TaskAssignment = {
	petId: string;
	role: string;
	description: string;
	status: TaskStatus;
	assignedAt: number;
};

export type TaskResult = {
	petId: string;
	role: string;
	output: string;
	completedAt: number;
};
