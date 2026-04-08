/**
 * Tests for GitWatcher — polling, rate limiting, state persistence, force-push recovery.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GitWatcherConfig, WatcherState } from "./types.js";
import { GitWatcher } from "./watcher.js";

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

vi.mock("./exec.js", () => ({
	git: vi.fn(),
}));

import { git } from "./exec.js";

const mockGit = vi.mocked(git);

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

	describe("init", () => {
		it("detects non-git workspace and disables", async () => {
			mockGit.mockRejectedValueOnce(new Error("not a git repo"));
			const watcher = new GitWatcher("/fake/path", config, stateDir);
			await watcher.init();
			expect(watcher.isActive).toBe(false);
		});

		it("detects valid git workspace and enables", async () => {
			mockGit.mockResolvedValueOnce("true");
			mockGit.mockResolvedValueOnce("abc123");
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
			mockGit.mockResolvedValueOnce("true");
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
			mockGit.mockResolvedValueOnce("true");
			await watcher.init();
		}

		it("detects new commits on branch", async () => {
			const watcher = new GitWatcher("/fake/path", config, stateDir);
			await initWithState(watcher, "oldsha");
			const logOutput = [
				"newsha1|newsha1|testuser|feat: new feature|1700000000",
				"newsha2|newsha2|testuser|fix: bug fix|1700000001",
			].join("\n");
			mockGit.mockResolvedValueOnce(logOutput);
			const commits = await watcher.poll("main");
			expect(commits).toHaveLength(2);
			expect(commits[0].sha).toBe("newsha1");
			expect(commits[1].sha).toBe("newsha2");
		});

		it("returns empty when no new commits", async () => {
			const watcher = new GitWatcher("/fake/path", config, stateDir);
			await initWithState(watcher, "currentsha");
			mockGit.mockResolvedValueOnce("");
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
			mockGit.mockResolvedValueOnce("newsha|newsha|user|feat: test|1700000000");
			await watcher.poll("main");
			expect(watcher.getState().lastCheckedSha.main).toBe("newsha");
		});
	});

	describe("force-push recovery", () => {
		it("resets to HEAD when lastCheckedSha is no longer valid", async () => {
			const state: WatcherState = {
				lastCheckedSha: { main: "deletedsha" },
				reviewTimestamps: [],
			};
			await writeFile(
				join(stateDir, "git-watcher-state.json"),
				JSON.stringify(state),
			);
			mockGit.mockResolvedValueOnce("true");
			const watcher = new GitWatcher("/fake/path", config, stateDir);
			await watcher.init();

			mockGit.mockRejectedValueOnce(
				new Error("fatal: bad revision 'deletedsha..HEAD'"),
			);
			mockGit.mockResolvedValueOnce("headsha");

			const commits = await watcher.poll("main");
			expect(commits).toHaveLength(0);
			expect(watcher.getState().lastCheckedSha.main).toBe("headsha");
		});
	});

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
			const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
			watcher.recordReview(twoHoursAgo);
			watcher.recordReview(twoHoursAgo + 1000);
			expect(watcher.isRateLimited()).toBe(false);
		});
	});

	describe("state persistence", () => {
		it("persists state to disk", async () => {
			const state: WatcherState = {
				lastCheckedSha: { main: "sha123" },
				reviewTimestamps: [],
			};
			await writeFile(
				join(stateDir, "git-watcher-state.json"),
				JSON.stringify(state),
			);
			mockGit.mockResolvedValueOnce("true");
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
			expect(watcher.isActive).toBe(true);
			expect(watcher.getState().reviewTimestamps).toHaveLength(0);
		});
	});

	describe("getDiff", () => {
		async function initWatcher(watcher: GitWatcher): Promise<void> {
			const state: WatcherState = {
				lastCheckedSha: { main: "sha123" },
				reviewTimestamps: [],
			};
			await writeFile(
				join(stateDir, "git-watcher-state.json"),
				JSON.stringify(state),
			);
			mockGit.mockResolvedValueOnce("true");
			await watcher.init();
		}

		it("returns truncated diff when over maxDiffChars", async () => {
			const cfg = makeConfig({ maxDiffChars: 50 });
			const watcher = new GitWatcher("/fake/path", cfg, stateDir);
			await initWatcher(watcher);
			mockGit.mockResolvedValueOnce("a".repeat(200));
			mockGit.mockResolvedValueOnce("file.ts | 10 +++--");
			const result = await watcher.getDiff("sha1");
			expect(result).toContain("[truncated]");
			expect(result).toContain("file.ts | 10 +++--");
		});

		it("returns full diff when under maxDiffChars", async () => {
			const watcher = new GitWatcher("/fake/path", config, stateDir);
			await initWatcher(watcher);
			const shortDiff = "diff --git a/file.ts\n+const x = 1;";
			mockGit.mockResolvedValueOnce(shortDiff);
			const result = await watcher.getDiff("sha1");
			expect(result).toContain(shortDiff);
		});
	});
});
