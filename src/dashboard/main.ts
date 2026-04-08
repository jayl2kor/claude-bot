/**
 * Dashboard entrypoint — parses env vars, initializes components,
 * starts the Hono HTTP server, and handles graceful shutdown.
 *
 * This is a separate process from the pet daemon.
 * It reads pet data volumes read-only.
 */

import { resolve } from "node:path";
import { serve } from "@hono/node-server";
import { logger } from "../utils/logger.js";
import { PetDataReader } from "./data-reader.js";
import { PetDiscovery } from "./pet-discovery.js";
import { createDashboardApp } from "./server.js";

function parseEnv(): {
	port: number;
	statusDir: string;
	dataDirs: string[];
	configDirs: string[];
	staticDir: string;
} {
	const port = Number(process.env.DASHBOARD_PORT ?? "3000");
	const statusDir =
		process.env.SHARED_STATUS_DIR ?? resolve("data/shared/status");
	const dataDirs = (process.env.PET_DATA_DIRS ?? "")
		.split(",")
		.map((d) => d.trim())
		.filter(Boolean);
	const configDirs = (process.env.PET_CONFIG_DIRS ?? "")
		.split(",")
		.map((d) => d.trim())
		.filter(Boolean);
	const staticDir = process.env.DASHBOARD_STATIC_DIR ?? resolve("dashboard");

	return { port, statusDir, dataDirs, configDirs, staticDir };
}

function extractPetId(dirPath: string): string {
	const segments = dirPath.split("/");
	return segments[segments.length - 1] ?? dirPath;
}

function main(): void {
	const { port, statusDir, dataDirs, configDirs, staticDir } = parseEnv();

	logger.info("Starting dashboard", {
		port,
		statusDir,
		dataDirs,
		configDirs,
	});

	const discovery = new PetDiscovery(statusDir, dataDirs);

	const readers = new Map<string, PetDataReader>();
	for (let i = 0; i < dataDirs.length; i++) {
		const dir = dataDirs[i];
		if (!dir) continue;
		const petId = extractPetId(dir);
		const configDir = configDirs[i] ?? dir;
		readers.set(petId, new PetDataReader(dir, configDir));
	}

	const app = createDashboardApp(discovery, readers, staticDir);

	const server = serve({ fetch: app.fetch, port }, (info) => {
		logger.info(`Dashboard running on http://localhost:${info.port}`);
	});

	const shutdown = (): void => {
		logger.info("Shutting down dashboard");
		server.close(() => {
			process.exit(0);
		});
	};

	process.on("SIGTERM", shutdown);
	process.on("SIGINT", shutdown);
}

main();
