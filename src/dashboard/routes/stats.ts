/**
 * Stats route — returns aggregated stats for a specific pet.
 */

import { Hono } from "hono";
import type { PetDataReader } from "../data-reader.js";

export function createStatsRoute(readers: Map<string, PetDataReader>): Hono {
	const app = new Hono();

	app.get("/pets/:id/stats", async (c) => {
		const petId = c.req.param("id");
		const reader = readers.get(petId);

		if (!reader) {
			return c.json({ success: false, error: `Pet not found: ${petId}` }, 404);
		}

		try {
			const stats = await reader.getStats();
			return c.json({ success: true, data: stats });
		} catch (err) {
			return c.json(
				{
					success: false,
					error: err instanceof Error ? err.message : "Unknown error",
				},
				500,
			);
		}
	});

	return app;
}
