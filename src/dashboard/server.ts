/**
 * Dashboard server — Hono app with all routes assembled.
 * Serves both API routes and static frontend files.
 */

import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { PetDataReader } from "./data-reader.js";
import type { PetDiscovery } from "./pet-discovery.js";
import { createActivityRoute } from "./routes/activity.js";
import { createHealthRoute } from "./routes/health.js";
import { createKnowledgeRoute } from "./routes/knowledge.js";
import { createPersonaRoute } from "./routes/persona.js";
import { createPetsRoute } from "./routes/pets.js";
import { createReflectionsRoute } from "./routes/reflections.js";
import { createSSERoute } from "./routes/sse.js";
import { createStatsRoute } from "./routes/stats.js";

const MIME_TYPES: Record<string, string> = {
	".html": "text/html",
	".css": "text/css",
	".js": "application/javascript",
	".json": "application/json",
	".png": "image/png",
	".svg": "image/svg+xml",
	".ico": "image/x-icon",
};

export function createDashboardApp(
	discovery: PetDiscovery,
	readers: Map<string, PetDataReader>,
	staticDir: string,
): Hono {
	const app = new Hono();

	// CORS middleware
	app.use("/api/*", cors());

	// Error handling middleware
	app.onError((err, c) => {
		const message =
			err instanceof Error ? err.message : "Internal server error";
		return c.json({ success: false, error: message }, 500);
	});

	// API routes
	app.route("/api", createHealthRoute());
	app.route("/api", createPetsRoute(discovery));
	app.route("/api", createStatsRoute(readers));
	app.route("/api", createKnowledgeRoute(readers));
	app.route("/api", createActivityRoute(readers));
	app.route("/api", createReflectionsRoute(readers));
	app.route("/api", createPersonaRoute(readers));
	app.route("/api", createSSERoute(discovery, readers));

	// Serve static files from the dashboard/ directory
	app.get("/*", async (c) => {
		const path = c.req.path === "/" ? "/index.html" : c.req.path;
		const filePath = join(staticDir, path);
		const ext = extname(filePath);

		try {
			const content = await readFile(filePath);
			const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
			return c.body(content, 200, { "Content-Type": contentType });
		} catch {
			// Fallback to index.html for SPA routing
			try {
				const indexContent = await readFile(join(staticDir, "index.html"));
				return c.body(indexContent, 200, { "Content-Type": "text/html" });
			} catch {
				return c.text("Not Found", 404);
			}
		}
	});

	return app;
}
