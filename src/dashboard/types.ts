/**
 * API response types for the web dashboard.
 * All data is read-only — the dashboard never writes to pet data.
 */

export interface PetSummary {
	readonly id: string;
	readonly name: string;
	readonly isOnline: boolean;
	readonly lastSeen?: number;
	readonly knowledgeCount: number;
	readonly relationshipCount: number;
}

export interface PetStats {
	readonly knowledge: {
		readonly total: number;
		readonly bySource: Readonly<Record<string, number>>;
		readonly recentTopics: readonly string[];
	};
	readonly relationships: {
		readonly total: number;
		readonly recentNames: readonly string[];
	};
	readonly reflections: {
		readonly total: number;
		readonly latestInsight?: string;
	};
	readonly activity: {
		readonly totalSessions: number;
		readonly peakHour?: number;
	};
}

export interface GrowthDataPoint {
	readonly date: string;
	readonly knowledgeCount: number;
	readonly relationshipCount: number;
}

export interface ActivityHeatmap {
	readonly hour: number;
	readonly count: number;
}

export interface ApiResponse<T> {
	readonly success: boolean;
	readonly data?: T;
	readonly error?: string;
	readonly meta?: {
		readonly total: number;
		readonly page: number;
		readonly limit: number;
	};
}
