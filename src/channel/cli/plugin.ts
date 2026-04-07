/**
 * CLI channel plugin — stdin/stdout interactive mode.
 * No external service needed. For local testing and direct conversation.
 */

import { createInterface } from "node:readline";
import type { ChannelPlugin, IncomingMessage } from "../../plugins/types.js";
import { logger } from "../../utils/logger.js";

let messageCounter = 0;

export function createCliPlugin(): ChannelPlugin {
	let messageHandler: ((msg: IncomingMessage) => Promise<void>) | null = null;
	let rl: ReturnType<typeof createInterface> | null = null;

	return {
		id: "cli",
		meta: { label: "CLI", textChunkLimit: Number.MAX_SAFE_INTEGER },

		async connect() {
			rl = createInterface({
				input: process.stdin,
				output: process.stdout,
				prompt: "\n> ",
			});

			rl.on("line", async (line) => {
				const text = line.trim();
				if (!text) {
					rl?.prompt();
					return;
				}

				if (text === "/quit" || text === "/exit") {
					process.kill(process.pid, "SIGTERM");
					return;
				}

				if (!messageHandler) return;

				const msg: IncomingMessage = {
					id: `cli-${++messageCounter}`,
					userId: "cli-user",
					userName: "You",
					channelId: "cli",
					content: text,
					timestamp: Date.now(),
				};

				try {
					await messageHandler(msg);
				} catch (err) {
					logger.error("CLI message handler error", { error: String(err) });
				}

				rl?.prompt();
			});

			rl.on("close", () => {
				process.kill(process.pid, "SIGTERM");
			});

			console.log("\nclaude-pet CLI mode. Type /quit to exit.\n");
			rl.prompt();
		},

		onMessage(handler) {
			messageHandler = handler;
		},

		async sendMessage(_channelId, content, _replyTo) {
			console.log(`\n${content}`);
		},

		async sendTyping(_channelId) {
			// No-op for CLI
		},

		async disconnect() {
			rl?.close();
			rl = null;
		},
	};
}
