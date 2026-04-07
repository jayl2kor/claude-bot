/**
 * Message router — connects channel adapters to session manager.
 * Reference: OpenClaw src/gateway/ routing + Claude-code bridgeMain.ts
 *
 * Receives incoming messages, deduplicates, builds context,
 * routes to sessions, and sends responses back.
 */

import type { ContextBuilder } from "../context/builder.js";
import type { ResultMessage } from "../executor/types.js";
import type { KnowledgeManager } from "../memory/knowledge.js";
import type { RelationshipManager } from "../memory/relationships.js";
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
	integrator: SessionIntegrator;
	plugins: ChannelPlugin[];
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

	private async handleMessage(
		plugin: ChannelPlugin,
		msg: IncomingMessage,
	): Promise<void> {
		// Dedup check
		if (this.dedup.has(msg.id)) return;
		this.dedup.add(msg.id);

		logger.info("Message received", {
			channel: plugin.id,
			userId: msg.userId,
			userName: msg.userName,
			contentLength: msg.content.length,
		});

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

		// Build system prompt with persona + memory
		const systemPrompt = await this.deps.contextBuilder.build(
			msg.userId,
			msg.channelId,
			msg.content,
		);

		// Check if already processing a message for this user+channel
		const sessionKey = `${msg.userId}:${msg.channelId}`;
		if (this.deps.sessionManager.isActive(sessionKey)) {
			await plugin.sendMessage(
				msg.channelId,
				"형님, 지금 이전 요청 처리 중입니다! 잠시만 기다려주십시오 🫡",
				msg.id,
			);
			return;
		}

		// Get or create session
		const handle = await this.deps.sessionManager.getOrCreate(
			msg.userId,
			msg.channelId,
			msg.content,
			systemPrompt,
		);

		if (!handle) {
			await plugin.sendMessage(
				msg.channelId,
				"형님, 지금 다른 분 요청을 처리하고 있어서 용량이 꽉 찼습니다. 잠시 후 다시 말씀해주십시오!",
				msg.id,
			);
			return;
		}

		// Stream text responses as they arrive (don't wait for done)
		const sentTexts: string[] = [];

		handle.onText((text) => {
			// Only send if we have genuinely new text
			if (text && !sentTexts.includes(text)) {
				sentTexts.push(text);
				// First message replies to user, subsequent are standalone
				const replyTo = sentTexts.length === 1 ? msg.id : undefined;
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
		if (sentTexts.length === 0 && status === "completed" && resultText) {
			await plugin.sendMessage(msg.channelId, resultText, msg.id);
			sentTexts.push(resultText);
		}

		if (status === "failed" && sentTexts.length === 0) {
			const errHint = handle.lastStderr.slice(-3).join("\n");
			logger.error("Session failed", { userId: msg.userId, stderr: errHint });
			await plugin.sendMessage(
				msg.channelId,
				"미안, 응답을 생성하는 중에 문제가 생겼어.",
				msg.id,
			);
		}

		// Post-session integration (fire and forget)
		const finalText = resultText || sentTexts[sentTexts.length - 1] || "";
		if (finalText) {
			void this.deps.integrator
				.integrate(sessionKey, msg.userId, `${msg.content}\n---\n${finalText}`)
				.catch((err) => {
					logger.warn("Post-session integration failed", {
						error: String(err),
					});
				});
		}
	}
}
