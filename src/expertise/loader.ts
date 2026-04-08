/**
 * ExpertiseDocLoader — loads domain knowledge markdown files and formats
 * them as a system prompt section within a token budget.
 *
 * Files are loaded from `config/{petId}/expertise/*.md`.
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { isENOENT } from "../utils/errors.js";

const DEFAULT_TOKEN_BUDGET = 2500;

/** Rough token estimate: ~4 chars per token for English, ~2 for Korean. */
function estimateTokens(text: string): number {
	const koreanChars = (text.match(/[\uAC00-\uD7AF]/g) ?? []).length;
	const otherChars = text.length - koreanChars;
	return Math.ceil(koreanChars / 2 + otherChars / 4);
}

/** Truncate text to fit within a token budget. */
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

export class ExpertiseDocLoader {
	private readonly dir: string;
	private readonly tokenBudget: number;

	constructor(expertiseDir: string, tokenBudget?: number) {
		this.dir = expertiseDir;
		this.tokenBudget = tokenBudget ?? DEFAULT_TOKEN_BUDGET;
	}

	/** Load all .md files from the expertise directory and format as prompt section. */
	async toPromptSection(): Promise<string | null> {
		const docs = await this.loadDocs();
		if (docs.length === 0) return null;

		const body = docs.join("\n\n---\n\n");
		const section = `# 전문 지식\n\n${body}`;
		return truncateToTokenBudget(section, this.tokenBudget);
	}

	private async loadDocs(): Promise<string[]> {
		try {
			const files = await readdir(this.dir);
			const mdFiles = files.filter((f) => f.endsWith(".md")).sort();

			if (mdFiles.length === 0) return [];

			const docs: string[] = [];
			for (const file of mdFiles) {
				try {
					const content = await readFile(join(this.dir, file), "utf8");
					if (content.trim()) {
						docs.push(content.trim());
					}
				} catch {
					// Skip unreadable files
				}
			}
			return docs;
		} catch (err) {
			if (isENOENT(err)) return [];
			return [];
		}
	}
}
