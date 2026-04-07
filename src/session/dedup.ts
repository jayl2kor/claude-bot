/**
 * Bounded UUID set for message deduplication.
 * Reference: Claude-code bridge/bridgeMessaging.ts BoundedUUIDSet
 *
 * FIFO ring buffer + Set for O(1) lookup with fixed memory.
 * Oldest entries are evicted when capacity is exceeded.
 */
export class BoundedUUIDSet {
	private readonly ring: (string | undefined)[];
	private readonly set = new Set<string>();
	private writeIdx = 0;

	constructor(private readonly capacity: number) {
		this.ring = new Array<string | undefined>(capacity);
	}

	add(uuid: string): void {
		if (this.set.has(uuid)) return;

		// Evict oldest entry at current write position
		const evicted = this.ring[this.writeIdx];
		if (evicted !== undefined) {
			this.set.delete(evicted);
		}

		this.ring[this.writeIdx] = uuid;
		this.set.add(uuid);
		this.writeIdx = (this.writeIdx + 1) % this.capacity;
	}

	has(uuid: string): boolean {
		return this.set.has(uuid);
	}

	get size(): number {
		return this.set.size;
	}

	clear(): void {
		this.set.clear();
		this.ring.fill(undefined);
		this.writeIdx = 0;
	}
}
