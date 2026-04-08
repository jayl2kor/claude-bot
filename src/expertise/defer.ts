/**
 * DelegationBuilder — builds delegation prompt section from deferTo mapping.
 *
 * Checks StatusReader for target pet online/offline status.
 * If offline: "직접 도와줘" fallback.
 */

import type { StatusReader } from "../status/reader.js";
import { truncateToTokenBudget } from "../utils/tokens.js";

const DEFAULT_TOKEN_BUDGET = 400;

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

		const lines = [
			"# 전문 분야 및 위임",
			"",
			"업무를 위임하려면 디스코드에서 해당 붕이를 `<@ID>` 형식으로 멘션하면서 지시하면 됩니다.",
			"(멘션 ID는 공통 규칙의 '디스코드 멘션 방법' 참고)",
			"",
		];

		for (const [domain, petName] of entries) {
			const isOnline = onlineNames.has(petName);
			if (isOnline) {
				lines.push(
					`- **${domain}**: ${petName}에게 위임 가능 (온라인) — 디스코드 멘션으로 업무 지시`,
				);
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
