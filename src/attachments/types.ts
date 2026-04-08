/**
 * Attachment types and MIME type constants for multimodal message support.
 */

export type Attachment = {
	readonly filename: string;
	readonly mimeType: string;
	readonly size: number;
	readonly url: string;
	readonly localPath?: string;
};

export const IMAGE_MIME_TYPES = [
	"image/jpeg",
	"image/png",
	"image/gif",
	"image/webp",
] as const;

export const DOCUMENT_MIME_TYPES = ["application/pdf"] as const;

export const TEXT_MIME_TYPES = [
	"text/plain",
	"text/markdown",
	"text/x-python",
	"text/javascript",
	"text/typescript",
	"application/json",
	"application/xml",
	"text/xml",
] as const;

export const ALLOWED_MIME_TYPES = [
	...IMAGE_MIME_TYPES,
	...DOCUMENT_MIME_TYPES,
	...TEXT_MIME_TYPES,
] as const;

export type AllowedMimeType = (typeof ALLOWED_MIME_TYPES)[number];

/** Check whether a MIME type is in the allowed list. */
export function isAllowedMimeType(
	mimeType: string,
): mimeType is AllowedMimeType {
	return (ALLOWED_MIME_TYPES as readonly string[]).includes(mimeType);
}

/** Check whether a MIME type is an image type (supported by Claude vision). */
export function isImageMimeType(mimeType: string): boolean {
	return (IMAGE_MIME_TYPES as readonly string[]).includes(mimeType);
}
