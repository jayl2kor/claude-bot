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
import { ContextBuilder } from "../context/builder.js";
import { createBuiltinJobs } from "../cron/jobs.js";
import { CronService } from "../cron/service.js";
import { KnowledgeManager } from "../memory/knowledge.js";
import { PersonaManager } from "../memory/persona.js";
import { ReflectionManager } from "../memory/reflection.js";
import { RelationshipManager } from "../memory/relationships.js";
import type { ChannelPlugin } from "../plugins/types.js";
import { SessionManager } from "../session/manager.js";
import { SessionStore } from "../session/store.js";
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

		// 4. Initialize context builder
		const contextBuilder = new ContextBuilder({
			persona: personaManager,
			relationships,
			knowledge,
			reflections,
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
			integrator,
			plugins,
		});
		router.start();

		// 10. Initialize and start cron service
		const cronService = new CronService();
		for (const job of createBuiltinJobs({
			persona: personaManager,
			knowledge,
			reflections,
			relationships,
			sessionStore,
			plugins,
		})) {
			cronService.add(job);
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

		// Clear pointer on clean shutdown
		await pointer.clear();

		// Brief pause for pending writes
		await sleep(500);
	} finally {
		await lock.release();
	}

	logger.info("claude-pet daemon stopped");
}
