/**
 * Promise-based sleep that can be cancelled via AbortSignal.
 * Resolves to true if slept full duration, false if aborted.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<boolean> {
	if (signal?.aborted) return Promise.resolve(false);

	return new Promise<boolean>((resolve) => {
		const timer = setTimeout(() => {
			cleanup();
			resolve(true);
		}, ms);

		function onAbort() {
			clearTimeout(timer);
			cleanup();
			resolve(false);
		}

		function cleanup() {
			signal?.removeEventListener("abort", onAbort);
		}

		signal?.addEventListener("abort", onAbort, { once: true });
	});
}
