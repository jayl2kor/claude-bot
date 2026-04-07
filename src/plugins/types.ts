/**
 * Channel plugin interface.
 * Reference: OpenClaw src/channels/plugins/types.plugin.ts
 *
 * Simplified from OpenClaw's 20+ adapters to 4 essential ones.
 */

export type IncomingMessage = {
	id: string;
	userId: string;
	userName: string;
	channelId: string;
	content: string;
	timestamp: number;
	replyTo?: string;
};

export type ChannelPlugin = {
	readonly id: string;
	readonly meta: { label: string; textChunkLimit: number };

	/** Connect to the channel service. */
	connect(): Promise<void>;

	/** Register handler for incoming messages. */
	onMessage(handler: (msg: IncomingMessage) => Promise<void>): void;

	/** Send a text message to a channel. */
	sendMessage(channelId: string, content: string, replyTo?: string): Promise<void>;

	/** Show typing indicator. */
	sendTyping(channelId: string): Promise<void>;

	/** Disconnect from the channel service. */
	disconnect(): Promise<void>;
};
