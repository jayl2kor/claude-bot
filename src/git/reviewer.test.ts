/**
 * Tests for GitReviewer — prompt construction, message formatting, error handling.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { GitReviewer } from "./reviewer.js";
import type { GitCommitInfo } from "./types.js";

vi.mock("../executor/spawner.js", () => ({
	spawnClaude: vi.fn(),
}));

import { spawnClaude } from "../executor/spawner.js";

const mockSpawnClaude = vi.mocked(spawnClaude);

function makeMockPlugin() {
	return {
		id: "test-channel",
		meta: { label: "Test", textChunkLimit: 2000 },
		connect: vi.fn().mockResolvedValue(undefined),
		onMessage: vi.fn(),
		sendMessage: vi.fn().mockResolvedValue(undefined),
		sendTyping: vi.fn().mockResolvedValue(undefined),
		disconnect: vi.fn().mockResolvedValue(undefined),
	};
}

function makeCommit(overrides: Partial<GitCommitInfo> = {}): GitCommitInfo {
	return {
		sha: "abc1234567890",
		shortSha: "abc1234",
		author: "testuser",
		message: "feat: add new feature",
		timestamp: Date.now(),
		...overrides,
	};
}

function mockClaudeResult(result: string): void {
	const resultCallbacks: Array<(r: { result: string }) => void> = [];
	mockSpawnClaude.mockReturnValue({
		sessionId: undefined,
		claudeSessionId: undefined,
		done: Promise.resolve("completed" as const).then((v) => {
			for (const cb of resultCallbacks) cb({ result });
			return v;
		}),
		activities: [],
		lastStderr: [],
		currentActivity: null,
		onText: vi.fn(),
		onResult: (cb: (r: { result: string }) => void) => {
			resultCallbacks.push(cb);
		},
		kill: vi.fn(),
		forceKill: vi.fn(),
		writeStdin: vi.fn(),
	} as unknown as ReturnType<typeof spawnClaude>);
}

describe("GitReviewer", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
		mockSpawnClaude.mockReset();
	});

	describe("review", () => {
		it("generates review using Claude and returns formatted message", async () => {
			mockClaudeResult("This commit adds a well-structured feature.");
			const reviewer = new GitReviewer("TestPet", "호기심 많은 고양이");
			const result = await reviewer.review(
				makeCommit(),
				"diff --git a/file.ts\n+const x = 1;",
			);
			expect(result).toContain("[GIT]");
			expect(result).toContain("abc1234");
			expect(result).toContain("testuser");
			expect(result).toContain("This commit adds a well-structured feature.");
		});

		it("includes persona in the prompt sent to Claude", async () => {
			mockClaudeResult("LGTM!");
			const reviewer = new GitReviewer("CatBot", "코드를 사랑하는 고양이");
			await reviewer.review(makeCommit(), "some diff");
			const call = mockSpawnClaude.mock.calls[0][0];
			expect(call.prompt).toContain("CatBot");
			expect(call.prompt).toContain("코드를 사랑하는 고양이");
		});

		it("uses haiku model for reviews", async () => {
			mockClaudeResult("Fine.");
			const reviewer = new GitReviewer("Pet", "persona");
			await reviewer.review(makeCommit(), "diff");
			expect(mockSpawnClaude.mock.calls[0][0].model).toBe("haiku");
		});

		it("limits maxTurns to 1", async () => {
			mockClaudeResult("OK");
			const reviewer = new GitReviewer("Pet", "persona");
			await reviewer.review(makeCommit(), "diff");
			expect(mockSpawnClaude.mock.calls[0][0].maxTurns).toBe(1);
		});
	});

	describe("sendReview", () => {
		it("sends formatted review to channel plugin", async () => {
			const plugin = makeMockPlugin();
			const reviewer = new GitReviewer("Pet", "persona");
			const message = "[GIT] abc1234 by testuser: feat: test\n\nLGTM!";
			await reviewer.sendReview(plugin, "channel-123", message);
			expect(plugin.sendMessage).toHaveBeenCalledWith(
				"channel-123",
				message,
				undefined,
			);
		});

		it("handles send errors gracefully", async () => {
			const plugin = makeMockPlugin();
			plugin.sendMessage.mockRejectedValueOnce(new Error("network error"));
			const reviewer = new GitReviewer("Pet", "persona");
			await expect(
				reviewer.sendReview(plugin, "ch", "msg"),
			).resolves.not.toThrow();
		});
	});

	describe("formatMessage", () => {
		it("formats commit info with review text", () => {
			const reviewer = new GitReviewer("Pet", "persona");
			const commit = makeCommit({
				shortSha: "def5678",
				author: "alice",
				message: "fix: resolve crash",
			});
			const result = reviewer.formatMessage(commit, "Good fix!");
			expect(result).toBe(
				"[GIT] def5678 by alice: fix: resolve crash\n\nGood fix!",
			);
		});
	});

	describe("error handling", () => {
		it("returns fallback message when Claude fails", async () => {
			mockSpawnClaude.mockReturnValue({
				sessionId: undefined,
				claudeSessionId: undefined,
				done: Promise.resolve("failed" as const),
				activities: [],
				lastStderr: [],
				currentActivity: null,
				onText: vi.fn(),
				onResult: vi.fn(),
				kill: vi.fn(),
				forceKill: vi.fn(),
				writeStdin: vi.fn(),
			} as unknown as ReturnType<typeof spawnClaude>);
			const reviewer = new GitReviewer("Pet", "persona");
			const result = await reviewer.review(makeCommit(), "diff");
			expect(result).toContain("[GIT]");
			expect(result).toContain("(review unavailable)");
		});
	});
});
