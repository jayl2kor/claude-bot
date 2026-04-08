import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { ExpertiseConfigSchema } from "../expertise/types.js";
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

const GitConfigSchema = z.object({
	enabled: z.boolean().default(false),
	branch: z.string().optional(),
	autoSync: z.boolean().default(false),
});

const AttachmentConfigSchema = z.object({
	maxFileSizeMb: z.number().default(10),
	maxTotalSizeMb: z.number().default(25),
	retentionDays: z.number().default(7),
});

const GrowthReportConfigSchema = z.object({
	enabled: z.boolean().default(false),
	intervalMs: z.number().default(7 * 24 * 60 * 60 * 1000),
	channelId: z.string().optional(),
	language: z.string().default("ko"),
});

const SmartModelSelectionSchema = z.object({
	enabled: z.boolean().default(false),
	defaultModel: z.enum(["haiku", "sonnet", "opus"]).default("sonnet"),
});

const GitWatcherConfigSchema = z.object({
	enabled: z.boolean().default(false),
	branches: z.array(z.string()).default(["main"]),
	pollIntervalMs: z.number().default(60_000),
	maxReviewsPerHour: z.number().default(5),
	ignoreAuthors: z.array(z.string()).default([]),
	reviewChannelId: z.string().default(""),
	maxDiffChars: z.number().default(4000),
});

const CollaborationConfigSchema = z.object({
	enabled: z.boolean().default(false),
	role: z.string().default("general"),
	sharedDir: z.string().optional(),
});

const StudyConfigSchema = z.object({
	enabled: z.boolean().default(false),
	maxDailySessions: z.number().default(5),
	maxSubTopics: z.number().default(8),
	model: z.string().default("sonnet"),
	maxTurns: z.number().default(3),
});

const KnowledgeFeedConfigSchema = z.object({
	enabled: z.boolean().default(false),
	pollIntervalMs: z.number().default(30_000),
	ttlMs: z.number().default(7 * 24 * 60 * 60 * 1000),
	confidenceMultiplier: z.number().min(0).max(1).default(0.7),
	sharedDir: z.string().optional(),
});

const CronReportConfigSchema = z.object({
	enabled: z.boolean().default(false),
	channelId: z.string().default(""),
});

const PRReviewCronSchema = z.object({
	enabled: z.boolean().default(false),
	pollIntervalMs: z.number().default(5 * 60 * 1000),
	channelId: z.string().default(""),
});

const PRResponseCronSchema = z.object({
	enabled: z.boolean().default(false),
	pollIntervalMs: z.number().default(5 * 60 * 1000),
	channelId: z.string().default(""),
});

const EvaluationConfigSchema = z.object({
	enabled: z.boolean().default(false),
	sharedDir: z.string().optional(),
	probability: z.number().min(0).max(1).default(0.3),
	maxPendingCount: z.number().default(5),
});

const DaemonConfigSchema = z
	.object({
		maxConcurrentSessions: z.number().default(10),
		sessionTimeoutMs: z.number().default(30 * 60 * 1000),
		pointerRefreshMs: z.number().default(5 * 60 * 1000),
		backend: z.enum(["claude", "codex"]).default("claude"),
		model: z.string().optional(),
		/** Legacy compatibility field. Prefer `model`. */
		claudeModel: z.string().optional(),
		maxTurns: z.number().default(10),
		skipPermissions: z.boolean().default(false),
		workspacePath: z.string().optional(),
		sharedStatusDir: z.string().optional(),
		git: GitConfigSchema.default({}),
		gitWatcher: GitWatcherConfigSchema.default({}),
		collaboration: CollaborationConfigSchema.default({}),
		growthReport: GrowthReportConfigSchema.default({}),
		smartModelSelection: SmartModelSelectionSchema.default({}),
		attachments: AttachmentConfigSchema.default({}),
		knowledgeFeed: KnowledgeFeedConfigSchema.default({}),
		study: StudyConfigSchema.default({}),
		evaluation: EvaluationConfigSchema.default({}),
		cronReport: CronReportConfigSchema.default({}),
		prReview: PRReviewCronSchema.default({}),
		prResponse: PRResponseCronSchema.default({}),
	})
	.transform((daemon) => {
		const resolvedModel = daemon.model ?? daemon.claudeModel ?? "sonnet";
		return {
			...daemon,
			model: resolvedModel,
			claudeModel: daemon.claudeModel ?? resolvedModel,
		};
	});

export const AppConfigSchema = z.object({
	persona: PersonaConfigSchema.default({}),
	channels: ChannelsConfigSchema.default({}),
	daemon: DaemonConfigSchema.default({}),
	expertise: ExpertiseConfigSchema.default({}),
});

export type AppConfig = z.infer<typeof AppConfigSchema>;
export type PersonaConfig = z.infer<typeof PersonaConfigSchema>;
export type GrowthReportConfig = z.infer<typeof GrowthReportConfigSchema>;
export type GitWatcherConfig = z.infer<typeof GitWatcherConfigSchema>;
export type CronReportConfig = z.infer<typeof CronReportConfigSchema>;

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

	for (const file of [
		"persona.yaml",
		"channels.yaml",
		"daemon.yaml",
		"expertise.yaml",
	]) {
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

	// Strip channels whose token resolved to an empty string before Zod validation.
	// This handles the case where ${ENV_VAR} substitutes to "" (unset variable).
	const channelsRaw = raw.channels as Record<string, unknown> | undefined;
	if (channelsRaw && typeof channelsRaw === "object") {
		for (const channelKey of ["discord", "telegram"] as const) {
			const ch = channelsRaw[channelKey] as Record<string, unknown> | undefined;
			if (ch && typeof ch === "object" && !ch.token) {
				delete channelsRaw[channelKey];
			}
		}
	}

	return AppConfigSchema.parse(raw);
}

/** Replace ${ENV_VAR} patterns with environment variable values. */
function substituteEnvVars(content: string): string {
	return content.replace(/\$\{(\w+)\}/g, (_, varName: string) => {
		// Use quoted empty string so YAML parses it as "" rather than null
		const value = process.env[varName];
		return value !== undefined ? value : '""';
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
