/**
 * Tests for GitWatcher — polling, rate limiting, state persistence, force-push recovery.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitCommitInfo, GitWatcherConfig, WatcherState } from "./types.js";
import { GitWatcher } from "./watcher.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(
	overrides: Partial<GitWatcherConfig> = {},
): GitWatcherConfig {
	return {
		enabled: true,
		branches: ["main"],
		pollIntervalMs: 60_000,
		maxReviewsPerHour: 5,
		ignoreAuthors: [],
		reviewChannelId: "test-channel",
		maxDiffChars: 4000,
		...overrides,
	};
}

function makeTempDir(): string {
	return join(tmpdir(), `claude-pet-watcher-test-${randomUUID()}`);
}

function makeCommit(overrides: Partial<GitCommitInfo> = {}): GitCommitInfo {
	return {
		sha: "abc1234567890abcdef1234567890abcdef123456",
		shortSha: "abc1234",
		author: "testuser",
		message: "feat: test commit",
		timestamp: Date.now(),
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Mock git exec
// ---------------------------------------------------------------------------

vi.mock("./exec.js", () => ({
	git: vi.fn(),
}));

import { git } from "./exec.js";

const mockGit = vi.mocked(git);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GitWatcher", () => {
	let stateDir: string;
	let config: GitWatcherConfig;

	beforeEach(async () => {
		stateDir = makeTempDir();
		await mkdir(stateDir, { recursive: true });
		config = makeConfig();
		vi.restoreAllMocks();
		mockGit.mockReset();
	});

	// -----------------------------------------------------------------------
	// init
	// -----------------------------------------------------------------------

	describe("init", () => {
		it("detects non-git workspace and disables", async () => {
			mockGit.mockRejectedValueOnce(new Error("not a git repo"));
			const watcher = new GitWatcher("/fake/path", config, stateDir);
			await watcher.init();
			expect(watcher.isActive).toBe(false);
		});

		it("detects valid git workspace and enables", async () => {
			mockGit.mockResolvedValueOnce("true"); // rev-parse --is-inside-work-tree
			mockGit.mockResolvedValueOnce("abc123"); // rev-parse HEAD
			const watcher = new GitWatcher("/fake/path", config, stateDir);
			await watcher.init();
			expect(watcher.isActive).toBe(true);
		});

		it("loads persisted state on init", async () => {
			const state: WatcherState = {
				lastCheckedSha: { main: "sha123" },
				reviewTimestamps: [Date.now() - 10_000],
			};
			await writeFile(
				join(stateDir, "git-watcher-state.json"),
				JSON.stringify(state),
			);

			mockGit.mockResolvedValueOnce("true"); // rev-parse
			mockGit.mockResolvedValueOnce("sha456"); // HEAD
			const watcher = new GitWatcher("/fake/path", config, stateDir);
			await watcher.init();

			expect(watcher.getState().lastCheckedSha.main).toBe("sha123");
		});

		it("disables when config.enabled is false", async () => {
			const disabledConfig = makeConfig({ enabled: false });
			const watcher = new GitWatcher("/fake/path", disabledConfig, stateDir);
			await watcher.init();
			expect(watcher.isActive).toBe(false);
		});
	});

	// -----------------------------------------------------------------------
	// poll
	// -----------------------------------------------------------------------

	describe("poll", () => {
		async function initWithState(
			watcher: GitWatcher,
			lastSha: string,
		): Promise<void> {
			const state: WatcherState = {
				lastCheckedSha: { main: lastSha },
				reviewTimestamps: [],
			};
			await writeFile(
				join(stateDir, "git-watcher-state.json"),
				JSON.stringify(state),
			);
			mockGit.mockResolvedValueOnce("true"); // rev-parse --is-inside-work-tree
			await watcher.init();
		}

		it("detects new commits on branch", async () => {
			const watcher = new GitWatcher("/fake/path", config, stateDir);
			await initWithState(watcher, "oldsha");

			const logOutput = [
				"newsha1|newsha1|testuser|feat: new feature|1700000000",
				"newsha2|newsha2|testuser|fix: bug fix|1700000001",
			].join("\n");
			mockGit.mockResolvedValueOnce(logOutput); // git log

			const commits = await watcher.poll("main");
			expect(commits).toHaveLength(2);
			expect(commits[0].sha).toBe("newsha1");
			expect(commits[1].sha).toBe("newsha2");
		});

		it("returns empty when no new commits", async () => {
			const watcher = new GitWatcher("/fake/path", config, stateDir);
			await initWithState(watcher, "currentsha");

			mockGit.mockResolvedValueOnce(""); // empty log output
			const commits = await watcher.poll("main");
			expect(commits).toHaveLength(0);
		});

		it("filters out ignored authors", async () => {
			const cfg = makeConfig({ ignoreAuthors: ["bot-user"] });
			const watcher = new GitWatcher("/fake/path", cfg, stateDir);
			await initWithState(watcher, "oldsha");

			const logOutput = [
				"sha1|sha1|bot-user|chore: auto|1700000000",
				"sha2|sha2|realuser|feat: real|1700000001",
			].join("\n");
			mockGit.mockResolvedValueOnce(logOutput);

			const commits = await watcher.poll("main");
			expect(commits).toHaveLength(1);
			expect(commits[0].author).toBe("realuser");
		});

		it("updates lastCheckedSha after successful poll", async () => {
			const watcher = new GitWatcher("/fake/path", config, stateDir);
			await initWithState(watcher, "oldsha");

			const logOutput = "newsha|newsha|user|feat: test|1700000000";
			mockGit.mockResolvedValueOnce(logOutput);

			await watcher.poll("main");
			expect(watcher.getState().lastCheckedSha.main).toBe("newsha");
		});
	});

	// -----------------------------------------------------------------------
	// force-push recovery
	// -----------------------------------------------------------------------

	describe("force-push recovery", () => {
		it("resets to HEAD when lastCheckedSha is no longer valid", async () => {
			// Pre-write state with a SHA that will no longer exist
			const state: WatcherState = {
				lastCheckedSha: { main: "deletedsha" },
				reviewTimestamps: [],
			};
			await writeFile(
				join(stateDir, "git-watcher-state.json"),
				JSON.stringify(state),
			);

			// init only needs rev-parse (state already has SHA for main)
			mockGit.mockResolvedValueOnce("true"); // rev-parse --is-inside-work-tree

			const watcher = new GitWatcher("/fake/path", config, stateDir);
			await watcher.init();

			// poll: git log fails because SHA no longer exists
			mockGit.mockRejectedValueOnce(
				new Error("fatal: bad revision 'deletedsha..HEAD'"),
			);
			// recovery: get current HEAD
			mockGit.mockResolvedValueOnce("headsha");

			const commits = await watcher.poll("main");
			expect(commits).toHaveLength(0);
			expect(watcher.getState().lastCheckedSha.main).toBe("headsha");
		});
	});

	// -----------------------------------------------------------------------
	// rate limiting
	// -----------------------------------------------------------------------

	describe("rate limiting", () => {
		it("returns false when under limit", () => {
			const watcher = new GitWatcher("/fake/path", config, stateDir);
			expect(watcher.isRateLimited()).toBe(false);
		});

		it("returns true when at or over limit", () => {
			const cfg = makeConfig({ maxReviewsPerHour: 2 });
			const watcher = new GitWatcher("/fake/path", cfg, stateDir);

			const now = Date.now();
			watcher.recordReview(now - 1000);
			watcher.recordReview(now - 500);

			expect(watcher.isRateLimited()).toBe(true);
		});

		it("does not count reviews older than 1 hour", () => {
			const cfg = makeConfig({ maxReviewsPerHour: 2 });
			const watcher = new GitWatcher("/fake/path", cfg, stateDir);

			const now = Date.now();
			const twoHoursAgo = now - 2 * 60 * 60 * 1000;
			watcher.recordReview(twoHoursAgo);
			watcher.recordReview(twoHoursAgo + 1000);

			expect(watcher.isRateLimited()).toBe(false);
		});
	});

	// -----------------------------------------------------------------------
	// state persistence
	// -----------------------------------------------------------------------

	describe("state persistence", () => {
		it("persists state to disk", async () => {
			mockGit.mockResolvedValueOnce("true");
			mockGit.mockResolvedValueOnce("sha123");

			const watcher = new GitWatcher("/fake/path", config, stateDir);
			await watcher.init();

			watcher.recordReview(Date.now());
			await watcher.persistState();

			const raw = await readFile(
				join(stateDir, "git-watcher-state.json"),
				"utf8",
			);
			const saved = JSON.parse(raw) as WatcherState;
			expect(saved.reviewTimestamps).toHaveLength(1);
		});

		it("survives corrupted state file on init", async () => {
			await writeFile(
				join(stateDir, "git-watcher-state.json"),
				"NOT_VALID_JSON",
			);

			mockGit.mockResolvedValueOnce("true");
			mockGit.mockResolvedValueOnce("sha123");

			const watcher = new GitWatcher("/fake/path", config, stateDir);
			await watcher.init();

			// Should gracefully reset to default state
			expect(watcher.isActive).toBe(true);
			expect(watcher.getState().reviewTimestamps).toHaveLength(0);
		});
	});

	// -----------------------------------------------------------------------
	// getDiff
	// -----------------------------------------------------------------------

	describe("getDiff", () => {
		async function initWithState(watcher: GitWatcher): Promise<void> {
			const state: WatcherState = {
				lastCheckedSha: { main: "sha123" },
				reviewTimestamps: [],
			};
			await writeFile(
				join(stateDir, "git-watcher-state.json"),
				JSON.stringify(state),
			);
			mockGit.mockResolvedValueOnce("true"); // rev-parse --is-inside-work-tree
			await watcher.init();
		}

		it("returns truncated diff when over maxDiffChars", async () => {
			const cfg = makeConfig({ maxDiffChars: 50 });
			const watcher = new GitWatcher("/fake/path", cfg, stateDir);
			await initWithState(watcher);

			const longDiff = "a".repeat(200);
			const stat = "file.ts | 10 +++--";
			mockGit.mockResolvedValueOnce(longDiff); // git diff
			mockGit.mockResolvedValueOnce(stat); // git diff --stat

			const result = await watcher.getDiff("sha1");
			expect(result).toContain("[truncated]");
			expect(result).toContain(stat);
		});

		it("returns full diff when under maxDiffChars", async () => {
			const watcher = new GitWatcher("/fake/path", config, stateDir);
			await initWithState(watcher);

			const shortDiff = "diff --git a/file.ts\n+const x = 1;";
			mockGit.mockResolvedValueOnce(shortDiff);

			const result = await watcher.getDiff("sha1");
			expect(result).toContain(shortDiff);
		});
	});
});
