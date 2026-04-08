/**
 * Expertise system types — Zod schemas for pet domain expertise.
 *
 * - ExpertiseConfig: per-pet expertise configuration (domains, decay, delegation)
 * - SeedKnowledgeEntry: pre-registered knowledge entries for seeding
 * - SeedState: tracks which entries have been imported (SHA-256 hash dedup)
 */

import { z } from "zod";

export const ExpertiseConfigSchema = z.object({
	domains: z.array(z.string()).default([]),
	decayMultiplier: z.number().min(0).max(1).default(0.3),
	deferTo: z.record(z.string(), z.string()).default({}),
});

export type ExpertiseConfig = z.infer<typeof ExpertiseConfigSchema>;

export const SeedKnowledgeEntrySchema = z.object({
	topic: z.string(),
	content: z.string(),
	tags: z.array(z.string()).default([]),
	confidence: z.number().min(0).max(1).default(0.8),
});

export type SeedKnowledgeEntry = z.infer<typeof SeedKnowledgeEntrySchema>;

export const SeedStateSchema = z.object({
	importedHashes: z.array(z.string()).default([]),
});

export type SeedState = z.infer<typeof SeedStateSchema>;
