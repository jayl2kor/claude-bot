import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { isENOENT } from "./errors.js";

const PersonaConfigSchema = z.object({
	name: z.string().default("Claude-Pet"),
	personality: z.string().default("호기심 많고 친근한 AI 친구"),
	tone: z.enum(["casual", "formal", "playful"]).default("casual"),
	values: z.array(z.string()).default(["정직", "배움", "유머"]),
	constraints: z.array(z.string()).default([]),
});

const DiscordConfigSchema = z.object({
	token: z.string().min(1),
	guilds: z.array(z.string()).optional(),
	respondTo: z.enum(["mention", "dm", "both"]).default("both"),
});

const TelegramConfigSchema = z.object({
	token: z.string().min(1),
	allowedChats: z.array(z.number()).optional(),
});

const ChannelsConfigSchema = z.object({
	discord: DiscordConfigSchema.optional(),
	telegram: TelegramConfigSchema.optional(),
});

const DaemonConfigSchema = z.object({
	maxConcurrentSessions: z.number().default(10),
	sessionTimeoutMs: z.number().default(30 * 60 * 1000),
	pointerRefreshMs: z.number().default(5 * 60 * 1000),
	claudeModel: z.string().default("sonnet"),
});

export const AppConfigSchema = z.object({
	persona: PersonaConfigSchema.default({}),
	channels: ChannelsConfigSchema.default({}),
	daemon: DaemonConfigSchema.default({}),
});

export type AppConfig = z.infer<typeof AppConfigSchema>;
export type PersonaConfig = z.infer<typeof PersonaConfigSchema>;

/**
 * Load .env file into process.env, then load YAML config with env substitution.
 */
export async function loadConfig(
	configDir?: string,
	envFile?: string,
): Promise<AppConfig> {
	await loadDotEnv(envFile ?? resolve(".env"));

	const dir = configDir ?? resolve("config");
	const raw: Record<string, unknown> = {};

	for (const file of ["persona.yaml", "channels.yaml", "daemon.yaml"]) {
		try {
			const content = await readFile(resolve(dir, file), "utf8");
			const parsed = parseYaml(substituteEnvVars(content));
			if (parsed && typeof parsed === "object") {
				const key = file.replace(".yaml", "");
				raw[key] = parsed;
			}
		} catch (err) {
			if (!isENOENT(err)) throw err;
		}
	}

	// Parse with lenient channel handling — strip channels with empty tokens
	const config = AppConfigSchema.parse(raw);

	// Remove channels where token resolved to empty string
	if (config.channels.discord && !config.channels.discord.token) {
		config.channels.discord = undefined;
	}
	if (config.channels.telegram && !config.channels.telegram.token) {
		config.channels.telegram = undefined;
	}

	return config;
}

/** Replace ${ENV_VAR} patterns with environment variable values. */
function substituteEnvVars(content: string): string {
	return content.replace(/\$\{(\w+)\}/g, (_, varName: string) => {
		return process.env[varName] ?? "";
	});
}

/** Load a .env file into process.env. No external dependency. */
async function loadDotEnv(path: string): Promise<void> {
	try {
		const content = await readFile(path, "utf8");
		for (const line of content.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith("#")) continue;

			const eqIdx = trimmed.indexOf("=");
			if (eqIdx < 0) continue;

			const key = trimmed.slice(0, eqIdx).trim();
			let value = trimmed.slice(eqIdx + 1).trim();

			// Strip surrounding quotes
			if (
				(value.startsWith('"') && value.endsWith('"')) ||
				(value.startsWith("'") && value.endsWith("'"))
			) {
				value = value.slice(1, -1);
			}

			// Don't override existing env vars
			if (!(key in process.env)) {
				process.env[key] = value;
			}
		}
	} catch (err) {
		if (!isENOENT(err)) throw err;
	}
}
