/**
 * Telegram channel plugin using Bot API long polling.
 * Lightweight — no external dependencies, uses native fetch.
 */

import type { ChannelPlugin, IncomingMessage } from "../../plugins/types.js";
import { logger } from "../../utils/logger.js";
import { sleep } from "../../utils/sleep.js";
import { splitMessage } from "../../utils/text.js";

export type TelegramPluginConfig = {
	token: string;
	allowedChats?: number[];
};

type TelegramUpdate = {
	update_id: number;
	message?: {
		message_id: number;
		from?: { id: number; first_name: string; username?: string };
		chat: { id: number; type: string };
		text?: string;
		date: number;
		reply_to_message?: { message_id: number };
	};
};

type TelegramResponse<T> = {
	ok: boolean;
	result: T;
	description?: string;
};

export function createTelegramPlugin(
	config: TelegramPluginConfig,
): ChannelPlugin {
	const baseUrl = `https://api.telegram.org/bot${config.token}`;
	let messageHandler: ((msg: IncomingMessage) => Promise<void>) | null = null;
	let pollController: AbortController | null = null;
	let botUsername = "";

	async function apiCall<T>(
		method: string,
		body?: Record<string, unknown>,
	): Promise<T> {
		const res = await fetch(`${baseUrl}/${method}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: body ? JSON.stringify(body) : undefined,
		});

		const data = (await res.json()) as TelegramResponse<T>;
		if (!data.ok) {
			throw new Error(`Telegram API error: ${data.description ?? "unknown"}`);
		}
		return data.result;
	}

	async function pollLoop(signal: AbortSignal): Promise<void> {
		let offset = 0;

		while (!signal.aborted) {
			try {
				const updates = await apiCall<TelegramUpdate[]>("getUpdates", {
					offset,
					timeout: 30,
					allowed_updates: ["message"],
				});

				for (const update of updates) {
					offset = update.update_id + 1;

					const msg = update.message;
					if (!msg?.text || !msg.from) continue;

					// Filter by allowed chats if configured
					if (
						config.allowedChats &&
						!config.allowedChats.includes(msg.chat.id)
					) {
						continue;
					}

					// Strip bot mention from group messages
					let content = msg.text;
					if (botUsername) {
						content = content
							.replace(new RegExp(`@${botUsername}\\b`, "gi"), "")
							.trim();
					}

					// In groups, only respond to mentions or replies to the bot
					if (msg.chat.type !== "private") {
						const isMentioned = msg.text.includes(`@${botUsername}`);
						if (!isMentioned) continue;
					}

					if (!content) continue;

					const incoming: IncomingMessage = {
						id: `tg-${msg.message_id}-${msg.chat.id}`,
						userId: String(msg.from.id),
						userName: msg.from.first_name,
						channelId: String(msg.chat.id),
						content,
						timestamp: msg.date * 1000,
						replyTo: msg.reply_to_message
							? `tg-${msg.reply_to_message.message_id}-${msg.chat.id}`
							: undefined,
					};

					if (messageHandler) {
						messageHandler(incoming).catch((err) => {
							logger.error("Telegram message handler error", {
								error: String(err),
							});
						});
					}
				}
			} catch (err) {
				if (signal.aborted) break;
				logger.warn("Telegram poll error, retrying", { error: String(err) });
				await sleep(5000, signal);
			}
		}
	}

	return {
		id: "telegram",
		meta: { label: "Telegram", textChunkLimit: 4096 },

		async connect() {
			const me = await apiCall<{ username?: string }>("getMe");
			botUsername = me.username ?? "";
			logger.info("Telegram connected", { username: botUsername });

			pollController = new AbortController();
			void pollLoop(pollController.signal);
		},

		onMessage(handler) {
			messageHandler = handler;
		},

		async sendMessage(channelId, content, _replyTo) {
			// Split long messages (Telegram limit: 4096 chars)
			const chunks = splitMessage(content, 4096);
			for (const chunk of chunks) {
				await apiCall("sendMessage", {
					chat_id: Number(channelId),
					text: chunk,
					parse_mode: "Markdown",
				});
			}
		},

		async sendTyping(channelId) {
			await apiCall("sendChatAction", {
				chat_id: Number(channelId),
				action: "typing",
			}).catch(() => {});
		},

		async disconnect() {
			pollController?.abort();
			logger.info("Telegram disconnected");
		},
	};
}
