/**
 * Reflections route — returns recent reflections for a pet.
 */

import { Hono } from "hono";
import type { PetDataReader } from "../data-reader.js";

export function createReflectionsRoute(
	readers: Map<string, PetDataReader>,
): Hono {
	const app = new Hono();

	app.get("/pets/:id/reflections", async (c) => {
		const petId = c.req.param("id");
		const reader = readers.get(petId);

		if (!reader) {
			return c.json({ success: false, error: `Pet not found: ${petId}` }, 404);
		}

		const limit = Math.min(
			50,
			Math.max(1, Number(c.req.query("limit") ?? "10")),
		);

		try {
			const reflections = await reader.getReflections(limit);
			return c.json({ success: true, data: reflections });
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
