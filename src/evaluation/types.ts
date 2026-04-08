/**
 * Types for the peer evaluation system.
 *
 * Flow:
 *   Pet A session ends → (30% chance) publishes EvaluationRequest to shared/evaluations/
 *   Pet B cron (every 30 min) → finds pending requests (excluding its own) → haiku review
 *   Feedback stored in EvaluationRequest.feedback + saved to Pet B reflections
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

export const EvaluationFeedbackSchema = z.object({
	evaluatorPetId: z.string(),
	toneConsistency: z.number().int().min(1).max(5),
	accuracy: z.number().int().min(1).max(5),
	helpfulness: z.number().int().min(1).max(5),
	overallComment: z.string(),
	suggestions: z.array(z.string()),
	evaluatedAt: z.number(),
});
export type EvaluationFeedback = z.infer<typeof EvaluationFeedbackSchema>;

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
	/** Populated once another pet has evaluated. */
	feedback: EvaluationFeedbackSchema.nullable(),
	/** Request expires after 24 hours if not evaluated. */
	expiresAt: z.number(),
});
export type EvaluationRequest = z.infer<typeof EvaluationRequestSchema>;
