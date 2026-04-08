/**
 * Tests for runDaemon lifecycle — covers:
 * - Plugin selection (discord, telegram, CLI fallback)
 * - Crash recovery pointer reading
 * - Graceful shutdown sequence
 * - Process lock acquire/release
 * - Pointer write and clear on clean shutdown
 *
 * All heavy dependencies are mocked to keep tests unit-level.
 */

import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks — declared before any imports that would pull in the modules
// ---------------------------------------------------------------------------

vi.mock("../channel/cli/plugin.js", () => ({
	createCliPlugin: vi.fn(() => ({
		id: "cli",
		meta: { label: "CLI", textChunkLimit: 4000 },
		connect: vi.fn(async () => {}),
		onMessage: vi.fn(),
		sendMessage: vi.fn(async () => {}),
		sendTyping: vi.fn(async () => {}),
		disconnect: vi.fn(async () => {}),
	})),
}));

vi.mock("../channel/discord/plugin.js", () => ({
	createDiscordPlugin: vi.fn(() => ({
		id: "discord",
		meta: { label: "Discord", textChunkLimit: 2000 },
		connect: vi.fn(async () => {}),
		onMessage: vi.fn(),
		sendMessage: vi.fn(async () => {}),
		sendTyping: vi.fn(async () => {}),
		disconnect: vi.fn(async () => {}),
	})),
}));

vi.mock("../channel/telegram/plugin.js", () => ({
	createTelegramPlugin: vi.fn(() => ({
		id: "telegram",
		meta: { label: "Telegram", textChunkLimit: 4096 },
		connect: vi.fn(async () => {}),
		onMessage: vi.fn(),
		sendMessage: vi.fn(async () => {}),
		sendTyping: vi.fn(async () => {}),
		disconnect: vi.fn(async () => {}),
	})),
}));

vi.mock("../channel/router.js", () => ({
	MessageRouter: vi.fn().mockImplementation(() => ({
		start: vi.fn(),
		startCommands: vi.fn(async () => {}),
	})),
}));

vi.mock("../context/builder.js", () => ({
	ContextBuilder: vi.fn().mockImplementation(() => ({
		build: vi.fn(async () => ""),
	})),
}));

vi.mock("../cron/jobs.js", () => ({
	createBuiltinJobs: vi.fn(() => []),
	createGrowthReportJob: vi.fn(() => null),
	createGitWatcherJob: vi.fn(() => null),
}));

vi.mock("../knowledge-feed/feed-store.js", () => ({
	FeedStore: vi.fn().mockImplementation(() => ({})),
}));

vi.mock("../knowledge-feed/publisher.js", () => ({
	FeedPublisher: vi.fn().mockImplementation(() => ({
		publish: vi.fn(async () => null),
	})),
}));

vi.mock("../knowledge-feed/subscriber.js", () => ({
	FeedSubscriber: vi.fn().mockImplementation(() => ({
		poll: vi.fn(async () => ({ imported: 0, skipped: 0 })),
	})),
}));

vi.mock("../cron/service.js", () => ({
	CronService: vi.fn().mockImplementation(() => ({
		add: vi.fn(),
		start: vi.fn(async () => {}),
		stop: vi.fn(async () => {}),
	})),
}));

vi.mock("../memory/knowledge.js", () => ({
	KnowledgeManager: vi.fn().mockImplementation(() => ({})),
}));

vi.mock("../memory/persona.js", () => ({
	PersonaManager: vi.fn().mockImplementation(() => ({})),
}));

vi.mock("../memory/reflection.js", () => ({
	ReflectionManager: vi.fn().mockImplementation(() => ({})),
}));

vi.mock("../memory/relationships.js", () => ({
	RelationshipManager: vi.fn().mockImplementation(() => ({})),
}));

vi.mock("../session/manager.js", () => ({
	SessionManager: vi.fn().mockImplementation(() => ({
		getOrCreate: vi.fn(async () => null),
		getActiveSessionKeys: vi.fn(() => []),
		shutdown: vi.fn(async () => {}),
		onDone: vi.fn(),
	})),
}));

vi.mock("../session/store.js", () => ({
	SessionStore: vi.fn().mockImplementation(() => ({
		read: vi.fn(async () => null),
		write: vi.fn(async () => {}),
		delete: vi.fn(async () => {}),
		list: vi.fn(async () => []),
	})),
}));

vi.mock("../teaching/integrator.js", () => ({
	SessionIntegrator: vi.fn().mockImplementation(() => ({
		integrate: vi.fn(async () => {}),
	})),
}));

vi.mock("../expertise/loader.js", () => ({
	ExpertiseDocLoader: vi.fn().mockImplementation(() => ({
		toPromptSection: vi.fn(async () => null),
	})),
}));

vi.mock("../expertise/seeder.js", () => ({
	KnowledgeSeeder: vi.fn().mockImplementation(() => ({
		seed: vi.fn(async () => 0),
	})),
}));

vi.mock("../expertise/defer.js", () => ({
	DelegationBuilder: vi.fn().mockImplementation(() => ({
		toPromptSection: vi.fn(async () => null),
	})),
}));

vi.mock("../evaluation/publisher.js", () => ({
	EvaluationPublisher: vi.fn().mockImplementation(() => ({
		maybePublish: vi.fn(async () => {}),
	})),
}));

vi.mock("../evaluation/store.js", () => ({
	EvaluationStore: vi.fn().mockImplementation(() => ({})),
}));

vi.mock("../evaluation/evaluator.js", () => ({
	PeerEvaluator: vi.fn().mockImplementation(() => ({
		evaluate: vi.fn(async () => {}),
	})),
}));

vi.mock("../git/watcher.js", () => ({
	GitWatcher: vi.fn().mockImplementation(() => ({
		init: vi.fn(async () => {}),
		isActive: false,
		getState: vi.fn(() => ({ lastCheckedSha: {} })),
		poll: vi.fn(async () => []),
		getDiff: vi.fn(async () => ""),
		isRateLimited: vi.fn(() => false),
		recordReview: vi.fn(),
		persistState: vi.fn(async () => {}),
	})),
}));

vi.mock("../git/reviewer.js", () => ({
	GitReviewer: vi.fn().mockImplementation(() => ({
		review: vi.fn(async () => ""),
		sendReview: vi.fn(async () => {}),
	})),
}));

vi.mock("../growth/collector.js", () => ({
	GrowthCollector: vi.fn().mockImplementation(() => ({
		collect: vi.fn(async () => ({})),
	})),
}));

vi.mock("../growth/history-store.js", () => ({
	FileReportHistoryStore: vi.fn().mockImplementation(() => ({})),
}));

vi.mock("../growth/reporter.js", () => ({
	GrowthReporter: vi.fn().mockImplementation(() => ({
		generateReport: vi.fn(async () => ({})),
		getLatestHistory: vi.fn(async () => null),
		saveHistory: vi.fn(async () => {}),
		sendToChannel: vi.fn(async () => {}),
	})),
}));

vi.mock("../model/stats.js", () => ({
	ModelStatsTracker: vi.fn().mockImplementation(() => ({
		getSessionModel: vi.fn(() => undefined),
		setSessionModel: vi.fn(),
		record: vi.fn(async () => {}),
	})),
}));

vi.mock("../study/queue.js", () => ({
	StudyQueue: vi.fn().mockImplementation(() => ({
		setResearcher: vi.fn(),
		setNotifyFn: vi.fn(),
		enqueue: vi.fn(async () => ({ success: true })),
		getState: vi.fn(async () => ({
			requests: [],
			dailyCount: 0,
			dailyResetAt: 0,
		})),
	})),
}));

vi.mock("../study/researcher.js", () => ({
	TopicResearcher: vi.fn().mockImplementation(() => ({
		research: vi.fn(async () => ({ subtopics: [], knowledgeIds: [] })),
	})),
}));

vi.mock("../utils/sleep.js", () => ({
	sleep: vi.fn(async () => {}),
}));

vi.mock("./lock.js", () => ({
	ProcessLock: vi.fn().mockImplementation(() => ({
		acquire: vi.fn(async () => {}),
		release: vi.fn(async () => {}),
	})),
}));

vi.mock("./pointer.js", () => ({
	PointerManager: vi.fn().mockImplementation(() => ({
		read: vi.fn(async () => null),
		write: vi.fn(async () => {}),
		clear: vi.fn(async () => {}),
	})),
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import type { AppConfig } from "../utils/config.js";
import { runDaemon } from "./lifecycle.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
	return {
		persona: {
			name: "TestPet",
			personality: "friendly",
			tone: "casual",
			values: [],
			constraints: [],
		},
		channels: {},
		daemon: {
			maxConcurrentSessions: 5,
			sessionTimeoutMs: 60_000,
			pointerRefreshMs: 300_000,
			claudeModel: "sonnet",
			maxTurns: 10,
			skipPermissions: false,
			git: { enabled: false, autoSync: false },
			gitWatcher: { enabled: false, branches: ["main"], pollIntervalMs: 60000, maxReviewsPerHour: 5, ignoreAuthors: [], reviewChannelId: "", maxDiffChars: 4000 },
			collaboration: { enabled: false, role: "general" },
			smartModelSelection: { enabled: false, defaultModel: "sonnet" },
			growthReport: { enabled: false, intervalMs: 604_800_000, language: "ko" },
			knowledgeFeed: { enabled: false, pollIntervalMs: 30_000, ttlMs: 604_800_000, confidenceMultiplier: 0.7 },
			study: {
				enabled: false,
				maxDailySessions: 5,
				maxSubTopics: 8,
				model: "sonnet",
				maxTurns: 3,
			},
			evaluation: { enabled: false, probability: 0.3, maxPendingCount: 5 },
		},
		expertise: {
			domains: [],
			decayMultiplier: 0.3,
			deferTo: {},
		},
		...overrides,
	};
}

function makeAbortController(): { signal: AbortSignal; abort: () => void } {
	const ctrl = new AbortController();
	return { signal: ctrl.signal, abort: () => ctrl.abort() };
}

/**
 * Aborts the controller on the next event loop tick so that runDaemon has time
 * to set up its abort listener before the signal fires.
 */
function abortNextTick(abort: () => void): void {
	setImmediate(abort);
}

async function makeTempDataDir(): Promise<string> {
	const dir = join(tmpdir(), `claude-pet-lifecycle-test-${randomUUID()}`);
	await mkdir(dir, { recursive: true });
	return dir;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runDaemon — CLI fallback", () => {
	it("starts in CLI mode when no channels configured", async () => {
		const { createCliPlugin } = await import("../channel/cli/plugin.js");
		const dataDir = await makeTempDataDir();
		const { signal, abort } = makeAbortController();

		const config = makeConfig({ channels: {} });

		const runPromise = runDaemon(config, signal, dataDir);
		// Abort on next tick so the abort listener is set up first
		abortNextTick(abort);
		await runPromise;

		expect(createCliPlugin).toHaveBeenCalledTimes(1);
	});
});

describe("runDaemon — Discord channel", () => {
	it("initializes discord plugin when discord config present", async () => {
		const { createDiscordPlugin } = await import(
			"../channel/discord/plugin.js"
		);
		const { createCliPlugin } = await import("../channel/cli/plugin.js");
		vi.mocked(createDiscordPlugin).mockClear();
		vi.mocked(createCliPlugin).mockClear();

		const dataDir = await makeTempDataDir();
		const { signal, abort } = makeAbortController();

		const config = makeConfig({
			channels: { discord: { token: "discord-token", respondTo: "both" } },
		});

		const runPromise = runDaemon(config, signal, dataDir);
		abortNextTick(abort);
		await runPromise;

		expect(createDiscordPlugin).toHaveBeenCalledTimes(1);
		expect(createCliPlugin).not.toHaveBeenCalled();
	});
});

describe("runDaemon — Telegram channel", () => {
	it("initializes telegram plugin when telegram config present", async () => {
		const { createTelegramPlugin } = await import(
			"../channel/telegram/plugin.js"
		);
		const { createCliPlugin } = await import("../channel/cli/plugin.js");
		vi.mocked(createTelegramPlugin).mockClear();
		vi.mocked(createCliPlugin).mockClear();

		const dataDir = await makeTempDataDir();
		const { signal, abort } = makeAbortController();

		const config = makeConfig({
			channels: { telegram: { token: "tg-token" } },
		});

		const runPromise = runDaemon(config, signal, dataDir);
		abortNextTick(abort);
		await runPromise;

		expect(createTelegramPlugin).toHaveBeenCalledTimes(1);
		expect(createCliPlugin).not.toHaveBeenCalled();
	});
});

describe("runDaemon — crash recovery pointer", () => {
	it("reads existing pointer and clears it on startup", async () => {
		const { PointerManager } = await import("./pointer.js");

		const existingPointer = {
			activeSessions: [{ sessionKey: "u1:c1", channelId: "c1", userId: "u1" }],
			startedAt: Date.now() - 5000,
			pid: 99999,
		};

		const readMock = vi.fn(async () => existingPointer);
		const clearMock = vi.fn(async () => {});
		const writeMock = vi.fn(async () => {});

		vi.mocked(PointerManager).mockImplementationOnce(() => ({
			read: readMock,
			write: writeMock,
			clear: clearMock,
		}));

		const dataDir = await makeTempDataDir();
		const { signal, abort } = makeAbortController();

		const config = makeConfig({ channels: {} });
		const runPromise = runDaemon(config, signal, dataDir);
		abortNextTick(abort);
		await runPromise;

		expect(readMock).toHaveBeenCalled();
		// pointer.clear() called after reading recovery pointer AND after clean shutdown
		expect(clearMock).toHaveBeenCalled();
	});

	it("handles no existing pointer gracefully", async () => {
		const { PointerManager } = await import("./pointer.js");

		const readMock = vi.fn(async () => null);
		vi.mocked(PointerManager).mockImplementationOnce(() => ({
			read: readMock,
			write: vi.fn(async () => {}),
			clear: vi.fn(async () => {}),
		}));

		const dataDir = await makeTempDataDir();
		const { signal, abort } = makeAbortController();

		const config = makeConfig({ channels: {} });
		const runPromise = runDaemon(config, signal, dataDir);
		abortNextTick(abort);
		await runPromise;

		expect(readMock).toHaveBeenCalled();
	});
});

describe("runDaemon — process lock", () => {
	it("acquires and releases process lock", async () => {
		const { ProcessLock } = await import("./lock.js");

		const acquireMock = vi.fn(async () => {});
		const releaseMock = vi.fn(async () => {});

		vi.mocked(ProcessLock).mockImplementationOnce(() => ({
			acquire: acquireMock,
			release: releaseMock,
		}));

		const dataDir = await makeTempDataDir();
		const { signal, abort } = makeAbortController();

		const config = makeConfig({ channels: {} });
		const runPromise = runDaemon(config, signal, dataDir);
		abortNextTick(abort);
		await runPromise;

		expect(acquireMock).toHaveBeenCalledTimes(1);
		expect(releaseMock).toHaveBeenCalledTimes(1);
	});

	it("releases lock even if an error occurs during startup", async () => {
		const { ProcessLock } = await import("./lock.js");
		const { PointerManager } = await import("./pointer.js");

		const releaseMock = vi.fn(async () => {});
		vi.mocked(ProcessLock).mockImplementationOnce(() => ({
			acquire: vi.fn(async () => {}),
			release: releaseMock,
		}));

		// Force pointer.write to throw to simulate startup error
		vi.mocked(PointerManager).mockImplementationOnce(() => ({
			read: vi.fn(async () => null),
			write: vi.fn(async () => {
				throw new Error("write error");
			}),
			clear: vi.fn(async () => {}),
		}));

		const dataDir = await makeTempDataDir();
		const { signal, abort } = makeAbortController();

		const config = makeConfig({ channels: {} });

		await expect(runDaemon(config, signal, dataDir)).rejects.toThrow(
			"write error",
		);
		expect(releaseMock).toHaveBeenCalledTimes(1);
	});
});

describe("runDaemon — shutdown sequence", () => {
	it("calls disconnect on all plugins during shutdown", async () => {
		const { createCliPlugin } = await import("../channel/cli/plugin.js");
		vi.mocked(createCliPlugin).mockClear();

		const disconnectMock = vi.fn(async () => {});
		vi.mocked(createCliPlugin).mockReturnValueOnce({
			id: "cli",
			meta: { label: "CLI", textChunkLimit: 4000 },
			connect: vi.fn(async () => {}),
			onMessage: vi.fn(),
			sendMessage: vi.fn(async () => {}),
			sendTyping: vi.fn(async () => {}),
			disconnect: disconnectMock,
		});

		const dataDir = await makeTempDataDir();
		const { signal, abort } = makeAbortController();

		const config = makeConfig({ channels: {} });
		const runPromise = runDaemon(config, signal, dataDir);
		abortNextTick(abort);
		await runPromise;

		expect(disconnectMock).toHaveBeenCalledTimes(1);
	});

	it("calls sessionManager.shutdown during shutdown", async () => {
		const { SessionManager } = await import("../session/manager.js");

		const shutdownMock = vi.fn(async () => {});
		vi.mocked(SessionManager).mockImplementationOnce(() => ({
			getOrCreate: vi.fn(async () => null),
			getActiveSessionKeys: vi.fn(() => []),
			shutdown: shutdownMock,
			onDone: vi.fn(),
		}));

		const dataDir = await makeTempDataDir();
		const { signal, abort } = makeAbortController();

		const config = makeConfig({ channels: {} });
		const runPromise = runDaemon(config, signal, dataDir);
		abortNextTick(abort);
		await runPromise;

		expect(shutdownMock).toHaveBeenCalledTimes(1);
	});

	it("clears pointer on clean shutdown", async () => {
		const { PointerManager } = await import("./pointer.js");

		const clearMock = vi.fn(async () => {});
		vi.mocked(PointerManager).mockImplementationOnce(() => ({
			read: vi.fn(async () => null),
			write: vi.fn(async () => {}),
			clear: clearMock,
		}));

		const dataDir = await makeTempDataDir();
		const { signal, abort } = makeAbortController();

		const config = makeConfig({ channels: {} });
		const runPromise = runDaemon(config, signal, dataDir);
		abortNextTick(abort);
		await runPromise;

		expect(clearMock).toHaveBeenCalled();
	});

	it("stops cron service before disconnecting channels", async () => {
		const { CronService } = await import("../cron/service.js");

		const order: string[] = [];
		const stopMock = vi.fn(async () => {
			order.push("cron-stop");
		});
		const { createCliPlugin } = await import("../channel/cli/plugin.js");
		const disconnectMock = vi.fn(async () => {
			order.push("plugin-disconnect");
		});

		vi.mocked(CronService).mockImplementationOnce(() => ({
			add: vi.fn(),
			start: vi.fn(async () => {}),
			stop: stopMock,
		}));

		vi.mocked(createCliPlugin).mockReturnValueOnce({
			id: "cli",
			meta: { label: "CLI", textChunkLimit: 4000 },
			connect: vi.fn(async () => {}),
			onMessage: vi.fn(),
			sendMessage: vi.fn(async () => {}),
			sendTyping: vi.fn(async () => {}),
			disconnect: disconnectMock,
		});

		const dataDir = await makeTempDataDir();
		const { signal, abort } = makeAbortController();

		const config = makeConfig({ channels: {} });
		const runPromise = runDaemon(config, signal, dataDir);
		abortNextTick(abort);
		await runPromise;

		expect(order.indexOf("cron-stop")).toBeLessThan(
			order.indexOf("plugin-disconnect"),
		);
	});
});

describe("runDaemon — pointer refresh interval", () => {
	it("writes pointer immediately after startup", async () => {
		const { PointerManager } = await import("./pointer.js");

		const writeMock = vi.fn(async () => {});
		vi.mocked(PointerManager).mockImplementationOnce(() => ({
			read: vi.fn(async () => null),
			write: writeMock,
			clear: vi.fn(async () => {}),
		}));

		const dataDir = await makeTempDataDir();
		const { signal, abort } = makeAbortController();

		const config = makeConfig({ channels: {} });
		const runPromise = runDaemon(config, signal, dataDir);
		abortNextTick(abort);
		await runPromise;

		// write() called at least once for initial pointer write
		expect(writeMock).toHaveBeenCalled();
	});
});
