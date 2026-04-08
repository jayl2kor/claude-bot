/**
 * SSE route — Server-Sent Events stream for real-time pet status updates.
 * Pushes status every 5s and stats every 30s.
 * Handles client disconnection gracefully.
 */

import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { PetDataReader } from "../data-reader.js";
import type { PetDiscovery } from "../pet-discovery.js";

export function createSSERoute(
	discovery: PetDiscovery,
	readers: Map<string, PetDataReader>,
): Hono {
	const app = new Hono();

	app.get("/events", async (c) => {
		return streamSSE(c, async (stream) => {
			let statusTick = 0;

			const sendStatus = async (): Promise<void> => {
				try {
					const pets = await discovery.discoverPets();
					await stream.writeSSE({
						event: "status",
						data: JSON.stringify(pets),
					});
				} catch {
					// Client may have disconnected — swallow
				}
			};

			const sendStats = async (): Promise<void> => {
				try {
					const statsMap: Record<string, unknown> = {};
					for (const [id, reader] of readers) {
						statsMap[id] = await reader.getStats();
					}
					await stream.writeSSE({
						event: "stats",
						data: JSON.stringify(statsMap),
					});
				} catch {
					// Client may have disconnected — swallow
				}
			};

			// Send initial data immediately
			await sendStatus();
			await sendStats();

			// Poll loop — exits when stream is aborted
			while (true) {
				await stream.sleep(5000);
				statusTick += 5;

				await sendStatus();

				// Send stats every 30s (6 status ticks)
				if (statusTick % 30 === 0) {
					await sendStats();
				}
			}
		});
	});

	return app;
}
