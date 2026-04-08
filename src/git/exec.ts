/**
 * Shared git command executor.
 * Extracted from daemon/git-sync.ts for reuse across git modules.
 */

import { execFile } from "node:child_process";

export function git(cwd: string, args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile("git", args, { cwd, timeout: 30_000 }, (err, stdout, stderr) => {
			if (err) {
				reject(
					new Error(`git ${args.join(" ")} failed: ${stderr || err.message}`),
				);
			} else {
				resolve(stdout.trim());
			}
		});
	});
}
