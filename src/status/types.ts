/**
 * Shared status types for inter-pet visibility.
 * Each pet writes its status to a shared volume as {petId}.json.
 */

import { z } from "zod";

const SessionStatusSchema = z.object({
	userId: z.string(),
	channelId: z.string(),
	currentActivity: z
		.object({
			type: z.string(),
			summary: z.string(),
			timestamp: z.number(),
		})
		.nullable()
		.default(null),
	startedAt: z.number(),
});

export const PetStatusSchema = z.object({
	petId: z.string(),
	personaName: z.string(),
	activeSessionCount: z.number(),
	sessions: z.array(SessionStatusSchema).default([]),
	heartbeatAt: z.number(),
	startedAt: z.number(),
});

export type SessionStatus = z.output<typeof SessionStatusSchema>;
export type PetStatus = z.output<typeof PetStatusSchema>;
