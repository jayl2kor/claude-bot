/**
 * AttachmentDownloader — streaming download with validation.
 *
 * Downloads attachments to date-based upload directories.
 * Enforces MIME type allowlist and file size limits.
 * Sanitizes filenames to prevent path traversal.
 */

import { createWriteStream } from "node:fs";
import { mkdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { Writable } from "node:stream";
import { isAllowedMimeType } from "./types.js";

export type DownloadSuccess = {
	readonly ok: true;
	readonly localPath: string;
	readonly size: number;
};

export type DownloadFailure = {
	readonly ok: false;
	readonly error: string;
};

export type DownloadResult = DownloadSuccess | DownloadFailure;

export type DownloaderConfig = {
	readonly maxFileSizeMb?: number;
};

const DEFAULT_MAX_FILE_SIZE_MB = 10;

export class AttachmentDownloader {
	private readonly maxFileSizeBytes: number;

	constructor(config?: DownloaderConfig) {
		const maxMb = config?.maxFileSizeMb ?? DEFAULT_MAX_FILE_SIZE_MB;
		this.maxFileSizeBytes = maxMb * 1024 * 1024;
	}

	/**
	 * Download a file from `url` into `uploadDir/{date}/{timestamp}-{sanitized}`.
	 *
	 * @param url        Remote URL to download
	 * @param uploadDir  Root upload directory (e.g. data/petId/uploads)
	 * @param filename   Original filename from the attachment
	 * @param mimeType   Declared MIME type
	 * @param size       Declared file size in bytes
	 */
	async download(
		url: string,
		uploadDir: string,
		filename: string,
		mimeType: string,
		size: number,
	): Promise<DownloadResult> {
		// 1. Validate MIME type
		if (!isAllowedMimeType(mimeType)) {
			return {
				ok: false,
				error: `Disallowed MIME type: ${mimeType}. Only images, PDFs, and text files are supported.`,
			};
		}

		// 2. Validate declared size
		if (size > this.maxFileSizeBytes) {
			return {
				ok: false,
				error: `File size ${formatBytes(size)} exceeds limit of ${formatBytes(this.maxFileSizeBytes)}.`,
			};
		}

		// 3. Build safe local path
		const dateDir = new Date().toISOString().slice(0, 10);
		const safeName = sanitizeFilename(filename);
		const targetDir = join(uploadDir, dateDir);
		const localPath = join(targetDir, `${Date.now()}-${safeName}`);

		await mkdir(targetDir, { recursive: true });

		// 4. Stream download with size enforcement
		try {
			const res = await fetch(url);
			if (!res.ok) {
				return {
					ok: false,
					error: `Download failed: HTTP ${res.status}`,
				};
			}

			if (!res.body) {
				return { ok: false, error: "Download failed: empty response body" };
			}

			const actualSize = await streamToFile(
				res.body,
				localPath,
				this.maxFileSizeBytes,
			);

			return { ok: true, localPath, size: actualSize };
		} catch (err) {
			// Clean up partial file on error
			await unlink(localPath).catch(() => {});
			if (err instanceof SizeLimitExceededError) {
				return {
					ok: false,
					error: `File size exceeds limit of ${formatBytes(this.maxFileSizeBytes)} during download.`,
				};
			}
			return {
				ok: false,
				error: `Download failed: ${err instanceof Error ? err.message : String(err)}`,
			};
		}
	}
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

class SizeLimitExceededError extends Error {
	constructor(limit: number) {
		super(`Stream exceeded size limit of ${formatBytes(limit)}`);
		this.name = "SizeLimitExceededError";
	}
}

/**
 * Stream a ReadableStream<Uint8Array> to a local file, aborting if it
 * exceeds `maxBytes`.
 *
 * Returns the number of bytes written.
 */
async function streamToFile(
	body: ReadableStream<Uint8Array>,
	path: string,
	maxBytes: number,
): Promise<number> {
	const writer = createWriteStream(path);
	let bytesWritten = 0;

	const reader = body.getReader();

	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;

			bytesWritten += value.byteLength;
			if (bytesWritten > maxBytes) {
				writer.destroy();
				await unlink(path).catch(() => {});
				throw new SizeLimitExceededError(maxBytes);
			}

			const canContinue = writer.write(value);
			if (!canContinue) {
				await new Promise<void>((resolve) => writer.once("drain", resolve));
			}
		}
	} finally {
		reader.releaseLock();
	}

	// Close the write stream
	await new Promise<void>((resolve, reject) => {
		writer.end(() => resolve());
		writer.on("error", reject);
	});

	return bytesWritten;
}

/**
 * Sanitize a filename to prevent path traversal and special character issues.
 * - Strips directory components (../, /)
 * - Removes special characters
 * - Falls back to "attachment" if empty
 */
function sanitizeFilename(raw: string): string {
	// Remove path separators and traversal
	let safe = raw.replace(/[/\\]/g, "").replace(/\.\./g, "");

	// Remove special characters, keep alphanumeric, dash, underscore, dot
	safe = safe.replace(/[^a-zA-Z0-9._-]/g, "");

	// Collapse consecutive dots (prevent hidden files tricks)
	safe = safe.replace(/\.{2,}/g, ".");

	// Remove leading dots
	safe = safe.replace(/^\.+/, "");

	if (!safe) {
		safe = "attachment";
	}

	return safe;
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
