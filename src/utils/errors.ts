/**
 * Transient errors are retryable — network timeouts, rate limits, temporary failures.
 * The daemon should back off and retry.
 */
export class TransientError extends Error {
	readonly retryable = true as const;

	constructor(
		message: string,
		readonly statusCode?: number,
	) {
		super(message);
		this.name = "TransientError";
	}
}

/**
 * Fatal errors are not retryable — auth failure, invalid config, resource not found.
 * The daemon should log and stop retrying.
 */
export class FatalError extends Error {
	readonly retryable = false as const;

	constructor(
		message: string,
		readonly statusCode?: number,
	) {
		super(message);
		this.name = "FatalError";
	}
}

export function isFatalError(err: unknown): err is FatalError {
	return err instanceof FatalError;
}

export function isTransientError(err: unknown): err is TransientError {
	return err instanceof TransientError;
}

export function errorMessage(err: unknown): string {
	if (err instanceof Error) return err.message;
	return String(err);
}

export function isENOENT(err: unknown): boolean {
	return (
		err instanceof Error &&
		"code" in err &&
		(err as NodeJS.ErrnoException).code === "ENOENT"
	);
}
