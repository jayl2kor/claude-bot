/**
 * Pets route — returns summaries of all discovered pets.
 */

import { Hono } from "hono";
import type { PetDiscovery } from "../pet-discovery.js";

export function createPetsRoute(discovery: PetDiscovery): Hono {
	const app = new Hono();

	app.get("/pets", async (c) => {
		try {
			const pets = await discovery.discoverPets();
			return c.json({ success: true, data: pets });
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
