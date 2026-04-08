/**
 * Study feature types and Zod schemas.
 * Directed autonomous learning — pet studies topics on user request.
 */

import { z } from "zod";

export const StudyStatusSchema = z.enum([
	"queued",
	"in_progress",
	"completed",
	"failed",
]);

export type StudyStatus = z.infer<typeof StudyStatusSchema>;

export const SubtopicSchema = z.object({
	topic: z.string(),
	content: z.string(),
	tags: z.array(z.string()),
});

export type Subtopic = z.infer<typeof SubtopicSchema>;

export const StudyResultSchema = z.object({
	subtopics: z.array(SubtopicSchema),
	knowledgeIds: z.array(z.string()),
});

export type StudyResult = z.infer<typeof StudyResultSchema>;

export const StudyRequestSchema = z.object({
	id: z.string(),
	topic: z.string(),
	status: StudyStatusSchema,
	requestedAt: z.number(),
	completedAt: z.number().optional(),
	result: StudyResultSchema.optional(),
	error: z.string().optional(),
});

export type StudyRequest = z.infer<typeof StudyRequestSchema>;

export const StudyQueueStateSchema = z.object({
	requests: z.array(StudyRequestSchema),
	dailyCount: z.number(),
	dailyResetAt: z.number(),
});

export type StudyQueueState = z.infer<typeof StudyQueueStateSchema>;

export type StudyConfig = {
	readonly enabled: boolean;
	readonly maxDailySessions: number;
	readonly maxSubTopics: number;
	readonly model: string;
	readonly maxTurns: number;
};
