/**
 * Pet data reader — reads knowledge, relationships, reflections, activity,
 * and persona data from pet data directories (read-only).
 * Includes TTL caching to avoid excessive disk reads.
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { isENOENT } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import type { ActivityHeatmap, GrowthDataPoint, PetStats } from "./types.js";

// Re-declare schemas locally to avoid tight coupling to memory module internals.
// These schemas must stay compatible with the memory module's schemas.

const KnowledgeEntrySchema = z.object({
	id: z.string(),
	topic: z.string(),
	content: z.string(),
	source: z.enum(["taught", "inferred", "corrected"]),
	taughtBy: z.string().optional(),
	createdAt: z.number(),
	updatedAt: z.number(),
	confidence: z.number().min(0).max(1).default(0.8),
	tags: z.array(z.string()).default([]),
});

const RelationshipSchema = z.object({
	userId: z.string(),
	displayName: z.string(),
	firstSeen: z.number(),
	lastSeen: z.number(),
	interactionCount: z.number().default(0),
	notes: z.array(z.string()).default([]),
	preferences: z.array(z.string()).default([]),
	sentiment: z.enum(["positive", "neutral", "cautious"]).default("neutral"),
});

const ReflectionSchema = z.object({
	id: z.string(),
	sessionKey: z.string(),
	userId: z.string(),
	summary: z.string(),
	insights: z.array(z.string()).default([]),
	createdAt: z.number(),
});

const ActivityRecordSchema = z.object({
	userId: z.string(),
	hourlyDistribution: z
		.array(z.number())
		.length(24)
		.default(Array(24).fill(0) as number[]),
	sessionStartAt: z.number().nullable().default(null),
	lastActivityAt: z.number().default(0),
	lastAlertAt: z.number().default(0),
	alertsToday: z.number().default(0),
	alertsResetDate: z.string().default(""),
});

const PersonaConfigSchema = z.object({
	name: z.string().default("Claude-Pet"),
	personality: z.string().default(""),
	tone: z.enum(["casual", "formal", "playful"]).default("casual"),
	values: z.array(z.string()).default([]),
	constraints: z.array(z.string()).default([]),
});

type KnowledgeEntry = z.output<typeof KnowledgeEntrySchema>;
type Reflection = z.output<typeof ReflectionSchema>;
type PersonaConfig = z.output<typeof PersonaConfigSchema>;

interface CacheEntry<T> {
	data: T;
	expiry: number;
}

const STATS_TTL_MS = 30_000; // 30s
const GROWTH_TTL_MS = 60_000; // 60s

export class PetDataReader {
	private statsCache: CacheEntry<PetStats> | null = null;
	private growthCache: CacheEntry<GrowthDataPoint[]> | null = null;
	private heatmapCache: CacheEntry<ActivityHeatmap[]> | null = null;

	constructor(
		private readonly dataDir: string,
		private readonly configDir: string,
	) {}

	/** Get aggregated stats for this pet. */
	async getStats(): Promise<PetStats> {
		if (this.statsCache && Date.now() < this.statsCache.expiry) {
			return this.statsCache.data;
		}

		const [knowledge, relationships, reflections, activity] = await Promise.all(
			[
				this.readAllEntries("knowledge", KnowledgeEntrySchema),
				this.readAllEntries("relationships", RelationshipSchema),
				this.readAllEntries("reflections", ReflectionSchema),
				this.readAllEntries("activity", ActivityRecordSchema),
			],
		);

		const bySource: Record<string, number> = {};
		for (const k of knowledge) {
			bySource[k.source] = (bySource[k.source] ?? 0) + 1;
		}

		const recentTopics = knowledge
			.sort((a, b) => b.createdAt - a.createdAt)
			.slice(0, 10)
			.map((k) => k.topic);

		const recentNames = relationships
			.sort((a, b) => b.lastSeen - a.lastSeen)
			.slice(0, 10)
			.map((r) => r.displayName);

		const sortedReflections = reflections.sort(
			(a, b) => b.createdAt - a.createdAt,
		);

		const totalSessions = activity.reduce(
			(sum, a) => sum + a.hourlyDistribution.reduce((s, h) => s + h, 0),
			0,
		);

		const hourlyTotals = Array(24).fill(0) as number[];
		for (const a of activity) {
			for (let h = 0; h < 24; h++) {
				hourlyTotals[h] += a.hourlyDistribution[h] ?? 0;
			}
		}
		const peakHour =
			totalSessions > 0
				? hourlyTotals.indexOf(Math.max(...hourlyTotals))
				: undefined;

		const stats: PetStats = {
			knowledge: {
				total: knowledge.length,
				bySource,
				recentTopics,
			},
			relationships: {
				total: relationships.length,
				recentNames,
			},
			reflections: {
				total: reflections.length,
				latestInsight: sortedReflections[0]?.summary,
			},
			activity: {
				totalSessions,
				peakHour,
			},
		};

		this.statsCache = { data: stats, expiry: Date.now() + STATS_TTL_MS };
		return stats;
	}

	/** Compute growth timeline — knowledge and relationship counts by date. */
	async computeGrowthTimeline(): Promise<GrowthDataPoint[]> {
		if (this.growthCache && Date.now() < this.growthCache.expiry) {
			return this.growthCache.data;
		}

		const [knowledge, relationships] = await Promise.all([
			this.readAllEntries("knowledge", KnowledgeEntrySchema),
			this.readAllEntries("relationships", RelationshipSchema),
		]);

		const dateMap = new Map<
			string,
			{ knowledge: number; relationships: number }
		>();

		for (const k of knowledge) {
			const date = new Date(k.createdAt).toISOString().slice(0, 10);
			const entry = dateMap.get(date) ?? { knowledge: 0, relationships: 0 };
			dateMap.set(date, { ...entry, knowledge: entry.knowledge + 1 });
		}

		for (const r of relationships) {
			const date = new Date(r.firstSeen).toISOString().slice(0, 10);
			const entry = dateMap.get(date) ?? { knowledge: 0, relationships: 0 };
			dateMap.set(date, { ...entry, relationships: entry.relationships + 1 });
		}

		// Sort by date and compute cumulative counts
		const sortedDates = [...dateMap.keys()].sort();
		let cumKnowledge = 0;
		let cumRelationships = 0;

		const timeline: GrowthDataPoint[] = sortedDates.map((date) => {
			const counts = dateMap.get(date) ?? { knowledge: 0, relationships: 0 };
			cumKnowledge += counts.knowledge;
			cumRelationships += counts.relationships;
			return {
				date,
				knowledgeCount: cumKnowledge,
				relationshipCount: cumRelationships,
			};
		});

		this.growthCache = { data: timeline, expiry: Date.now() + GROWTH_TTL_MS };
		return timeline;
	}

	/** Compute activity heatmap — aggregated hourly distribution. */
	async computeActivityHeatmap(): Promise<ActivityHeatmap[]> {
		if (this.heatmapCache && Date.now() < this.heatmapCache.expiry) {
			return this.heatmapCache.data;
		}

		const activity = await this.readAllEntries(
			"activity",
			ActivityRecordSchema,
		);

		const hourlyTotals = Array(24).fill(0) as number[];
		for (const a of activity) {
			for (let h = 0; h < 24; h++) {
				hourlyTotals[h] += a.hourlyDistribution[h] ?? 0;
			}
		}

		const heatmap: ActivityHeatmap[] = hourlyTotals.map((count, hour) => ({
			hour,
			count,
		}));

		this.heatmapCache = { data: heatmap, expiry: Date.now() + STATS_TTL_MS };
		return heatmap;
	}

	/** Get paginated knowledge entries, optionally filtered by search query. */
	async getKnowledge(
		page: number,
		limit: number,
		query?: string,
	): Promise<{ entries: KnowledgeEntry[]; total: number }> {
		const all = await this.readAllEntries("knowledge", KnowledgeEntrySchema);

		const filtered = query
			? all.filter((k) => {
					const q = query.toLowerCase();
					return (
						k.topic.toLowerCase().includes(q) ||
						k.content.toLowerCase().includes(q) ||
						k.tags.some((t) => t.toLowerCase().includes(q))
					);
				})
			: all;

		const sorted = filtered.sort((a, b) => b.createdAt - a.createdAt);
		const start = (page - 1) * limit;
		const entries = sorted.slice(start, start + limit);

		return { entries, total: filtered.length };
	}

	/** Get recent reflections sorted by date descending. */
	async getReflections(limit: number): Promise<Reflection[]> {
		const all = await this.readAllEntries("reflections", ReflectionSchema);
		return all.sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
	}

	/** Read persona config from YAML file. */
	async getPersona(): Promise<PersonaConfig> {
		try {
			const content = await readFile(
				join(this.configDir, "persona.yaml"),
				"utf8",
			);
			const parsed = parseYaml(content);
			return PersonaConfigSchema.parse(parsed);
		} catch (err) {
			if (isENOENT(err)) {
				return PersonaConfigSchema.parse({});
			}
			logger.warn("Failed to read persona config", { error: String(err) });
			return PersonaConfigSchema.parse({});
		}
	}

	/** Read all JSON entries from a subdirectory with schema validation. */
	private async readAllEntries<S extends z.ZodTypeAny>(
		subdir: string,
		schema: S,
	): Promise<z.output<S>[]> {
		const dir = join(this.dataDir, subdir);
		const results: z.output<S>[] = [];

		try {
			const files = await readdir(dir);

			for (const file of files) {
				if (!file.endsWith(".json")) continue;

				try {
					const raw = await readFile(join(dir, file), "utf8");
					const parsed = schema.safeParse(JSON.parse(raw));
					if (parsed.success) {
						results.push(parsed.data);
					}
				} catch {
					// Corrupted file — skip
				}
			}
		} catch (err) {
			if (!isENOENT(err)) {
				logger.warn("Failed to read entries", { dir, error: String(err) });
			}
		}

		return results;
	}
}
