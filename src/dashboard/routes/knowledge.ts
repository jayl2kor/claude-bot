/**
 * Knowledge route — paginated knowledge entries with search.
 */

import { Hono } from "hono";
import type { PetDataReader } from "../data-reader.js";

export function createKnowledgeRoute(
	readers: Map<string, PetDataReader>,
): Hono {
	const app = new Hono();

	app.get("/pets/:id/knowledge", async (c) => {
		const petId = c.req.param("id");
		const reader = readers.get(petId);

		if (!reader) {
			return c.json({ success: false, error: `Pet not found: ${petId}` }, 404);
		}

		const page = Math.max(1, Number(c.req.query("page") ?? "1"));
		const limit = Math.min(
			100,
			Math.max(1, Number(c.req.query("limit") ?? "20")),
		);
		const query = c.req.query("q") ?? undefined;

		try {
			const result = await reader.getKnowledge(page, limit, query);
			return c.json({
				success: true,
				data: result.entries,
				meta: {
					total: result.total,
					page,
					limit,
				},
			});
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
