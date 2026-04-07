/**
 * Discord channel plugin.
 * Reference: OpenClaw extensions/discord/src/channel.ts
 */

import {
	Client,
	type Message as DiscordMessage,
	Events,
	GatewayIntentBits,
	Partials,
} from "discord.js";
import type { ChannelPlugin, IncomingMessage } from "../../plugins/types.js";
import { logger } from "../../utils/logger.js";
import { splitMessage } from "../../utils/text.js";

export type DiscordPluginConfig = {
	token: string;
	guilds?: string[];
	respondTo: "mention" | "dm" | "both";
};

export function createDiscordPlugin(
	config: DiscordPluginConfig,
): ChannelPlugin {
	const client = new Client({
		intents: [
			GatewayIntentBits.Guilds,
			GatewayIntentBits.GuildMessages,
			GatewayIntentBits.DirectMessages,
			GatewayIntentBits.MessageContent,
		],
		partials: [Partials.Channel],
	});

	let messageHandler: ((msg: IncomingMessage) => Promise<void>) | null = null;

	return {
		id: "discord",
		meta: { label: "Discord", textChunkLimit: 2000 },

		async connect() {
			await client.login(config.token);

			await new Promise<void>((resolve) => {
				client.once(Events.ClientReady, (c) => {
					logger.info("Discord connected", { user: c.user.tag });
					resolve();
				});
			});

			client.on(Events.MessageCreate, async (msg: DiscordMessage) => {
				if (!messageHandler) return;
				if (msg.author.bot) return;

				// Filter by respondTo config
				const isDM = !msg.guild;
				const isMention = msg.mentions.has(client.user!);

				if (config.respondTo === "mention" && !isMention && !isDM) return;
				if (config.respondTo === "dm" && !isDM) return;
				// "both" accepts DMs and mentions

				if (!isDM && !isMention) return;

				// Strip bot mention from content
				let content = msg.content;
				if (client.user) {
					content = content
						.replace(new RegExp(`<@!?${client.user.id}>`, "g"), "")
						.trim();
				}

				if (!content) return;

				const incoming: IncomingMessage = {
					id: msg.id,
					userId: msg.author.id,
					userName: msg.author.displayName ?? msg.author.username,
					channelId: msg.channelId,
					content,
					timestamp: msg.createdTimestamp,
					replyTo: msg.reference?.messageId ?? undefined,
				};

				try {
					await messageHandler(incoming);
				} catch (err) {
					logger.error("Discord message handler error", { error: String(err) });
				}
			});
		},

		onMessage(handler) {
			messageHandler = handler;
		},

		async sendMessage(channelId, content, replyTo) {
			const channel = await client.channels.fetch(channelId);
			if (!channel?.isTextBased()) return;

			// Split long messages (Discord limit: 2000 chars)
			const chunks = splitMessage(content, 2000);
			for (const chunk of chunks) {
				if ("send" in channel) {
					await channel.send({
						content: chunk,
						...(replyTo ? { reply: { messageReference: replyTo } } : {}),
					});
				}
				// Only reply to the first chunk
				replyTo = undefined;
			}
		},

		async sendTyping(channelId) {
			const channel = await client.channels.fetch(channelId);
			if (channel?.isTextBased() && "sendTyping" in channel) {
				await channel.sendTyping();
			}
		},

		async disconnect() {
			client.destroy();
			logger.info("Discord disconnected");
		},
	};
}
