/**
 * Health check route — simple liveness probe for the dashboard.
 */

import { Hono } from "hono";

export function createHealthRoute(): Hono {
	const app = new Hono();

	app.get("/health", (c) => c.json({ status: "ok", timestamp: Date.now() }));

	return app;
}
