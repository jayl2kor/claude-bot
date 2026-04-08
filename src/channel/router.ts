/**
 * Message router — connects channel adapters to session manager.
 * Reference: OpenClaw src/gateway/ routing + Claude-code bridgeMain.ts
 *
 * Receives incoming messages, deduplicates, builds context,
 * routes to sessions, and sends responses back.
 */

import { buildAttachmentPrompt } from "../attachments/prompt.js";
import { handleMemorySearch } from "../commands/memory-search.js";
import type { ContextBuilder } from "../context/builder.js";
import type { ResultMessage } from "../executor/types.js";
import type { ActivityTracker } from "../memory/activity.js";
import type { ChatHistoryManager } from "../memory/history.js";
import type { KnowledgeManager } from "../memory/knowledge.js";
import type { ReflectionManager } from "../memory/reflection.js";
import type { RelationshipManager } from "../memory/relationships.js";
import { classifyMessage } from "../model/classifier.js";
import type { ModelStatsTracker } from "../model/stats.js";
import type { ChannelPlugin, IncomingMessage } from "../plugins/types.js";
import { BoundedUUIDSet } from "../session/dedup.js";
import type { SessionManager } from "../session/manager.js";
import { detectTeaching } from "../teaching/detector.js";
import { KnowledgeExtractor } from "../teaching/extractor.js";
import type { SessionIntegrator } from "../teaching/integrator.js";
import { logger } from "../utils/logger.js";

export type MessageRouterDeps = {
	sessionManager: SessionManager;
	contextBuilder: ContextBuilder;
	relationships: RelationshipManager;
	knowledge: KnowledgeManager;
	reflections: ReflectionManager;
	activityTracker: ActivityTracker;
	history: ChatHistoryManager;
	integrator: SessionIntegrator;
	plugins: ChannelPlugin[];
	smartModelSelection?: {
		enabled: boolean;
		statsTracker: ModelStatsTracker;
		defaultModel?: import("../model/types.js").ModelTier;
	};
};

export class MessageRouter {
	private readonly dedup = new BoundedUUIDSet(1000);

	constructor(private readonly deps: MessageRouterDeps) {}

	/** Wire up all channel plugins to the router. */
	start(): void {
		for (const plugin of this.deps.plugins) {
			plugin.onMessage((msg) => this.handleMessage(plugin, msg));
			logger.info("Router registered", { channel: plugin.id });
		}
	}

	/** Register slash commands on all plugins that support them. */
	async startCommands(): Promise<void> {
		const commands = [
			{
				name: "기억",
				description: "과거 대화와 지식을 검색합니다",
				options: [
					{
						name: "keyword",
						description: "검색할 키워드",
						type: "string" as const,
						required: true,
					},
				],
			},
		];

		for (const plugin of this.deps.plugins) {
			if (plugin.registerCommands) {
				await plugin.registerCommands(commands);
				plugin.onCommand?.((interaction) => this.handleCommand(interaction));
			}
		}
	}

	private async handleCommand(
		interaction: import("../plugins/types.js").CommandInteraction,
	): Promise<void> {
		if (interaction.commandName === "기억") {
			await handleMemorySearch(interaction, {
				knowledge: this.deps.knowledge,
				reflections: this.deps.reflections,
				relationships: this.deps.relationships,
			});
		}
	}

	private async handleMessage(
		plugin: ChannelPlugin,
		msg: IncomingMessage,
	): Promise<void> {
		// Dedup check
		if (this.dedup.has(msg.id)) return;
		this.dedup.add(msg.id);

		const attachmentCount = msg.attachments?.length ?? 0;
		logger.info("Message received", {
			channel: plugin.id,
			userId: msg.userId,
			userName: msg.userName,
			contentLength: msg.content.length,
			attachments: attachmentCount,
		});

		// Record activity for monitoring
		void this.deps.activityTracker
			.recordActivity(msg.userId, msg.timestamp)
			.catch(() => {});

		// Save incoming message to history
		void this.deps.history
			.append({
				messageId: msg.id,
				userId: msg.userId,
				userName: msg.userName,
				channelId: msg.channelId,
				content: msg.content,
				timestamp: msg.timestamp,
				isBot: false,
			})
			.catch(() => {});

		// Show typing indicator
		void plugin.sendTyping(msg.channelId).catch(() => {});

		// Record relationship (fire and forget)
		void this.deps.relationships.recordInteraction(msg.userId, msg.userName);

		// Real-time teaching detection — store immediately before session
		const intents = detectTeaching(msg.content);
		if (intents.length > 0) {
			const extractor = new KnowledgeExtractor(
				this.deps.knowledge,
				this.deps.relationships,
			);
			void extractor.extract(intents, msg.userId).catch((err) => {
				logger.warn("Inline teaching extraction failed", {
					error: String(err),
				});
			});
		}

		// Build system prompt with persona + memory + channel context
		const systemPrompt = await this.deps.contextBuilder.build(
			msg.userId,
			msg.channelId,
			msg.content,
			msg.recentMessages,
		);

		// Smart model selection (when enabled)
		let selectedModel: string | undefined;
		const sms = this.deps.smartModelSelection;
		if (sms?.enabled) {
			const sessionKey = `${msg.userId}:${msg.channelId}`;
			const cached = sms.statsTracker.getSessionModel(sessionKey);
			const classification = classifyMessage(msg.content, {
				userId: msg.userId,
				channelId: msg.channelId,
				timestamp: msg.timestamp,
				previousModel: cached?.model,
				previousTimestamp: cached?.timestamp,
				defaultModel: sms.defaultModel,
			});
			selectedModel = classification.tier;
			sms.statsTracker.setSessionModel(
				sessionKey,
				classification.tier,
				msg.timestamp,
			);
			void sms.statsTracker
				.record(classification.tier, classification.isOverride)
				.catch(() => {});
			logger.info("Model selected", {
				tier: classification.tier,
				confidence: classification.confidence,
				reason: classification.reason,
				isOverride: classification.isOverride,
			});
		}

		// Inject attachment file paths into user prompt (keeps them in user context, not system)
		const userPrompt = buildAttachmentPrompt(msg.content, msg.attachments);

		// Spawn a new session for every message
		const handle = await this.deps.sessionManager.getOrCreate(
			msg.userId,
			msg.channelId,
			userPrompt,
			systemPrompt,
			selectedModel,
		);

		if (!handle) {
			await plugin.sendMessage(
				msg.channelId,
				"형님, 지금 다른 작업 처리 중이라 이건 못 하겠습니다. 잠시 후 다시 말씀해주십시오!",
				msg.id,
			);
			return;
		}

		// Stream text responses as they arrive (don't wait for done)
		const sentTexts = new Set<string>();
		let lastSentText = "";

		handle.onText((text) => {
			if (text && !sentTexts.has(text)) {
				sentTexts.add(text);
				lastSentText = text;
				const replyTo = sentTexts.size === 1 ? msg.id : undefined;
				void plugin.sendMessage(msg.channelId, text, replyTo).catch((err) => {
					logger.warn("Failed to send streamed text", { error: String(err) });
				});
			}
		});

		// Also capture final result for integration
		let resultText = "";
		handle.onResult((result: ResultMessage) => {
			resultText = result.result;
		});

		// Wait for process to fully complete
		const status = await handle.done;

		// If onText never fired, fall back to result text
		if (sentTexts.size === 0 && status === "completed" && resultText) {
			await plugin.sendMessage(msg.channelId, resultText, msg.id);
			lastSentText = resultText;
		}

		if (status === "failed" && sentTexts.size === 0) {
			const errHint = handle.lastStderr.slice(-3).join("\n");
			logger.error("Session failed", { userId: msg.userId, stderr: errHint });
			await plugin.sendMessage(
				msg.channelId,
				"미안, 응답을 생성하는 중에 문제가 생겼어.",
				msg.id,
			);
		}

		// Save bot response to history
		const finalText = resultText || lastSentText;
		if (finalText) {
			void this.deps.history
				.append({
					messageId: `bot-${Date.now()}`,
					userId: "bot",
					userName: "pet",
					channelId: msg.channelId,
					content: finalText,
					timestamp: Date.now(),
					isBot: true,
				})
				.catch(() => {});
		}

		// Post-session integration (fire and forget)
		if (finalText) {
			const integrationKey = `${msg.userId}:${msg.channelId}`;
			void this.deps.integrator
				.integrate(
					integrationKey,
					msg.userId,
					`${msg.content}\n---\n${finalText}`,
				)
				.catch((err) => {
					logger.warn("Post-session integration failed", {
						error: String(err),
					});
				});
		}
	}
}
