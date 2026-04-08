/**
 * Git watcher types — commit info, watcher config, and persisted state.
 */

export type GitCommitInfo = {
	readonly sha: string;
	readonly shortSha: string;
	readonly author: string;
	readonly message: string;
	readonly timestamp: number;
};

export type GitWatcherConfig = {
	readonly enabled: boolean;
	readonly branches: readonly string[];
	readonly pollIntervalMs: number;
	readonly maxReviewsPerHour: number;
	readonly ignoreAuthors: readonly string[];
	readonly reviewChannelId: string;
	readonly maxDiffChars: number;
};

export type WatcherState = {
	readonly lastCheckedSha: Record<string, string>;
	readonly reviewTimestamps: readonly number[];
};
