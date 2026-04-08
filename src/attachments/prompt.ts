/**
 * Build attachment-aware prompt text.
 *
 * Injects file path references into the user prompt so Claude CLI
 * can read them with its Read tool.
 *
 * Images: [이미지 첨부됨: /path/to/img.jpg]
 * Other files: [파일 첨부됨: /path/to/file.pdf]
 */

import type { Attachment } from "./types.js";
import { isImageMimeType } from "./types.js";

/**
 * Append attachment references to user content.
 * Only includes attachments that have a localPath (successfully downloaded).
 */
export function buildAttachmentPrompt(
	content: string,
	attachments: readonly Attachment[] | undefined,
): string {
	if (!attachments || attachments.length === 0) return content;

	const refs = attachments
		.filter((a) => a.localPath)
		.map((a) => {
			if (isImageMimeType(a.mimeType)) {
				return `[이미지 첨부됨: ${a.localPath}]`;
			}
			return `[파일 첨부됨: ${a.localPath}]`;
		});

	if (refs.length === 0) return content;

	return `${content}\n\n${refs.join("\n")}`;
}
