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
	readonly source: 'taught' | 'inferred' | 'corrected' | 'propagated';
	readonly tags: readonly string[];
	readonly publishedAt: number;
}

