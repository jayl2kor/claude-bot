/**
 * Delivery queue — retries failed message sends with exponential backoff.
 * Reference: OpenClaw src/infra/outbound/delivery-queue-recovery.ts
 *
 * Failed deliveries are queued in memory and persisted to disk.
 * On restart, pending deliveries are loaded and retried.
 */

import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isENOENT } from "../utils/errors.js";
import { logger } from "../utils/logger.js";

const MAX_RETRIES = 5;
const BASE_DELAY_MS = 1_000;

export type PendingDelivery = {
	id: string;
	pluginId: string;
	channelId: string;
	content: string;
	replyTo?: string;
	attempts: number;
	createdAt: number;
	lastAttemptAt: number;
	lastError?: string;
};

type DeliverFn = (
	pluginId: string,
	channelId: string,
	content: string,
	replyTo?: string,
) => Promise<void>;

export class DeliveryQueue {
	private pending: PendingDelivery[] = [];
	private processing = false;

	constructor(
		private readonly storeDir: string,
		private readonly deliverFn: DeliverFn,
	) {}

	/** Load pending deliveries from disk on startup. */
	async loadPending(): Promise<void> {
		try {
			const raw = await readFile(this.storePath(), "utf8");
			this.pending = JSON.parse(raw) as PendingDelivery[];
			if (this.pending.length > 0) {
				logger.info("Loaded pending deliveries", {
					count: this.pending.length,
				});
			}
		} catch (err) {
			if (!isENOENT(err)) {
				logger.warn("Failed to load delivery queue", { error: String(err) });
			}
		}
	}

	/** Add a failed delivery to the queue. */
	async enqueue(
		delivery: Omit<PendingDelivery, "attempts" | "lastAttemptAt">,
	): Promise<void> {
		this.pending.push({
			...delivery,
			attempts: 0,
			lastAttemptAt: Date.now(),
		});
		await this.persist();
		logger.info("Delivery queued", {
			id: delivery.id,
			pluginId: delivery.pluginId,
		});
	}

	/** Process all pending deliveries with backoff. */
	async processAll(signal?: AbortSignal): Promise<void> {
		if (this.processing) return;
		this.processing = true;

		try {
			const remaining: PendingDelivery[] = [];

			for (const delivery of this.pending) {
				if (signal?.aborted) {
					remaining.push(delivery);
					continue;
				}

				if (delivery.attempts >= MAX_RETRIES) {
					logger.error("Delivery permanently failed, dropping", {
						id: delivery.id,
						attempts: delivery.attempts,
						lastError: delivery.lastError,
					});
					continue;
				}

				// Exponential backoff
				const backoffMs = BASE_DELAY_MS * 2 ** delivery.attempts;
				const elapsed = Date.now() - delivery.lastAttemptAt;
				if (elapsed < backoffMs) {
					remaining.push(delivery);
					continue;
				}

				try {
					await this.deliverFn(
						delivery.pluginId,
						delivery.channelId,
						delivery.content,
						delivery.replyTo,
					);
					logger.info("Delivery retry succeeded", {
						id: delivery.id,
						attempt: delivery.attempts + 1,
					});
					// Success — don't push to remaining
				} catch (err) {
					const error = String(err);

					if (isPermanentError(err)) {
						logger.error("Delivery permanently failed", {
							id: delivery.id,
							error,
						});
						continue;
					}

					remaining.push({
						...delivery,
						attempts: delivery.attempts + 1,
						lastAttemptAt: Date.now(),
						lastError: error,
					});
					logger.warn("Delivery retry failed", {
						id: delivery.id,
						attempt: delivery.attempts + 1,
						error,
					});
				}
			}

			this.pending = remaining;
			await this.persist();
		} finally {
			this.processing = false;
		}
	}

	get size(): number {
		return this.pending.length;
	}

	private storePath(): string {
		return join(this.storeDir, "delivery-queue.json");
	}

	private async persist(): Promise<void> {
		const path = this.storePath();
		try {
			await mkdir(dirname(path), { recursive: true });
			if (this.pending.length === 0) {
				await unlink(path).catch(() => {});
			} else {
				await writeFile(path, JSON.stringify(this.pending, null, 2), "utf8");
			}
		} catch (err) {
			logger.warn("Failed to persist delivery queue", { error: String(err) });
		}
	}
}

/** Permanent errors should not be retried. */
function isPermanentError(err: unknown): boolean {
	if (err && typeof err === "object" && "status" in err) {
		const status = (err as { status: number }).status;
		return [400, 401, 403, 404].includes(status);
	}
	return false;
}
