/**
 * GitWatcher — polls git log for new commits and manages rate limiting.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { logger } from "../utils/logger.js";
import { git } from "./exec.js";
import type { GitCommitInfo, GitWatcherConfig, WatcherState } from "./types.js";

const STATE_FILE = "git-watcher-state.json";
const ONE_HOUR_MS = 60 * 60 * 1000;

function defaultState(): WatcherState {
	return { lastCheckedSha: {}, reviewTimestamps: [] };
}

export class GitWatcher {
	private state: WatcherState = defaultState();
	private active = false;

	constructor(
		private readonly workspacePath: string,
		private readonly config: GitWatcherConfig,
		private readonly stateDir: string,
	) {}

	get isActive(): boolean {
		return this.active;
	}

	getState(): WatcherState {
		return this.state;
	}

	async init(): Promise<void> {
		if (!this.config.enabled) {
			logger.debug("GitWatcher disabled by config");
			this.active = false;
			return;
		}

		try {
			await git(this.workspacePath, ["rev-parse", "--is-inside-work-tree"]);
		} catch {
			logger.warn("GitWatcher: workspace is not a git repository", {
				path: this.workspacePath,
			});
			this.active = false;
			return;
		}

		await this.loadState();

		for (const branch of this.config.branches) {
			if (!this.state.lastCheckedSha[branch]) {
				try {
					const head = await git(this.workspacePath, ["rev-parse", "HEAD"]);
					this.state = {
						...this.state,
						lastCheckedSha: {
							...this.state.lastCheckedSha,
							[branch]: head,
						},
					};
				} catch {
					logger.warn("GitWatcher: failed to get HEAD for branch", {
						branch,
					});
				}
			}
		}

		this.active = true;
		logger.info("GitWatcher initialized", {
			branches: this.config.branches,
			lastCheckedSha: this.state.lastCheckedSha,
		});
	}

	async poll(branch: string): Promise<readonly GitCommitInfo[]> {
		const lastSha = this.state.lastCheckedSha[branch];
		if (!lastSha) return [];

		let logOutput: string;
		try {
			logOutput = await git(this.workspacePath, [
				"log",
				`${lastSha}..HEAD`,
				"--format=%H|%h|%an|%s|%at",
				"--reverse",
			]);
		} catch {
			logger.warn("GitWatcher: SHA no longer valid, resetting to HEAD", {
				branch,
				lastSha,
			});
			try {
				const head = await git(this.workspacePath, ["rev-parse", "HEAD"]);
				this.state = {
					...this.state,
					lastCheckedSha: {
						...this.state.lastCheckedSha,
						[branch]: head,
					},
				};
				await this.persistState();
			} catch (err) {
				logger.error("GitWatcher: failed to recover from force-push", {
					error: String(err),
				});
			}
			return [];
		}

		if (!logOutput.trim()) return [];

		const commits = logOutput
			.split("\n")
			.filter((line) => line.trim().length > 0)
			.map((line): GitCommitInfo => {
				const [sha, shortSha, author, message, timestampStr] =
					line.split("|");
				return {
					sha: sha ?? "",
					shortSha: shortSha ?? "",
					author: author ?? "",
					message: message ?? "",
					timestamp: Number(timestampStr ?? "0") * 1000,
				};
			})
			.filter(
				(c) =>
					!this.config.ignoreAuthors.includes(c.author) && c.sha.length > 0,
			);

		if (commits.length > 0) {
			const latestSha = commits[commits.length - 1].sha;
			this.state = {
				...this.state,
				lastCheckedSha: {
					...this.state.lastCheckedSha,
					[branch]: latestSha,
				},
			};
		}

		return commits;
	}

	isRateLimited(): boolean {
		const now = Date.now();
		const recentCount = this.state.reviewTimestamps.filter(
			(ts) => now - ts < ONE_HOUR_MS,
		).length;
		return recentCount >= this.config.maxReviewsPerHour;
	}

	recordReview(timestamp: number = Date.now()): void {
		this.state = {
			...this.state,
			reviewTimestamps: [...this.state.reviewTimestamps, timestamp],
		};
	}

	async getDiff(sha: string): Promise<string> {
		try {
			const diff = await git(this.workspacePath, ["diff", `${sha}^..${sha}`]);

			if (diff.length <= this.config.maxDiffChars) {
				return diff;
			}

			const stat = await git(this.workspacePath, [
				"diff",
				"--stat",
				`${sha}^..${sha}`,
			]);
			const truncated = diff.slice(0, this.config.maxDiffChars);
			return `${truncated}\n\n[truncated]\n\n--- stat ---\n${stat}`;
		} catch (err) {
			logger.warn("GitWatcher: failed to get diff", {
				sha,
				error: String(err),
			});
			return "(diff unavailable)";
		}
	}

	async persistState(): Promise<void> {
		try {
			await mkdir(this.stateDir, { recursive: true });
			const filePath = join(this.stateDir, STATE_FILE);
			await writeFile(filePath, JSON.stringify(this.state, null, 2));
		} catch (err) {
			logger.warn("GitWatcher: failed to persist state", {
				error: String(err),
			});
		}
	}

	private async loadState(): Promise<void> {
		try {
			const filePath = join(this.stateDir, STATE_FILE);
			const raw = await readFile(filePath, "utf8");
			const parsed = JSON.parse(raw) as unknown;

			if (
				parsed &&
				typeof parsed === "object" &&
				"lastCheckedSha" in parsed &&
				"reviewTimestamps" in parsed
			) {
				this.state = parsed as WatcherState;
			} else {
				this.state = defaultState();
			}
		} catch {
			this.state = defaultState();
		}
	}
}
