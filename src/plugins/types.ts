/**
 * Channel plugin interface.
 * Reference: OpenClaw src/channels/plugins/types.plugin.ts
 *
 * Simplified from OpenClaw's 20+ adapters to 4 essential ones.
 */

export type ChannelChatMessage = {
	userName: string;
	content: string;
	isBot: boolean;
	timestamp: number;
};

export type IncomingMessage = {
	id: string;
	userId: string;
	userName: string;
	channelId: string;
	content: string;
	timestamp: number;
	replyTo?: string;
	/** True when the message was sent by another bot (not a human). */
	isFromBot?: boolean;
	/** Recent channel messages for conversation context. */
	recentMessages?: ChannelChatMessage[];
	/** Attached files (images, documents, code). */
	attachments?: readonly import("../attachments/types.js").Attachment[];
};

export type SlashCommand = {
	name: string;
	description: string;
	options?: Array<{
		name: string;
		description: string;
		type: "string" | "integer";
		required: boolean;
	}>;
};

export type CommandInteraction = {
	commandName: string;
	channelId: string;
	userId: string;
	userName: string;
	options: Record<string, string | number>;
	reply: (content: string) => Promise<void>;
	deferReply: () => Promise<void>;
	editReply: (content: string) => Promise<void>;
};

export type ChannelPlugin = {
	readonly id: string;
	readonly meta: { label: string; textChunkLimit: number };

	/** Connect to the channel service. */
	connect(): Promise<void>;

	/** Register handler for incoming messages. */
	onMessage(handler: (msg: IncomingMessage) => Promise<void>): void;

	/** Register slash commands. */
	registerCommands?(commands: SlashCommand[]): Promise<void>;

	/** Register handler for slash command interactions. */
	onCommand?(handler: (interaction: CommandInteraction) => Promise<void>): void;

	/** Send a text message to a channel. */
	sendMessage(
		channelId: string,
		content: string,
		replyTo?: string,
	): Promise<void>;

	/** Show typing indicator. */
	sendTyping(channelId: string): Promise<void>;

	/** Disconnect from the channel service. */
	disconnect(): Promise<void>;
};
