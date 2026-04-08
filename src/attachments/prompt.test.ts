/**
 * Tests for attachment prompt injection — covers:
 * - Image attachments inject "[이미지 첨부됨: /path]" into user prompt
 * - File attachments inject "[파일 첨부됨: /path]" into user prompt
 * - Multiple attachments are all included
 * - Attachment info stays in user prompt, NOT in system prompt
 * - Messages without attachments are unchanged
 */

import { describe, expect, it } from "vitest";
import { buildAttachmentPrompt } from "./prompt.js";
import type { Attachment } from "./types.js";

// ---------------------------------------------------------------------------
// Prompt injection for attachments
// ---------------------------------------------------------------------------

describe("buildAttachmentPrompt", () => {
	it("returns original content when no attachments", () => {
		const result = buildAttachmentPrompt("hello", []);
		expect(result).toBe("hello");
	});

	it("returns original content when attachments is undefined", () => {
		const result = buildAttachmentPrompt("hello", undefined);
		expect(result).toBe("hello");
	});

	it("injects image path with Korean label", () => {
		const attachments: readonly Attachment[] = [
			{
				filename: "photo.jpg",
				mimeType: "image/jpeg",
				size: 1000,
				url: "https://example.com/photo.jpg",
				localPath: "/data/uploads/2026-04-08/1234-photo.jpg",
			},
		];

		const result = buildAttachmentPrompt("이 사진 봐", attachments);

		expect(result).toContain(
			"[이미지 첨부됨: /data/uploads/2026-04-08/1234-photo.jpg]",
		);
		expect(result).toContain("이 사진 봐");
	});

	it("injects file path with Korean label for non-image files", () => {
		const attachments: readonly Attachment[] = [
			{
				filename: "report.pdf",
				mimeType: "application/pdf",
				size: 5000,
				url: "https://example.com/report.pdf",
				localPath: "/data/uploads/2026-04-08/5678-report.pdf",
			},
		];

		const result = buildAttachmentPrompt("이 문서 분석해줘", attachments);

		expect(result).toContain(
			"[파일 첨부됨: /data/uploads/2026-04-08/5678-report.pdf]",
		);
		expect(result).toContain("이 문서 분석해줘");
	});

	it("injects file path for text files", () => {
		const attachments: readonly Attachment[] = [
			{
				filename: "code.ts",
				mimeType: "text/typescript",
				size: 200,
				url: "https://example.com/code.ts",
				localPath: "/data/uploads/2026-04-08/9999-code.ts",
			},
		];

		const result = buildAttachmentPrompt("이 코드 리뷰해줘", attachments);

		expect(result).toContain(
			"[파일 첨부됨: /data/uploads/2026-04-08/9999-code.ts]",
		);
	});

	it("handles multiple attachments", () => {
		const attachments: readonly Attachment[] = [
			{
				filename: "img1.png",
				mimeType: "image/png",
				size: 1000,
				url: "https://example.com/img1.png",
				localPath: "/data/uploads/2026-04-08/1-img1.png",
			},
			{
				filename: "img2.jpg",
				mimeType: "image/jpeg",
				size: 2000,
				url: "https://example.com/img2.jpg",
				localPath: "/data/uploads/2026-04-08/2-img2.jpg",
			},
			{
				filename: "notes.txt",
				mimeType: "text/plain",
				size: 100,
				url: "https://example.com/notes.txt",
				localPath: "/data/uploads/2026-04-08/3-notes.txt",
			},
		];

		const result = buildAttachmentPrompt("여러 파일이야", attachments);

		expect(result).toContain(
			"[이미지 첨부됨: /data/uploads/2026-04-08/1-img1.png]",
		);
		expect(result).toContain(
			"[이미지 첨부됨: /data/uploads/2026-04-08/2-img2.jpg]",
		);
		expect(result).toContain(
			"[파일 첨부됨: /data/uploads/2026-04-08/3-notes.txt]",
		);
	});

	it("skips attachments without localPath", () => {
		const attachments: readonly Attachment[] = [
			{
				filename: "failed.jpg",
				mimeType: "image/jpeg",
				size: 1000,
				url: "https://example.com/failed.jpg",
				// No localPath — download failed
			},
		];

		const result = buildAttachmentPrompt("이 사진 봐", attachments);

		expect(result).toBe("이 사진 봐");
		expect(result).not.toContain("[이미지");
		expect(result).not.toContain("[파일");
	});

	it("preserves user content without modification", () => {
		const attachments: readonly Attachment[] = [
			{
				filename: "photo.jpg",
				mimeType: "image/jpeg",
				size: 1000,
				url: "https://example.com/photo.jpg",
				localPath: "/data/uploads/photo.jpg",
			},
		];

		const content = "중요한 메시지\n여러 줄로\n작성됨";
		const result = buildAttachmentPrompt(content, attachments);

		expect(result).toContain(content);
	});

	it("places attachment info after user content", () => {
		const attachments: readonly Attachment[] = [
			{
				filename: "photo.jpg",
				mimeType: "image/jpeg",
				size: 1000,
				url: "https://example.com/photo.jpg",
				localPath: "/data/uploads/photo.jpg",
			},
		];

		const result = buildAttachmentPrompt("user text", attachments);

		const userIdx = result.indexOf("user text");
		const attachIdx = result.indexOf("[이미지 첨부됨:");
		expect(attachIdx).toBeGreaterThan(userIdx);
	});
});
