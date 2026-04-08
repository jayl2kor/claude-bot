/**
 * Persona route — returns persona config for a pet.
 */

import { Hono } from "hono";
import type { PetDataReader } from "../data-reader.js";

export function createPersonaRoute(readers: Map<string, PetDataReader>): Hono {
	const app = new Hono();

	app.get("/pets/:id/persona", async (c) => {
		const petId = c.req.param("id");
		const reader = readers.get(petId);

		if (!reader) {
			return c.json({ success: false, error: `Pet not found: ${petId}` }, 404);
		}

		try {
			const persona = await reader.getPersona();
			return c.json({ success: true, data: persona });
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
