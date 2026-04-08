/**
 * DelegationBuilder — builds delegation prompt section from deferTo mapping.
 *
 * Checks StatusReader for target pet online/offline status.
 * If offline: "직접 도와줘" fallback.
 */

import type { StatusReader } from "../status/reader.js";

const DEFAULT_TOKEN_BUDGET = 400;

/** Rough token estimate: ~4 chars per token for English, ~2 for Korean. */
function estimateTokens(text: string): number {
	const koreanChars = (text.match(/[\uAC00-\uD7AF]/g) ?? []).length;
	const otherChars = text.length - koreanChars;
	return Math.ceil(koreanChars / 2 + otherChars / 4);
}

function truncateToTokenBudget(text: string, budget: number): string {
	if (estimateTokens(text) <= budget) return text;

	let lo = 0;
	let hi = text.length;
	while (lo < hi) {
		const mid = Math.ceil((lo + hi) / 2);
		if (estimateTokens(text.slice(0, mid)) <= budget) {
			lo = mid;
		} else {
			hi = mid - 1;
		}
	}
	return `${text.slice(0, lo)}...`;
}

export class DelegationBuilder {
	constructor(
		private readonly deferTo: Record<string, string>,
		private readonly statusReader: StatusReader | undefined,
	) {}

	/** Build delegation prompt section. Returns null if no deferTo entries. */
	async toPromptSection(): Promise<string | null> {
		const entries = Object.entries(this.deferTo);
		if (entries.length === 0) return null;

		const onlineNames = await this.getOnlineNames();

		const lines = ["# 전문 분야 및 위임", ""];

		for (const [domain, petName] of entries) {
			const isOnline = onlineNames.has(petName);
			if (isOnline) {
				lines.push(`- **${domain}**: ${petName}에게 위임 가능 (온라인)`);
			} else {
				lines.push(`- **${domain}**: ${petName} 오프라인 — 직접 도와줘`);
			}
		}

		const section = lines.join("\n");
		return truncateToTokenBudget(section, DEFAULT_TOKEN_BUDGET);
	}

	private async getOnlineNames(): Promise<Set<string>> {
		if (!this.statusReader) return new Set();

		try {
			const others = await this.statusReader.readOthers();
			return new Set(others.map((p) => p.personaName));
		} catch {
			return new Set();
		}
	}
}
