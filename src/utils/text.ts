/** Split a message into chunks that fit within a character limit. */
export function splitMessage(content: string, limit: number): string[] {
	if (content.length <= limit) return [content];

	const chunks: string[] = [];
	let remaining = content;

	while (remaining.length > 0) {
		if (remaining.length <= limit) {
			chunks.push(remaining);
			break;
		}

		let splitAt = remaining.lastIndexOf("\n", limit);
		if (splitAt <= 0) splitAt = remaining.lastIndexOf(" ", limit);
		if (splitAt <= 0) splitAt = limit;

		chunks.push(remaining.slice(0, splitAt));
		remaining = remaining.slice(splitAt).trimStart();
	}

	return chunks;
}
