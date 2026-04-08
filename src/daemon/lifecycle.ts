/**
 * Daemon main lifecycle — bootstrap, run, shutdown.
 * Reference: Claude-code bridge/bridgeMain.ts runBridgeLoop()
 * Reference: OpenClaw src/cli/gateway-cli/run.ts
 */

import { resolve } from "node:path";
import { createCliPlugin } from "../channel/cli/plugin.js";
import { createDiscordPlugin } from "../channel/discord/plugin.js";
import { MessageRouter } from "../channel/router.js";
import { createTelegramPlugin } from "../channel/telegram/plugin.js";
import { CollaborationManager } from "../collaboration/manager.js";
import { ContextBuilder } from "../context/builder.js";
import { createBuiltinJobs, createGitWatcherJob, createGrowthReportJob } from "../cron/jobs.js";
import type { KnowledgeFeedDeps } from "../cron/jobs.js";
import { CronService } from "../cron/service.js";
import { DelegationBuilder } from "../expertise/defer.js";
import { ExpertiseDocLoader } from "../expertise/loader.js";
import { KnowledgeSeeder } from "../expertise/seeder.js";
import { EvaluationPublisher } from "../evaluation/publisher.js";
import { EvaluationStore } from "../evaluation/store.js";
import { PeerEvaluator } from "../evaluation/evaluator.js";
import { GitReviewer } from "../git/reviewer.js";
import { GitWatcher } from "../git/watcher.js";
import { GrowthCollector } from "../growth/collector.js";
import { FileReportHistoryStore } from "../growth/history-store.js";
import { GrowthReporter } from "../growth/reporter.js";
import { FeedStore } from "../knowledge-feed/feed-store.js";
import { FeedPublisher } from "../knowledge-feed/publisher.js";
import { FeedSubscriber } from "../knowledge-feed/subscriber.js";
import { ActivityTracker } from "../memory/activity.js";
import { ChatHistoryManager } from "../memory/history.js";
import { KnowledgeManager } from "../memory/knowledge.js";
import { PersonaManager } from "../memory/persona.js";
import { ReflectionManager } from "../memory/reflection.js";
import { RelationshipManager } from "../memory/relationships.js";
import { ModelStatsTracker } from "../model/stats.js";
import type { ChannelPlugin } from "../plugins/types.js";
import { SessionManager } from "../session/manager.js";
import { SessionStore } from "../session/store.js";
import { StatusReader } from "../status/reader.js";
import { StatusWriter } from "../status/writer.js";
import { StudyQueue } from "../study/queue.js";
import { TopicResearcher } from "../study/researcher.js";
import { SessionIntegrator } from "../teaching/integrator.js";
import type { AppConfig } from "../utils/config.js";
import { logger } from "../utils/logger.js";
import { sleep } from "../utils/sleep.js";
import { ProcessLock } from "./lock.js";
import { type DaemonPointer, PointerManager } from "./pointer.js";

export async function runDaemon(
	config: AppConfig,
	signal: AbortSignal,
	dataDir?: string,
	configDir?: string,
): Promise<void> {
	const DATA_DIR = dataDir ?? resolve("data");
	const lock = new ProcessLock(resolve(DATA_DIR, "state", "daemon.pid"));
	const pointer = new PointerManager(
		resolve(DATA_DIR, "state", "daemon-pointer.json"),
	);

	// 1. Acquire process lock
	await lock.acquire();
	logger.info("Process lock acquired");

	try {
		// Shared session store instance
		const sessionStore = new SessionStore(resolve(DATA_DIR, "sessions"));

		// 2. Check for crash recovery pointer
		const recoveredSessions: Array<{
			sessionKey: string;
			claudeSessionId?: string;
		}> = [];
		const existingPointer = await pointer.read();
		if (existingPointer) {
			logger.info("Found crash recovery pointer", {
				sessions: existingPointer.activeSessions.length,
				startedAt: new Date(existingPointer.startedAt).toISOString(),
			});
			for (const sess of existingPointer.activeSessions) {
				const record = await sessionStore.read(sess.sessionKey);
				if (record?.claudeSessionId) {
					recoveredSessions.push({
						sessionKey: sess.sessionKey,
						claudeSessionId: record.claudeSessionId,
					});
					logger.info("Session recoverable", {
						key: sess.sessionKey,
						claudeSessionId: record.claudeSessionId,
					});
				}
			}
			await pointer.clear();
		}

		// 3. Initialize memory managers
		const personaManager = new PersonaManager(
			config.persona,
			resolve(DATA_DIR, "memory"),
		);
		const relationships = new RelationshipManager(
			resolve(DATA_DIR, "memory", "relationships"),
		);
		const knowledge = new KnowledgeManager(
			resolve(DATA_DIR, "memory", "knowledge"),
		);
		const reflections = new ReflectionManager(
			resolve(DATA_DIR, "memory", "reflections"),
		);
		const activityTracker = new ActivityTracker(
			resolve(DATA_DIR, "memory", "activity"),
		);
		const history = new ChatHistoryManager(
			resolve(DATA_DIR, "memory", "history"),
		);

		// 4. Initialize expertise system
		const CONFIG_DIR = configDir ?? resolve("config");
		const expertiseDocLoader = new ExpertiseDocLoader(
			resolve(CONFIG_DIR, "expertise"),
		);

		// Run knowledge seeder at boot
		const seeder = new KnowledgeSeeder(
			resolve(CONFIG_DIR, "seed-knowledge"),
			DATA_DIR,
			knowledge,
		);
		const seededCount = await seeder.seed();
		if (seededCount > 0) {
			logger.info("Knowledge seeder imported entries", {
				count: seededCount,
			});
		}

		// 5. Initialize context builder
		const sharedStatusDir = config.daemon.sharedStatusDir
			? resolve(config.daemon.sharedStatusDir)
			: undefined;
		const statusReader = sharedStatusDir
			? new StatusReader(sharedStatusDir, config.persona.name)
			: undefined;

		const delegationBuilder = new DelegationBuilder(
			config.expertise.deferTo,
			statusReader,
		);

		// Resolve knowledge.md path from config directory
		const knowledgeFilePath = configDir
			? resolve(configDir, "knowledge.md")
			: undefined;

		const contextBuilder = new ContextBuilder({
			persona: personaManager,
			relationships,
			knowledge,
			history,
			reflections,
			statusReader,
			knowledgeFilePath,
			expertiseDocLoader,
			delegationBuilder,
		});

		// 5. Initialize session manager
		const sessionManager = new SessionManager({
			maxConcurrentSessions: config.daemon.maxConcurrentSessions,
			sessionTimeoutMs: config.daemon.sessionTimeoutMs,
			claudeModel: config.daemon.claudeModel,
			maxTurns: config.daemon.maxTurns,
			skipPermissions: config.daemon.skipPermissions,
			storeDir: resolve(DATA_DIR, "sessions"),
			workspacePath: config.daemon.workspacePath,
		});

		// 5b. Initialize status writer (optional)
		const statusWriter = sharedStatusDir
			? new StatusWriter(
					sharedStatusDir,
					config.persona.name,
					config.persona.name,
					sessionManager,
				)
			: undefined;

		// 6. Initialize channel plugins
		const attachmentConfig = config.daemon.attachments;
		const uploadDir = resolve(DATA_DIR, "uploads");
		const plugins: ChannelPlugin[] = [];

		if (config.channels.discord) {
			plugins.push(
				createDiscordPlugin({
					...config.channels.discord,
					uploadDir,
					maxFileSizeMb: attachmentConfig.maxFileSizeMb,
					maxTotalSizeMb: attachmentConfig.maxTotalSizeMb,
				}),
			);
		}

		if (config.channels.telegram) {
			plugins.push(
				createTelegramPlugin({
					...config.channels.telegram,
					uploadDir,
					maxFileSizeMb: attachmentConfig.maxFileSizeMb,
					maxTotalSizeMb: attachmentConfig.maxTotalSizeMb,
				}),
			);
		}

		// Fallback to CLI mode if no external channels configured
		if (plugins.length === 0) {
			logger.info("No external channels configured, starting in CLI mode");
			plugins.push(createCliPlugin());
		}

		// 7. Connect all channels
		for (const plugin of plugins) {
			await plugin.connect();
			logger.info("Channel connected", { channel: plugin.id });
		}

		// 8. Initialize knowledge feed (optional)
		const feedConfig = config.daemon.knowledgeFeed;
		let feedPublisher: FeedPublisher | undefined;
		let knowledgeFeedDeps: KnowledgeFeedDeps | undefined;

		if (feedConfig?.enabled) {
			const feedSharedDir = resolve(
				feedConfig.sharedDir ??
					resolve(DATA_DIR, "..", "shared", "knowledge-feed"),
			);
			const feedStore = new FeedStore(feedSharedDir);
			feedPublisher = new FeedPublisher(feedStore, config.persona.name);
			const feedSubscriber = new FeedSubscriber({
				feedStore,
				knowledge,
				petId: config.persona.name,
				stateDir: resolve(DATA_DIR, "state"),
				confidenceMultiplier: feedConfig.confidenceMultiplier,
			});
			knowledgeFeedDeps = {
				feedStore,
				feedSubscriber,
				pollIntervalMs: feedConfig.pollIntervalMs,
				ttlMs: feedConfig.ttlMs,
			};
			logger.info("Knowledge feed enabled", {
				sharedDir: feedSharedDir,
				pollIntervalMs: feedConfig.pollIntervalMs,
				confidenceMultiplier: feedConfig.confidenceMultiplier,
			});
		}

		// 8a. Initialize teaching pipeline
		const integrator = new SessionIntegrator(
			knowledge,
			reflections,
			relationships,
			feedPublisher,
		);

		// 8c. Initialize smart model selection (optional)
		// ModelStatsTracker is only instantiated when smartModelSelection is enabled
		// to avoid creating unnecessary directories when the feature is disabled.
		const smsConfig = config.daemon.smartModelSelection;
		const smartModelSelection = smsConfig.enabled
			? {
					enabled: true as const,
					statsTracker: new ModelStatsTracker(
						resolve(DATA_DIR, "model-stats"),
					),
					defaultModel: smsConfig.defaultModel,
				}
			: undefined;

		if (smsConfig.enabled) {
			logger.info("Smart model selection enabled", {
				defaultModel: smsConfig.defaultModel,
			});
		}

		// 8c. Initialize study queue (optional)
		const studyConfig = config.daemon.study;
		let studyQueue: StudyQueue | undefined;
		if (studyConfig.enabled) {
			studyQueue = new StudyQueue(studyConfig, resolve(DATA_DIR, "study"));
			const researcher = new TopicResearcher(studyConfig, knowledge);
			studyQueue.setResearcher(researcher);

			// Wire notification to all channel plugins
			studyQueue.setNotifyFn((topic, result, error) => {
				const message = error
					? `"${topic}" 공부하다가 문제가 생겼어요: ${error}`
					: `"${topic}" 공부 완료! ${result?.subtopics.length ?? 0}개의 서브토픽을 학습했습니다.`;
				for (const p of plugins) {
					void p.sendMessage("", message).catch(() => {});
				}
			});

			logger.info("Study feature enabled", {
				maxDailySessions: studyConfig.maxDailySessions,
				model: studyConfig.model,
			});
		}

		// 9. Wire up message router
		const router = new MessageRouter({
			sessionManager,
			contextBuilder,
			relationships,
			knowledge,
			reflections,
			activityTracker,
			history,
			integrator,
			plugins,
			studyQueue,
			smartModelSelection,
		});
		router.start();
		await router.startCommands();

		// 10. Initialize collaboration (optional)
		const collabConfig = config.daemon.collaboration;
		const collaboration = collabConfig.enabled
			? new CollaborationManager({
					petId: config.persona.name,
					role: collabConfig.role,
					sharedDir: resolve(
						collabConfig.sharedDir ??
							resolve(DATA_DIR, "..", "shared", "tasks"),
					),
					skipPermissions: config.daemon.skipPermissions,
					model: config.daemon.claudeModel,
				})
			: undefined;

		// 11. Initialize evaluation (optional)
		const evalConfig = config.daemon.evaluation;
		let evaluationPublisher: EvaluationPublisher | undefined;
		let peerEvaluator: PeerEvaluator | undefined;
		if (evalConfig.enabled) {
			const evalSharedDir = resolve(
				evalConfig.sharedDir ?? resolve(DATA_DIR, "..", "shared", "evaluations"),
			);
			const evalStore = new EvaluationStore(evalSharedDir);
			evaluationPublisher = new EvaluationPublisher(
				config.persona.name,
				evalSharedDir,
				evalConfig.probability,
				evalConfig.maxPendingCount,
			);
			peerEvaluator = new PeerEvaluator(config.persona.name, evalStore);
			logger.info("Peer evaluation enabled", {
				sharedDir: evalSharedDir,
				probability: evalConfig.probability,
			});
		}

		// Wire onDone callback on sessionManager to trigger evaluation publishing
		if (evaluationPublisher) {
			const publisher = evaluationPublisher;
			sessionManager.onDone((sessionKey, status) => {
				if (status !== "completed") return;
				// Extract userId:channelId from potentially timestamped key
				const parts = sessionKey.split(":");
				const userId = parts[0];
				const channelId = parts[1];
				if (!userId || !channelId) {
					logger.warn("EvaluationPublisher: skipped — malformed sessionKey", { sessionKey });
					return;
				}
				void publisher.maybePublish(sessionKey, userId, channelId, history);
			});
		}

		// 12. Initialize and start cron service
		const cronService = new CronService();
		for (const job of createBuiltinJobs({
			petId: config.persona.name,
			persona: personaManager,
			knowledge,
			reflections,
			relationships,
			sessionStore,
			activityTracker,
			history,
			collaboration,
			knowledgeFeed: knowledgeFeedDeps,
			evaluator: peerEvaluator,
			plugins,
			uploadDir,
			attachmentRetentionDays: attachmentConfig.retentionDays,
			expertiseConfig: config.expertise,
		})) {
			cronService.add(job);
		}
		if (statusWriter) {
			cronService.add({
				id: "status-heartbeat",
				intervalMs: 15_000,
				runOnStart: true,
				handler: () => statusWriter.write(),
			});
		}

		// 11b. Growth report cron job (optional, disabled by default)
		const growthReportConfig = config.daemon.growthReport;
		if (growthReportConfig.enabled) {
			const growthCollector = new GrowthCollector({
				knowledge,
				relationships,
				reflections,
				sessionStore,
				activityTracker,
				persona: personaManager,
			});
			const growthHistoryStore = new FileReportHistoryStore(
				resolve(DATA_DIR, "memory", "growth-reports"),
			);
			const growthReporter = new GrowthReporter({
				personaName: config.persona.name,
				language: growthReportConfig.language,
				historyStore: growthHistoryStore,
			});
			const growthJob = createGrowthReportJob({
				growthReportConfig,
				collector: growthCollector,
				reporter: growthReporter,
				plugins,
			});
			if (growthJob) {
				cronService.add(growthJob);
				logger.info("Growth report job registered", {
					intervalMs: growthReportConfig.intervalMs,
					channelId: growthReportConfig.channelId,
				});
			}
		}

		// 11c. Git watcher cron job (optional, disabled by default)
		const gitWatcherConfig = config.daemon.gitWatcher;
		if (gitWatcherConfig.enabled && config.daemon.workspacePath) {
			if (!gitWatcherConfig.reviewChannelId) {
				logger.warn(
					"GitWatcher: reviewChannelId is empty — reviews will not be delivered. Set daemon.gitWatcher.reviewChannelId in your config.",
				);
			}

			const gitWatcher = new GitWatcher(
				config.daemon.workspacePath,
				gitWatcherConfig,
				resolve(DATA_DIR, "state"),
			);
			await gitWatcher.init();

			const gitReviewer = new GitReviewer(
				config.persona.name,
				config.persona.personality,
			);

			const gitWatcherJob = createGitWatcherJob({
				watcher: gitWatcher,
				reviewer: gitReviewer,
				plugins,
				reviewChannelId: gitWatcherConfig.reviewChannelId,
				pollIntervalMs: gitWatcherConfig.pollIntervalMs,
			});
			if (gitWatcherJob) {
				cronService.add(gitWatcherJob);
				logger.info("Git watcher job registered", {
					branches: gitWatcherConfig.branches,
					pollIntervalMs: gitWatcherConfig.pollIntervalMs,
				});
			}
		}

		await cronService.start(signal);

		// 12. Write initial pointer
		const writePointerState = async () => {
			const p: DaemonPointer = {
				activeSessions: sessionManager.getActiveSessionKeys().map((key) => {
					const [userId, channelId] = key.split(":");
					return {
						sessionKey: key,
						channelId: channelId ?? "",
						userId: userId ?? "",
					};
				}),
				startedAt: Date.now(),
				pid: process.pid,
			};
			await pointer.write(p);
		};
		await writePointerState();

		// 13. Start pointer refresh interval
		const pointerInterval = setInterval(
			() => void writePointerState(),
			config.daemon.pointerRefreshMs,
		);

		logger.info("claude-pet daemon running", {
			channels: plugins.map((p) => p.id),
			persona: config.persona.name,
		});

		// 14. Wait for shutdown signal
		await new Promise<void>((resolve) => {
			if (signal.aborted) return resolve();
			signal.addEventListener("abort", () => resolve(), { once: true });
		});

		// 12. Graceful shutdown
		logger.info("Shutting down...");
		clearInterval(pointerInterval);

		// Stop cron jobs first (no new background work)
		await cronService.stop();

		// Disconnect channels (stop receiving new messages)
		for (const plugin of plugins) {
			await plugin.disconnect();
		}

		// Then shutdown sessions (SIGTERM → wait → SIGKILL)
		await sessionManager.shutdown();

		// Clear pointer and status on clean shutdown
		await pointer.clear();
		await statusWriter?.clear();

		// Brief pause for pending writes
		await sleep(500);
	} finally {
		await lock.release();
	}

	logger.info("claude-pet daemon stopped");
}
