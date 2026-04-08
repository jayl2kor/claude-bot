/**
 * Tests for config loader — covers:
 * - YAML parsing with env substitution
 * - Schema validation and defaults
 * - .env file loading
 * - ENOENT handling (missing files)
 * - Empty/invalid token channel stripping
 */

import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppConfigSchema, loadConfig } from "./config.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTempDir(): Promise<string> {
	const dir = join(tmpdir(), `claude-pet-config-test-${randomUUID()}`);
	await mkdir(dir, { recursive: true });
	return dir;
}

async function makeConfigDir(
	configDir: string,
	files: Record<string, string>,
): Promise<void> {
	await mkdir(configDir, { recursive: true });
	for (const [name, content] of Object.entries(files)) {
		await writeFile(join(configDir, name), content, "utf8");
	}
}

// ---------------------------------------------------------------------------
// AppConfigSchema — unit tests (no filesystem)
// ---------------------------------------------------------------------------

describe("AppConfigSchema", () => {
	it("parses empty object with all defaults", () => {
		const result = AppConfigSchema.parse({});
		expect(result.persona.name).toBe("Claude-Pet");
		expect(result.persona.tone).toBe("casual");
		expect(result.daemon.maxConcurrentSessions).toBe(10);
		expect(result.daemon.claudeModel).toBe("sonnet");
		expect(result.daemon.maxTurns).toBe(10);
		expect(result.channels.discord).toBeUndefined();
		expect(result.channels.telegram).toBeUndefined();
	});

	it("accepts custom persona fields", () => {
		const result = AppConfigSchema.parse({
			persona: { name: "TestBot", tone: "formal" },
		});
		expect(result.persona.name).toBe("TestBot");
		expect(result.persona.tone).toBe("formal");
	});

	it("rejects invalid tone enum", () => {
		expect(() =>
			AppConfigSchema.parse({ persona: { tone: "aggressive" } }),
		).toThrow();
	});

	it("accepts discord config with required token", () => {
		const result = AppConfigSchema.parse({
			channels: { discord: { token: "my-token" } },
		});
		expect(result.channels.discord?.token).toBe("my-token");
		expect(result.channels.discord?.respondTo).toBe("both");
	});

	it("rejects discord config with empty token", () => {
		expect(() =>
			AppConfigSchema.parse({ channels: { discord: { token: "" } } }),
		).toThrow();
	});

	it("accepts telegram config with required token", () => {
		const result = AppConfigSchema.parse({
			channels: { telegram: { token: "tg-token-123" } },
		});
		expect(result.channels.telegram?.token).toBe("tg-token-123");
	});

	it("rejects telegram config with empty token", () => {
		expect(() =>
			AppConfigSchema.parse({ channels: { telegram: { token: "" } } }),
		).toThrow();
	});

	it("applies daemon defaults correctly", () => {
		const result = AppConfigSchema.parse({ daemon: {} });
		expect(result.daemon.sessionTimeoutMs).toBe(30 * 60 * 1000);
		expect(result.daemon.pointerRefreshMs).toBe(5 * 60 * 1000);
	});

	it("accepts custom daemon values", () => {
		const result = AppConfigSchema.parse({
			daemon: { maxConcurrentSessions: 20, claudeModel: "opus", maxTurns: 5 },
		});
		expect(result.daemon.maxConcurrentSessions).toBe(20);
		expect(result.daemon.claudeModel).toBe("opus");
	});

	it("applies smartModelSelection defaults (disabled, sonnet)", () => {
		const result = AppConfigSchema.parse({});
		expect(result.daemon.smartModelSelection.enabled).toBe(false);
		expect(result.daemon.smartModelSelection.defaultModel).toBe("sonnet");
	});

	it("accepts custom smartModelSelection config", () => {
		const result = AppConfigSchema.parse({
			daemon: { smartModelSelection: { enabled: true, defaultModel: "opus" } },
		});
		expect(result.daemon.smartModelSelection.enabled).toBe(true);
		expect(result.daemon.smartModelSelection.defaultModel).toBe("opus");
	});

	it("rejects invalid smartModelSelection defaultModel", () => {
		expect(() =>
			AppConfigSchema.parse({
				daemon: { smartModelSelection: { defaultModel: "gpt-4" } },
			}),
		).toThrow();
	});

	it("accepts persona values array", () => {
		const result = AppConfigSchema.parse({
			persona: { values: ["정직", "유머", "배움"] },
		});
		expect(result.persona.values).toEqual(["정직", "유머", "배움"]);
	});

	it("accepts empty values array", () => {
		const result = AppConfigSchema.parse({ persona: { values: [] } });
		expect(result.persona.values).toEqual([]);
	});

	it("accepts discord guilds array", () => {
		const result = AppConfigSchema.parse({
			channels: { discord: { token: "tok", guilds: ["g1", "g2"] } },
		});
		expect(result.channels.discord?.guilds).toEqual(["g1", "g2"]);
	});

	it("accepts telegram allowedChats array", () => {
		const result = AppConfigSchema.parse({
			channels: {
				telegram: { token: "tok", allowedChats: [123456, 789012] },
			},
		});
		expect(result.channels.telegram?.allowedChats).toEqual([123456, 789012]);
	});
});

// ---------------------------------------------------------------------------
// loadConfig — integration tests (filesystem)
// ---------------------------------------------------------------------------

describe("loadConfig", () => {
	let tmpDir: string;
	let configDir: string;
	let envFile: string;
	const originalEnv = { ...process.env };

	beforeEach(async () => {
		tmpDir = await makeTempDir();
		configDir = join(tmpDir, "config");
		envFile = join(tmpDir, ".env");
		await mkdir(configDir, { recursive: true });
	});

	afterEach(() => {
		// Restore env to avoid test pollution
		for (const key of Object.keys(process.env)) {
			if (!(key in originalEnv)) {
				delete process.env[key];
			} else {
				process.env[key] = originalEnv[key];
			}
		}
	});

	it("returns all defaults when no config files exist", async () => {
		const config = await loadConfig(configDir, envFile);
		expect(config.persona.name).toBe("Claude-Pet");
		expect(config.daemon.maxConcurrentSessions).toBe(10);
		expect(config.channels.discord).toBeUndefined();
	});

	it("loads persona.yaml and merges with defaults", async () => {
		await writeFile(
			join(configDir, "persona.yaml"),
			"name: Reboong\ntone: playful\n",
			"utf8",
		);
		const config = await loadConfig(configDir, envFile);
		expect(config.persona.name).toBe("Reboong");
		expect(config.persona.tone).toBe("playful");
		expect(config.daemon.maxConcurrentSessions).toBe(10); // default
	});

	it("loads daemon.yaml and applies custom values", async () => {
		await writeFile(
			join(configDir, "daemon.yaml"),
			"maxConcurrentSessions: 3\nclaudeModel: haiku\nmaxTurns: 3\n",
			"utf8",
		);
		const config = await loadConfig(configDir, envFile);
		expect(config.daemon.maxConcurrentSessions).toBe(3);
		expect(config.daemon.claudeModel).toBe("haiku");
	});

	it("loads channels.yaml with valid discord token", async () => {
		await writeFile(
			join(configDir, "channels.yaml"),
			"discord:\n  token: real-discord-token\n  respondTo: mention\n",
			"utf8",
		);
		const config = await loadConfig(configDir, envFile);
		expect(config.channels.discord?.token).toBe("real-discord-token");
		expect(config.channels.discord?.respondTo).toBe("mention");
	});

	it("strips discord channel when token resolves to empty string", async () => {
		// Env var substitution results in empty string
		await writeFile(
			join(configDir, "channels.yaml"),
			"discord:\n  token: ${DISCORD_TOKEN_MISSING_VAR}\n",
			"utf8",
		);
		const config = await loadConfig(configDir, envFile);
		expect(config.channels.discord).toBeUndefined();
	});

	it("strips telegram channel when token resolves to empty string", async () => {
		await writeFile(
			join(configDir, "channels.yaml"),
			"telegram:\n  token: ${TELEGRAM_TOKEN_MISSING_VAR}\n",
			"utf8",
		);
		const config = await loadConfig(configDir, envFile);
		expect(config.channels.telegram).toBeUndefined();
	});

	it("substitutes env vars in YAML content", async () => {
		process.env.TEST_BOT_NAME = "EnvBot";
		await writeFile(
			join(configDir, "persona.yaml"),
			"name: ${TEST_BOT_NAME}\n",
			"utf8",
		);
		const config = await loadConfig(configDir, envFile);
		expect(config.persona.name).toBe("EnvBot");
		delete process.env.TEST_BOT_NAME;
	});

	it("loads .env file and makes variables available for substitution", async () => {
		await writeFile(envFile, "MY_TEST_MODEL=claude-opus\n", "utf8");
		await writeFile(
			join(configDir, "daemon.yaml"),
			"claudeModel: ${MY_TEST_MODEL}\n",
			"utf8",
		);
		const config = await loadConfig(configDir, envFile);
		expect(config.daemon.claudeModel).toBe("claude-opus");
	});

	it("does not override existing env vars with .env file values", async () => {
		process.env.EXISTING_VAR = "existing-value";
		await writeFile(envFile, "EXISTING_VAR=from-dotenv\n", "utf8");
		const config = await loadConfig(configDir, envFile);
		// process.env should still have the original
		expect(process.env.EXISTING_VAR).toBe("existing-value");
		delete process.env.EXISTING_VAR;
	});

	it("ignores non-existent .env file without throwing", async () => {
		await expect(
			loadConfig(configDir, join(tmpDir, "nonexistent.env")),
		).resolves.not.toThrow();
	});

	it("ignores comment lines in .env file", async () => {
		await writeFile(
			envFile,
			"# This is a comment\nCOMMENT_TEST_VAR=value\n# Another comment\n",
			"utf8",
		);
		const config = await loadConfig(configDir, envFile);
		expect(config).toBeDefined();
	});

	it("strips surrounding quotes from .env values", async () => {
		await writeFile(
			envFile,
			"QUOTED_MODEL=\"claude-sonnet\"\nSINGLE_MODEL='haiku'\n",
			"utf8",
		);
		await writeFile(
			join(configDir, "daemon.yaml"),
			"claudeModel: ${QUOTED_MODEL}\n",
			"utf8",
		);
		const config = await loadConfig(configDir, envFile);
		expect(config.daemon.claudeModel).toBe("claude-sonnet");
	});

	it("handles .env file with lines without equals sign", async () => {
		await writeFile(envFile, "INVALID_LINE\nVALID_VAR=hello\n", "utf8");
		await expect(loadConfig(configDir, envFile)).resolves.not.toThrow();
	});

	it("handles empty .env file", async () => {
		await writeFile(envFile, "", "utf8");
		await expect(loadConfig(configDir, envFile)).resolves.not.toThrow();
	});

	it("substitutes unknown env vars with empty string", async () => {
		await writeFile(
			join(configDir, "persona.yaml"),
			"name: ${TOTALLY_UNKNOWN_12345_VAR}\n",
			"utf8",
		);
		// Empty string name should cause schema to use default or fail gracefully
		// The substitution produces "" which zod accepts as a string (no min constraint on name)
		const config = await loadConfig(configDir, envFile);
		expect(config.persona.name).toBe("");
	});

	it("loads all three yaml files simultaneously", async () => {
		await makeConfigDir(configDir, {
			"persona.yaml": "name: MultiBot\ntone: formal\n",
			"daemon.yaml": "maxConcurrentSessions: 7\n",
			"channels.yaml": "discord:\n  token: multi-token\n  respondTo: both\n",
		});
		const config = await loadConfig(configDir, envFile);
		expect(config.persona.name).toBe("MultiBot");
		expect(config.daemon.maxConcurrentSessions).toBe(7);
		expect(config.channels.discord?.token).toBe("multi-token");
	});
});
