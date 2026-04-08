/**
 * /기억 slash command handler.
 * Searches knowledge, reflections, and relationships for a keyword.
 */

import type { KnowledgeManager } from "../memory/knowledge.js";
import type { ReflectionManager } from "../memory/reflection.js";
import type { RelationshipManager } from "../memory/relationships.js";
import type { CommandInteraction } from "../plugins/types.js";

export type MemorySearchDeps = {
	knowledge: KnowledgeManager;
	reflections: ReflectionManager;
	relationships: RelationshipManager;
};

export async function handleMemorySearch(
	interaction: CommandInteraction,
	deps: MemorySearchDeps,
): Promise<void> {
	const keyword = interaction.options.keyword as string | undefined;
	if (!keyword) {
		await interaction.reply("검색할 키워드를 입력해주세요!");
		return;
	}

	await interaction.deferReply();

	const sections: string[] = [];

	// Search knowledge
	const knowledgeResults = await deps.knowledge.search(keyword, 5);
	if (knowledgeResults.length > 0) {
		sections.push("**📚 지식**");
		for (const entry of knowledgeResults) {
			const source =
				entry.source === "taught"
					? "가르침"
					: entry.source === "corrected"
						? "수정됨"
						: "추론";
			const strengthPct = Math.round(entry.strength * 100);
			const filled = Math.round(entry.strength * 6);
			const empty = 6 - filled;
			const bar = `${"█".repeat(filled)}${"░".repeat(empty)}`;
			sections.push(
				`> **${entry.topic}** (${source}) [강도: ${bar} ${strengthPct}%]\n> ${entry.content}`,
			);
		}
	}

	// Search reflections
	const allReflections = await deps.reflections.getRecent(20);
	const matchingReflections = allReflections.filter(
		(r) =>
			r.summary.toLowerCase().includes(keyword.toLowerCase()) ||
			r.insights.some((i) => i.toLowerCase().includes(keyword.toLowerCase())),
	);
	if (matchingReflections.length > 0) {
		sections.push("**💭 대화 기록**");
		for (const ref of matchingReflections.slice(0, 3)) {
			const date = new Date(ref.createdAt).toLocaleDateString("ko-KR");
			sections.push(`> **${date}** — ${ref.summary}`);
		}
	}

	// Search relationships
	const rel = await deps.relationships.get(interaction.userId);
	if (rel) {
		const matchingNotes = rel.notes.filter((n) =>
			n.toLowerCase().includes(keyword.toLowerCase()),
		);
		if (matchingNotes.length > 0) {
			sections.push("**📝 메모**");
			for (const note of matchingNotes.slice(0, 3)) {
				sections.push(`> ${note}`);
			}
		}
	}

	if (sections.length === 0) {
		await interaction.editReply(`🔍 "${keyword}"에 대한 기억이 없습니다.`);
		return;
	}

	const result = `🔍 **"${keyword}" 검색 결과**\n\n${sections.join("\n\n")}`;

	// Truncate if too long for Discord
	const truncated =
		result.length > 1900
			? `${result.slice(0, 1900)}...\n\n*(결과가 잘렸습니다)*`
			: result;
	await interaction.editReply(truncated);
}
