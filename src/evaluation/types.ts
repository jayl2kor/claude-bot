/**
 * Types for the peer evaluation system.
 *
 * Flow:
 *   Pet A session ends → (30% chance) publishes EvaluationRequest to shared/evaluations/
 *   Pet B cron (every 30 min) → finds pending requests (excluding its own) → haiku review
 *   Feedback stored as EvaluationResult ({id}.result.json)
 */

import { z } from "zod";

// ─── Evaluation Request ────────────────────────────────────────────────────

export const EvaluationStatusSchema = z.enum([
	"pending",
	"evaluating",
	"completed",
	"expired",
]);
export type EvaluationStatus = z.infer<typeof EvaluationStatusSchema>;

export const EvaluationRequestSchema = z.object({
	id: z.string().uuid(),
	/** The pet that generated the response being evaluated. */
	petId: z.string(),
	channelId: z.string(),
	userId: z.string(),
	/** Short summary of what the user asked (2000 char cap, no raw messages). */
	promptSummary: z.string().max(2000),
	/** Short summary of what the pet responded (2000 char cap). */
	responseSummary: z.string().max(2000),
	timestamp: z.number(),
	status: EvaluationStatusSchema,
	/** Request expires after 24 hours if not evaluated. */
	expiresAt: z.number(),
});
export type EvaluationRequest = z.infer<typeof EvaluationRequestSchema>;

// ─── Evaluation Result ─────────────────────────────────────────────────────

export const EvaluationResultSchema = z.object({
	id: z.string(),
	evaluatorId: z.string(),
	score: z.number().int().min(1).max(10),
	feedback: z.string(),
	strengths: z.array(z.string()),
	improvements: z.array(z.string()),
	evaluatedAt: z.number(),
});
export type EvaluationResult = z.infer<typeof EvaluationResultSchema>;
