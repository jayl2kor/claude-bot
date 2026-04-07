import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** Atomic JSON write: write to temp file, then rename into place. */
export async function atomicWriteJson(path: string, data: unknown): Promise<void> {
	const tmp = `${path}.${randomUUID()}.tmp`;
	await mkdir(dirname(path), { recursive: true });
	await writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
	await rename(tmp, path);
}

/** Sanitize a string for use as a filename. */
export function sanitizeKey(key: string): string {
	return key.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/** Extract the first JSON object from a text string. */
export function extractJsonFromText(text: string): unknown | null {
	const match = text.match(/\{[\s\S]*\}/);
	if (!match) return null;
	try {
		return JSON.parse(match[0]);
	} catch {
		return null;
	}
}
