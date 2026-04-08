/**
 * Discord channel plugin.
 * Reference: OpenClaw extensions/discord/src/channel.ts
 */

import {
	Client,
	type Message as DiscordMessage,
	Events,
	GatewayIntentBits,
	type Interaction,
	Partials,
	REST,
	Routes,
	SlashCommandBuilder,
} from "discord.js";
import { AttachmentDownloader } from "../../attachments/downloader.js";
import type { Attachment } from "../../attachments/types.js";
import { isAllowedMimeType } from "../../attachments/types.js";
import type {
	ChannelChatMessage,
	ChannelPlugin,
	CommandInteraction,
	IncomingMessage,
	SlashCommand,
} from "../../plugins/types.js";
import { logger } from "../../utils/logger.js";
import { splitMessage } from "../../utils/text.js";

export type DiscordPluginConfig = {
	token: string;
	guilds?: string[];
	respondTo: "mention" | "dm" | "both";
	/** Directory where attachments are downloaded. */
	uploadDir?: string;
	/** Max file size in MB (default: 10). */
	maxFileSizeMb?: number;
	/** Max total attachment size in MB per message (default: 25). */
	maxTotalSizeMb?: number;
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
		allowedMentions: { parse: ["roles", "users"] },
	});

	let messageHandler: ((msg: IncomingMessage) => Promise<void>) | null = null;
	// biome-ignore lint/style/useLet: reassigned in onCommand
	let commandHandler:
		| ((interaction: CommandInteraction) => Promise<void>)
		| null = null;

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

				// Ignore own messages
				if (msg.author.id === client.user?.id) return;

				const isDM = !msg.guild;
				const isMention = msg.mentions.has(client.user!);
				const isFromBot = msg.author.bot;

				// Bots can trigger us only via direct mention
				if (isFromBot && !isMention) return;

				// Human messages: filter by respondTo config
				if (!isFromBot) {
					if (config.respondTo === "mention" && !isMention && !isDM) return;
					if (config.respondTo === "dm" && !isDM) return;
					if (!isDM && !isMention) return;
				}

				// Strip bot mention from content
				let content = msg.content;
				if (client.user) {
					content = content
						.replace(new RegExp(`<@!?${client.user.id}>`, "g"), "")
						.trim();
				}

				// Allow messages with only attachments (no text content)
				if (!content && msg.attachments.size === 0) return;

				// Fetch recent channel messages for conversation context
				let recentMessages: ChannelChatMessage[] = [];
				try {
					const history = await msg.channel.messages.fetch({
						limit: 10,
						before: msg.id,
					});
					recentMessages = [...history.values()].reverse().map((m) => ({
						userName: m.author.displayName ?? m.author.username,
						content: m.content.slice(0, 300),
						isBot: m.author.bot,
						timestamp: m.createdTimestamp,
					}));
				} catch {
					// Channel history not available (DM partial, permissions)
				}

				// Download attachments if upload directory is configured
				const attachments = await downloadDiscordAttachments(msg, config);

				const incoming: IncomingMessage = {
					id: msg.id,
					userId: msg.author.id,
					userName: msg.author.displayName ?? msg.author.username,
					channelId: msg.channelId,
					content: content || "(첨부 파일만 전송됨)",
					timestamp: msg.createdTimestamp,
					replyTo: msg.reference?.messageId ?? undefined,
					isFromBot: msg.author.bot,
					recentMessages,
					...(attachments.length > 0 ? { attachments } : {}),
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

		async registerCommands(commands: SlashCommand[]) {
			if (!client.user) return;

			const rest = new REST().setToken(config.token);
			const builders = commands.map((cmd) => {
				const b = new SlashCommandBuilder()
					.setName(cmd.name)
					.setDescription(cmd.description);
				for (const opt of cmd.options ?? []) {
					if (opt.type === "string") {
						b.addStringOption((o) =>
							o
								.setName(opt.name)
								.setDescription(opt.description)
								.setRequired(opt.required),
						);
					} else if (opt.type === "integer") {
						b.addIntegerOption((o) =>
							o
								.setName(opt.name)
								.setDescription(opt.description)
								.setRequired(opt.required),
						);
					}
				}
				return b.toJSON();
			});

			try {
				await rest.put(Routes.applicationCommands(client.user.id), {
					body: builders,
				});
				logger.info("Slash commands registered", { count: commands.length });
			} catch (err) {
				logger.error("Failed to register slash commands", {
					error: String(err),
				});
			}

			// Listen for interactions
			client.on(Events.InteractionCreate, async (interaction: Interaction) => {
				if (!interaction.isChatInputCommand() || !commandHandler) return;

				const ci: CommandInteraction = {
					commandName: interaction.commandName,
					channelId: interaction.channelId,
					userId: interaction.user.id,
					userName: interaction.user.displayName ?? interaction.user.username,
					options: Object.fromEntries(
						interaction.options.data.map((o) => [
							o.name,
							o.value as string | number,
						]),
					),
					reply: (content) =>
						interaction.reply({ content, ephemeral: false }).then(() => {}),
					deferReply: () => interaction.deferReply().then(() => {}),
					editReply: (content) =>
						interaction.editReply({ content }).then(() => {}),
				};

				try {
					await commandHandler(ci);
				} catch (err) {
					logger.error("Slash command handler error", { error: String(err) });
					if (!interaction.replied && !interaction.deferred) {
						await interaction.reply({
							content: "처리 중 에러가 발생했습니다.",
							ephemeral: true,
						});
					}
				}
			});
		},

		onCommand(handler) {
			commandHandler = handler;
		},

		async sendMessage(channelId, content, replyTo) {
			const channel = await client.channels.fetch(channelId);
			if (!channel?.isTextBased()) return;

			// Sanitize @everyone / @here to prevent unintended mass pings
			const sanitized = content.replace(/@(everyone|here)/g, "@​$1");

			// Split long messages (Discord limit: 2000 chars)
			const chunks = splitMessage(sanitized, 2000);
			for (const chunk of chunks) {
				if ("send" in channel) {
					await channel.send({
						content: chunk,
						allowedMentions: { parse: ["roles", "users"] },
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

// ---------------------------------------------------------------------------
// Attachment download helper
// ---------------------------------------------------------------------------

async function downloadDiscordAttachments(
	msg: DiscordMessage,
	config: DiscordPluginConfig,
): Promise<Attachment[]> {
	if (msg.attachments.size === 0 || !config.uploadDir) return [];

	const downloader = new AttachmentDownloader({
		maxFileSizeMb: config.maxFileSizeMb,
	});
	const maxTotalBytes = (config.maxTotalSizeMb ?? 25) * 1024 * 1024;
	const results: Attachment[] = [];
	let totalSize = 0;

	for (const [, discordAtt] of msg.attachments) {
		const mimeType = discordAtt.contentType ?? "application/octet-stream";

		// Skip unsupported MIME types silently
		if (!isAllowedMimeType(mimeType)) {
			logger.debug("Skipping unsupported attachment", {
				filename: discordAtt.name,
				mimeType,
			});
			continue;
		}

		// Check total size budget
		const attSize = discordAtt.size;
		if (totalSize + attSize > maxTotalBytes) {
			logger.warn("Total attachment size exceeded, skipping remaining", {
				current: totalSize,
				limit: maxTotalBytes,
			});
			break;
		}

		const result = await downloader.download(
			discordAtt.url,
			config.uploadDir,
			discordAtt.name ?? "attachment",
			mimeType,
			attSize,
		);

		const attachment: Attachment = {
			filename: discordAtt.name ?? "attachment",
			mimeType,
			size: attSize,
			url: discordAtt.url,
			...(result.ok ? { localPath: result.localPath } : {}),
		};

		if (!result.ok) {
			logger.warn("Attachment download failed", {
				filename: discordAtt.name,
				error: result.error,
			});
		} else {
			totalSize += result.size;
		}

		results.push(attachment);
	}

	return results;
}
