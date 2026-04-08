/**
 * Growth report generator — creates persona-voice reports via Claude haiku.
 *
 * Generates a growth report from aggregated stats, sends it to a channel,
 * and saves report history for future delta comparison.
 */

import { randomUUID } from "node:crypto";
import { spawnClaude } from "../executor/spawner.js";
import type { ChannelPlugin } from "../plugins/types.js";
import { logger } from "../utils/logger.js";
import type {
	GrowthDelta,
	GrowthReport,
	GrowthStats,
	ReportHistory,
} from "./types.js";

export type ReportHistoryStore = {
	save(history: ReportHistory): Promise<void>;
	getLatest(): Promise<ReportHistory | null>;
};

export type ReporterConfig = {
	readonly personaName: string;
	readonly language: string;
	readonly historyStore: ReportHistoryStore;
};

export class GrowthReporter {
	private readonly config: ReporterConfig;

	constructor(config: ReporterConfig) {
		this.config = config;
	}

	/** Generate a growth report from stats using Claude haiku. */
	async generateReport(
		stats: GrowthStats,
		delta: GrowthDelta | null,
	): Promise<GrowthReport> {
		const prompt = buildReportPrompt(
			this.config.personaName,
			this.config.language,
			stats,
			delta,
		);

		const handle = spawnClaude({ prompt, model: "haiku", maxTurns: 1 });
		let reportText = "";
		handle.onResult((r) => {
			if (!r.is_error) {
				reportText = r.result;
			}
		});
		await handle.done;

		if (!reportText) {
			logger.warn("Growth report generation returned empty result");
			reportText = buildFallbackReport(stats, delta);
		}

		return {
			id: randomUUID(),
			generatedAt: Date.now(),
			periodStart: stats.period.startAt,
			periodEnd: stats.period.endAt,
			stats,
			delta,
			reportText,
		};
	}

	/** Send the report to a channel plugin. */
	async sendToChannel(
		report: GrowthReport,
		plugin: ChannelPlugin,
		channelId: string,
	): Promise<void> {
		await plugin.sendMessage(channelId, report.reportText);
		logger.info("Growth report sent to channel", {
			channelId,
			pluginId: plugin.id,
			reportId: report.id,
		});
	}

	/** Save report as history for future delta comparison. */
	async saveHistory(report: GrowthReport): Promise<void> {
		const history: ReportHistory = {
			id: report.id,
			generatedAt: report.generatedAt,
			periodStart: report.periodStart,
			periodEnd: report.periodEnd,
			conversationCount: report.stats.conversations.totalCount,
			uniqueUsers: report.stats.conversations.uniqueUsers,
			knowledgeCount: report.stats.knowledge.totalCount,
			relationshipCount: report.stats.conversations.newRelationships,
			reportText: report.reportText,
		};

		await this.config.historyStore.save(history);
		logger.info("Growth report history saved", { reportId: report.id });
	}

	/** Load the most recent report history. */
	async getLatestHistory(): Promise<ReportHistory | null> {
		return this.config.historyStore.getLatest();
	}
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

function buildReportPrompt(
	personaName: string,
	language: string,
	stats: GrowthStats,
	delta: GrowthDelta | null,
): string {
	const periodStart = new Date(stats.period.startAt).toLocaleDateString(
		language === "ko" ? "ko-KR" : "en-US",
	);
	const periodEnd = new Date(stats.period.endAt).toLocaleDateString(
		language === "ko" ? "ko-KR" : "en-US",
	);

	const sections = [
		`너는 "${personaName}"이라는 AI 펫이야.`,
		`아래 통계를 바탕으로 ${language === "ko" ? "한국어로" : "in English"} 성장 리포트를 작성해줘.`,
		"네 성격과 말투를 살려서 자연스럽고 재밌게 써줘.",
		"마크다운 형식으로 작성해줘.",
		"",
		`## 기간: ${periodStart} ~ ${periodEnd}`,
		"",
		"## 대화 통계",
		`- 총 메시지 수: ${stats.conversations.totalCount}`,
		`- 대화한 사용자 수: ${stats.conversations.uniqueUsers}`,
		`- 새로운 친구: ${stats.conversations.newRelationships}명`,
		"",
		"## 지식 성장",
		`- 새로 배운 것: ${stats.knowledge.newCount}개`,
		`- 총 지식: ${stats.knowledge.totalCount}개`,
		`- 주요 주제: ${stats.knowledge.mainTopics.join(", ") || "없음"}`,
		"",
		"## 영혼 진화",
		`- 새로운 특성: ${stats.soul.newTraits.join(", ") || "없음"}`,
		`- 관심 주제: ${stats.soul.preferredTopics.join(", ") || "없음"}`,
		`- 소통 스타일: ${stats.soul.communicationStyle || "아직 형성 중"}`,
		"",
		"## 활동 패턴",
		`- 피크 시간대: ${stats.activity.peakHours.map((h) => `${h}시`).join(", ") || "데이터 없음"}`,
		`- 총 세션 수: ${stats.activity.totalSessions}`,
		"",
		"## 성찰 하이라이트",
		...(stats.reflections.highlights.length > 0
			? stats.reflections.highlights.map((h) => `- ${h}`)
			: ["- 아직 성찰 기록이 없어요"]),
	];

	if (delta) {
		sections.push(
			"",
			"## 지난 리포트 대비 변화",
			`- 대화 수 변화: ${formatDelta(delta.conversationsDelta)}`,
			`- 사용자 수 변화: ${formatDelta(delta.uniqueUsersDelta)}`,
			`- 지식 변화: ${formatDelta(delta.knowledgeDelta)}`,
			`- 새 관계 변화: ${formatDelta(delta.newRelationshipsDelta)}`,
		);
	}

	return sections.join("\n");
}

function formatDelta(value: number): string {
	if (value > 0) return `+${value}`;
	return String(value);
}

/** Fallback report when Claude generation fails. */
function buildFallbackReport(
	stats: GrowthStats,
	delta: GrowthDelta | null,
): string {
	const lines = [
		"# Growth Report",
		"",
		`**Period**: ${new Date(stats.period.startAt).toISOString()} ~ ${new Date(stats.period.endAt).toISOString()}`,
		"",
		"## Conversations",
		`- Total messages: ${stats.conversations.totalCount}`,
		`- Unique users: ${stats.conversations.uniqueUsers}`,
		`- New relationships: ${stats.conversations.newRelationships}`,
		"",
		"## Knowledge",
		`- New: ${stats.knowledge.newCount}`,
		`- Total: ${stats.knowledge.totalCount}`,
	];

	if (delta) {
		lines.push(
			"",
			"## Delta",
			`- Conversations: ${formatDelta(delta.conversationsDelta)}`,
			`- Users: ${formatDelta(delta.uniqueUsersDelta)}`,
			`- Knowledge: ${formatDelta(delta.knowledgeDelta)}`,
		);
	}

	return lines.join("\n");
}
