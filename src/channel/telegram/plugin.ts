/**
 * Telegram channel plugin using Bot API long polling.
 * Lightweight — no external dependencies, uses native fetch.
 */

import { AttachmentDownloader } from "../../attachments/downloader.js";
import type { Attachment } from "../../attachments/types.js";
import { isAllowedMimeType } from "../../attachments/types.js";
import type { ChannelPlugin, IncomingMessage } from "../../plugins/types.js";
import { logger } from "../../utils/logger.js";
import { sleep } from "../../utils/sleep.js";
import { splitMessage } from "../../utils/text.js";

export type TelegramPluginConfig = {
	token: string;
	allowedChats?: number[];
	/** Directory where attachments are downloaded. */
	uploadDir?: string;
	/** Max file size in MB (default: 10). */
	maxFileSizeMb?: number;
	/** Max total attachment size in MB per message (default: 25). */
	maxTotalSizeMb?: number;
};

type TelegramPhotoSize = {
	file_id: string;
	file_unique_id: string;
	width: number;
	height: number;
	file_size?: number;
};

type TelegramDocument = {
	file_id: string;
	file_name?: string;
	mime_type?: string;
	file_size?: number;
};

type TelegramUpdate = {
	update_id: number;
	message?: {
		message_id: number;
		from?: { id: number; first_name: string; username?: string };
		chat: { id: number; type: string };
		text?: string;
		caption?: string;
		date: number;
		reply_to_message?: { message_id: number };
		photo?: TelegramPhotoSize[];
		document?: TelegramDocument;
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
					if (!msg?.from) continue;

					const hasText = !!msg.text;
					const hasCaption = !!msg.caption;
					const hasPhoto = !!msg.photo && msg.photo.length > 0;
					const hasDocument = !!msg.document;
					const hasMedia = hasPhoto || hasDocument;

					// Must have text or media
					if (!hasText && !hasCaption && !hasMedia) continue;

					// Filter by allowed chats if configured
					if (
						config.allowedChats &&
						!config.allowedChats.includes(msg.chat.id)
					) {
						continue;
					}

					// Use text or caption as content
					let content = msg.text ?? msg.caption ?? "";
					if (botUsername) {
						content = content
							.replace(new RegExp(`@${botUsername}\\b`, "gi"), "")
							.trim();
					}

					// In groups, only respond to mentions or replies to the bot
					if (msg.chat.type !== "private") {
						const rawText = msg.text ?? msg.caption ?? "";
						const isMentioned = rawText.includes(`@${botUsername}`);
						if (!isMentioned) continue;
					}

					if (!content && !hasMedia) continue;

					// Download attachments
					const attachments = await downloadTelegramAttachments(
						msg,
						config,
						apiCall,
					);

					const incoming: IncomingMessage = {
						id: `tg-${msg.message_id}-${msg.chat.id}`,
						userId: String(msg.from.id),
						userName: msg.from.first_name,
						channelId: String(msg.chat.id),
						content: content || "(첨부 파일만 전송됨)",
						timestamp: msg.date * 1000,
						replyTo: msg.reply_to_message
							? `tg-${msg.reply_to_message.message_id}-${msg.chat.id}`
							: undefined,
						...(attachments.length > 0 ? { attachments } : {}),
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

// ---------------------------------------------------------------------------
// Telegram attachment download helper
// ---------------------------------------------------------------------------

type TelegramFile = {
	file_id: string;
	file_path?: string;
	file_size?: number;
};

type TelegramMessage = NonNullable<TelegramUpdate["message"]>;

async function downloadTelegramAttachments(
	msg: TelegramMessage,
	config: TelegramPluginConfig,
	apiCall: <T>(method: string, body?: Record<string, unknown>) => Promise<T>,
): Promise<Attachment[]> {
	if (!config.uploadDir) return [];

	const downloader = new AttachmentDownloader({
		maxFileSizeMb: config.maxFileSizeMb,
	});
	const maxTotalBytes = (config.maxTotalSizeMb ?? 25) * 1024 * 1024;
	const results: Attachment[] = [];
	let totalSize = 0;

	// Handle photo attachments (pick largest resolution)
	if (msg.photo && msg.photo.length > 0) {
		const largest = msg.photo[msg.photo.length - 1];
		if (!largest) return results;
		const att = await downloadTelegramFile(
			largest.file_id,
			"photo.jpg",
			"image/jpeg",
			largest.file_size ?? 0,
			config,
			downloader,
			apiCall,
			maxTotalBytes,
			totalSize,
		);
		if (att) {
			totalSize += att.size;
			results.push(att);
		}
	}

	// Handle document attachments
	if (msg.document) {
		const mimeType = msg.document.mime_type ?? "application/octet-stream";
		if (isAllowedMimeType(mimeType)) {
			const att = await downloadTelegramFile(
				msg.document.file_id,
				msg.document.file_name ?? "document",
				mimeType,
				msg.document.file_size ?? 0,
				config,
				downloader,
				apiCall,
				maxTotalBytes,
				totalSize,
			);
			if (att) {
				totalSize += att.size;
				results.push(att);
			}
		} else {
			logger.debug("Skipping unsupported Telegram document", {
				filename: msg.document.file_name,
				mimeType,
			});
		}
	}

	return results;
}

async function downloadTelegramFile(
	fileId: string,
	filename: string,
	mimeType: string,
	fileSize: number,
	config: TelegramPluginConfig,
	downloader: AttachmentDownloader,
	apiCall: <T>(method: string, body?: Record<string, unknown>) => Promise<T>,
	maxTotalBytes: number,
	currentTotal: number,
): Promise<Attachment | null> {
	if (currentTotal + fileSize > maxTotalBytes) {
		logger.warn("Total attachment size exceeded for Telegram", {
			current: currentTotal,
			limit: maxTotalBytes,
		});
		return null;
	}

	try {
		// Get file path from Telegram API
		const file = await apiCall<TelegramFile>("getFile", {
			file_id: fileId,
		});

		if (!file.file_path) {
			logger.warn("Telegram getFile returned no file_path", { fileId });
			return null;
		}

		const fileUrl = `https://api.telegram.org/file/bot${config.token}/${file.file_path}`;
		const uploadDir = config.uploadDir;
		if (!uploadDir) return null;

		const result = await downloader.download(
			fileUrl,
			uploadDir,
			filename,
			mimeType,
			file.file_size ?? fileSize,
		);

		return {
			filename,
			mimeType,
			size: file.file_size ?? fileSize,
			url: fileUrl,
			...(result.ok ? { localPath: result.localPath } : {}),
		};
	} catch (err) {
		logger.warn("Telegram attachment download failed", {
			filename,
			error: String(err),
		});
		return null;
	}
}
