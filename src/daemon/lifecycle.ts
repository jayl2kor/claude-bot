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
import { createBuiltinJobs, createGrowthReportJob } from "../cron/jobs.js";
import { CronService } from "../cron/service.js";
import { EvaluationPublisher } from "../evaluation/publisher.js";
import { EvaluationStore } from "../evaluation/store.js";
import { PeerEvaluator } from "../evaluation/evaluator.js";
import { GrowthCollector } from "../growth/collector.js";
import { FileReportHistoryStore } from "../growth/history-store.js";
import { GrowthReporter } from "../growth/reporter.js";
import { ActivityTracker } from "../memory/activity.js";
import { ChatHistoryManager } from "../memory/history.js";
import { KnowledgeManager } from "../memory/knowledge.js";
import { PersonaManager } from "../memory/persona.js";
import { ReflectionManager } from "../memory/reflection.js";
import { RelationshipManager } from "../memory/relationships.js";
import type { ChannelPlugin } from "../plugins/types.js";
import { SessionManager } from "../session/manager.js";
import { SessionStore } from "../session/store.js";
import { StatusReader } from "../status/reader.js";
import { StatusWriter } from "../status/writer.js";
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

		// 4. Initialize context builder (statusReader added after session manager)
		const sharedStatusDir = config.daemon.sharedStatusDir
			? resolve(config.daemon.sharedStatusDir)
			: undefined;
		const statusReader = sharedStatusDir
			? new StatusReader(sharedStatusDir, config.persona.name)
			: undefined;

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
		const plugins: ChannelPlugin[] = [];

		if (config.channels.discord) {
			plugins.push(createDiscordPlugin(config.channels.discord));
		}

		if (config.channels.telegram) {
			plugins.push(createTelegramPlugin(config.channels.telegram));
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

		// 8. Initialize teaching pipeline
		const integrator = new SessionIntegrator(
			knowledge,
			reflections,
			relationships,
		);

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
			persona: personaManager,
			knowledge,
			reflections,
			relationships,
			sessionStore,
			activityTracker,
			history,
			collaboration,
			evaluator: peerEvaluator,
			plugins,
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

		await cronService.start(signal);

		// 11. Write initial pointer
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

		// 10. Start pointer refresh interval
		const pointerInterval = setInterval(
			() => void writePointerState(),
			config.daemon.pointerRefreshMs,
		);

		logger.info("claude-pet daemon running", {
			channels: plugins.map((p) => p.id),
			persona: config.persona.name,
		});

		// 11. Wait for shutdown signal
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
