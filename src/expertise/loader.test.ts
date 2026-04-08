/**
 * Tests for ExpertiseDocLoader — covers:
 * - Loading .md files from expertise directory
 * - Handling missing directory gracefully
 * - Token budget estimation and truncation
 * - Formatting as prompt section
 */

import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { ExpertiseDocLoader } from "./loader.js";

async function makeTempDir(): Promise<string> {
	const dir = join(tmpdir(), `claude-pet-loader-test-${randomUUID()}`);
	await mkdir(dir, { recursive: true });
	return dir;
}

describe("ExpertiseDocLoader", () => {
	let expertiseDir: string;

	beforeEach(async () => {
		expertiseDir = await makeTempDir();
	});

	it("loads a single markdown file", async () => {
		await writeFile(
			join(expertiseDir, "docker.md"),
			"# Docker\nUse multi-stage builds.",
			"utf8",
		);
		const loader = new ExpertiseDocLoader(expertiseDir);
		const section = await loader.toPromptSection();
		expect(section).toContain("Docker");
		expect(section).toContain("multi-stage builds");
	});

	it("loads multiple markdown files", async () => {
		await writeFile(join(expertiseDir, "docker.md"), "# Docker", "utf8");
		await writeFile(join(expertiseDir, "k8s.md"), "# Kubernetes", "utf8");
		const loader = new ExpertiseDocLoader(expertiseDir);
		const section = await loader.toPromptSection();
		expect(section).toContain("Docker");
		expect(section).toContain("Kubernetes");
	});

	it("returns null when directory does not exist", async () => {
		const loader = new ExpertiseDocLoader(join(expertiseDir, "nonexistent"));
		const section = await loader.toPromptSection();
		expect(section).toBeNull();
	});

	it("returns null when directory is empty", async () => {
		const loader = new ExpertiseDocLoader(expertiseDir);
		const section = await loader.toPromptSection();
		expect(section).toBeNull();
	});

	it("ignores non-markdown files", async () => {
		await writeFile(join(expertiseDir, "notes.txt"), "Some notes", "utf8");
		await writeFile(join(expertiseDir, "docker.md"), "# Docker", "utf8");
		const loader = new ExpertiseDocLoader(expertiseDir);
		const section = await loader.toPromptSection();
		expect(section).toContain("Docker");
		expect(section).not.toContain("Some notes");
	});

	it("includes section header", async () => {
		await writeFile(join(expertiseDir, "test.md"), "Content", "utf8");
		const loader = new ExpertiseDocLoader(expertiseDir);
		const section = await loader.toPromptSection();
		expect(section).toContain("# 전문 지식");
	});

	it("truncates content that exceeds token budget", async () => {
		// Generate a large document that exceeds 2500 tokens (~10000 chars for English)
		const longContent = "Docker is great. ".repeat(3000);
		await writeFile(join(expertiseDir, "long.md"), longContent, "utf8");
		const loader = new ExpertiseDocLoader(expertiseDir);
		const section = await loader.toPromptSection();
		expect(section).not.toBeNull();
		// Should be truncated — significantly shorter than original
		expect(section?.length).toBeLessThan(longContent.length);
		expect(section).toContain("...");
	});

	it("respects custom token budget", async () => {
		const content = "Docker info. ".repeat(200);
		await writeFile(join(expertiseDir, "doc.md"), content, "utf8");
		const loader = new ExpertiseDocLoader(expertiseDir, 100);
		const section = await loader.toPromptSection();
		expect(section).not.toBeNull();
		// With tiny budget of 100 tokens, output should be very small
		expect(section?.length).toBeLessThan(1000);
	});
});
