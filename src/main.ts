import { resolve } from "node:path";
import { runDaemon } from "./daemon/lifecycle.js";
import { loadConfig } from "./utils/config.js";
import { logger, setLogLevel } from "./utils/logger.js";

function parsePetId(): string | null {
	const idx = process.argv.indexOf("--pet");
	if (idx >= 0 && process.argv[idx + 1]) {
		return process.argv[idx + 1]!;
	}
	return null;
}

async function main() {
	if (process.argv.includes("--verbose")) {
		setLogLevel("debug");
	}

	const petId = parsePetId();
	const configDir = petId ? resolve("config", petId) : resolve("config");
	const dataDir = petId ? resolve("data", petId) : resolve("data");
	const envFile = petId ? resolve(`.env.${petId}`) : resolve(".env");

	logger.info("claude-pet starting", { petId: petId ?? "default" });

	const config = await loadConfig(configDir, envFile);
	logger.info("Config loaded", { persona: config.persona.name, petId });

	const controller = new AbortController();

	for (const sig of ["SIGINT", "SIGTERM"] as const) {
		process.on(sig, () => {
			logger.info(`Received ${sig}, shutting down...`);
			controller.abort();
		});
	}

	process.on("uncaughtException", (err) => {
		logger.error("Uncaught exception", { error: err.message });
		controller.abort();
	});

	await runDaemon(config, controller.signal, dataDir);
}

main().catch((err) => {
	logger.error("Fatal startup error", { error: String(err) });
	process.exit(1);
});
