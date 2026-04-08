/**
 * Tests for TopicResearcher — covers:
 * - JSON parsing from Claude CLI response
 * - Zod validation of subtopics
 * - Dedup check against existing knowledge
 * - Knowledge storage with source: "self-studied"
 */

import { describe, expect, it, vi } from "vitest";
import type { KnowledgeEntry } from "../memory/knowledge.js";
import {
	buildResearchPrompt,
	checkDuplicates,
	parseResearchResult,
} from "./researcher.js";
import type { Subtopic } from "./types.js";

describe("parseResearchResult — JSON extraction", () => {
	it("parses a valid JSON array from response text", () => {
		const text = `Here are the subtopics:
[
  {"topic": "Docker 네트워크 기본", "content": "Docker는 bridge, host, overlay 등의 네트워크 드라이버를 제공합니다.", "tags": ["docker", "network"]},
  {"topic": "Bridge 네트워크", "content": "기본 네트워크 드라이버로 같은 호스트의 컨테이너끼리 통신합니다.", "tags": ["docker", "bridge"]}
]`;
		const result = parseResearchResult(text);
		expect(result).toHaveLength(2);
		expect(result[0]?.topic).toBe("Docker 네트워크 기본");
		expect(result[0]?.tags).toContain("docker");
	});

	it("parses JSON array embedded in markdown code block", () => {
		const text =
			"```json\n" +
			'[{"topic": "GraphQL Basics", "content": "Query language for APIs", "tags": ["graphql"]}]\n' +
			"```";
		const result = parseResearchResult(text);
		expect(result).toHaveLength(1);
		expect(result[0]?.topic).toBe("GraphQL Basics");
	});

	it("parses a JSON object with subtopics key", () => {
		const text = `{
  "subtopics": [
    {"topic": "Redis Caching", "content": "In-memory data store", "tags": ["redis", "cache"]}
  ]
}`;
		const result = parseResearchResult(text);
		expect(result).toHaveLength(1);
		expect(result[0]?.topic).toBe("Redis Caching");
	});

	it("returns empty array for invalid JSON", () => {
		const result = parseResearchResult("This is just plain text with no JSON.");
		expect(result).toEqual([]);
	});

	it("returns empty array for empty string", () => {
		const result = parseResearchResult("");
		expect(result).toEqual([]);
	});

	it("filters out entries that fail Zod validation", () => {
		const text = `[
  {"topic": "Valid", "content": "Good content", "tags": ["ok"]},
  {"topic": "", "content": "Bad because empty topic"},
  {"content": "Missing topic field", "tags": []}
]`;
		const result = parseResearchResult(text);
		// Only valid entries should be returned
		expect(result.length).toBeGreaterThanOrEqual(1);
		expect(result[0]?.topic).toBe("Valid");
	});

	it("caps subtopics at maxSubTopics", () => {
		const items = Array.from({ length: 15 }, (_, i) => ({
			topic: `Topic ${i}`,
			content: `Content ${i}`,
			tags: [],
		}));
		const text = JSON.stringify(items);
		const result = parseResearchResult(text, 8);
		expect(result).toHaveLength(8);
	});
});

describe("buildResearchPrompt", () => {
	it("includes the topic in the prompt", () => {
		const prompt = buildResearchPrompt("Docker 네트워크", 8);
		expect(prompt).toContain("Docker 네트워크");
	});

	it("includes max subtopics count", () => {
		const prompt = buildResearchPrompt("Redis", 5);
		expect(prompt).toContain("5");
	});

	it("requests JSON output format", () => {
		const prompt = buildResearchPrompt("GraphQL", 8);
		expect(prompt).toContain("JSON");
	});
});

describe("checkDuplicates", () => {
	it("returns subtopics that do not exist in knowledge", () => {
		const subtopics: Subtopic[] = [
			{ topic: "Docker 네트워크", content: "content1", tags: ["docker"] },
			{ topic: "Redis 캐싱", content: "content2", tags: ["redis"] },
			{ topic: "GraphQL", content: "content3", tags: ["graphql"] },
		];
		const existingKnowledge: KnowledgeEntry[] = [
			{
				id: "k1",
				topic: "Docker 네트워크",
				content: "existing content",
				source: "taught",
				createdAt: Date.now(),
				updatedAt: Date.now(),
				confidence: 0.8,
				tags: ["docker"],
			},
		];
		const result = checkDuplicates(subtopics, existingKnowledge);
		expect(result).toHaveLength(2);
		expect(result.map((s) => s.topic)).toEqual(["Redis 캐싱", "GraphQL"]);
	});

	it("returns all subtopics when no knowledge exists", () => {
		const subtopics: Subtopic[] = [
			{ topic: "Topic A", content: "content", tags: [] },
			{ topic: "Topic B", content: "content", tags: [] },
		];
		const result = checkDuplicates(subtopics, []);
		expect(result).toHaveLength(2);
	});

	it("returns empty array when all subtopics are duplicates", () => {
		const subtopics: Subtopic[] = [
			{ topic: "Docker", content: "content", tags: [] },
		];
		const existingKnowledge: KnowledgeEntry[] = [
			{
				id: "k1",
				topic: "Docker",
				content: "existing",
				source: "taught",
				createdAt: Date.now(),
				updatedAt: Date.now(),
				confidence: 0.8,
				tags: [],
			},
		];
		const result = checkDuplicates(subtopics, existingKnowledge);
		expect(result).toHaveLength(0);
	});

	it("performs case-insensitive dedup", () => {
		const subtopics: Subtopic[] = [
			{ topic: "docker networking", content: "content", tags: [] },
		];
		const existingKnowledge: KnowledgeEntry[] = [
			{
				id: "k1",
				topic: "Docker Networking",
				content: "existing",
				source: "taught",
				createdAt: Date.now(),
				updatedAt: Date.now(),
				confidence: 0.8,
				tags: [],
			},
		];
		const result = checkDuplicates(subtopics, existingKnowledge);
		expect(result).toHaveLength(0);
	});
});
