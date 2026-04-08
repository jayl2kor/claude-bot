/**
 * Types for the knowledge feed — inter-pet knowledge propagation.
 */

export interface FeedEntry {
	readonly id: string;
	readonly sourcePetId: string;
	readonly originalKnowledgeId: string;
	readonly topic: string;
	readonly content: string;
	readonly confidence: number;
	readonly source: string;
	readonly tags: readonly string[];
	readonly publishedAt: number;
}

export interface FeedImportRecord {
	readonly feedEntryId: string;
	readonly importedAt: number;
	readonly localKnowledgeId: string;
}
