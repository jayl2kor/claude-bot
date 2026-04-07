/**
 * Git sync — checkout pet branch, pull before session, push after.
 * Only active when config.daemon.git.enabled is true.
 */

import { execFile } from "node:child_process";
import { logger } from "../utils/logger.js";

type GitConfig = {
	enabled: boolean;
	branch?: string;
	autoSync: boolean;
};

function git(cwd: string, args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile("git", args, { cwd, timeout: 30_000 }, (err, stdout, stderr) => {
			if (err) {
				reject(new Error(`git ${args.join(" ")} failed: ${stderr || err.message}`));
			} else {
				resolve(stdout.trim());
			}
		});
	});
}

export class GitSync {
	constructor(
		private readonly workspacePath: string,
		private readonly config: GitConfig,
		private readonly petId: string,
	) {}

	get enabled(): boolean {
		return this.config.enabled && !!this.config.branch;
	}

	/** Initialize: checkout pet branch and sync. */
	async init(): Promise<void> {
		if (!this.enabled) return;

		const branch = this.config.branch!;
		try {
			const current = await git(this.workspacePath, ["branch", "--show-current"]);
			if (current !== branch) {
				await git(this.workspacePath, ["checkout", branch]);
				logger.info("Git: checked out branch", { branch });
			}

			if (this.config.autoSync) {
				await this.syncFromMain();
			}
		} catch (err) {
			logger.error("Git init failed", { error: String(err) });
		}
	}

	/** Pre-session: sync latest from main. */
	async preSession(): Promise<void> {
		if (!this.enabled || !this.config.autoSync) return;
		await this.syncFromMain();
	}

	/** Post-session: commit and push changes. */
	async postSession(message?: string): Promise<void> {
		if (!this.enabled || !this.config.autoSync) return;

		try {
			const status = await git(this.workspacePath, ["status", "--porcelain"]);
			if (!status) return;

			await git(this.workspacePath, ["add", "-A"]);
			const commitMsg = message ?? `pet/${this.petId}: auto-commit`;
			await git(this.workspacePath, ["commit", "-m", commitMsg]);
			await git(this.workspacePath, ["push", "origin", this.config.branch!]);
			logger.info("Git: committed and pushed", { branch: this.config.branch });
		} catch (err) {
			logger.warn("Git post-session sync failed", { error: String(err) });
		}
	}

	/** Shared sync: fetch and rebase on origin/main. */
	private async syncFromMain(): Promise<void> {
		try {
			await git(this.workspacePath, ["fetch", "origin"]);
			await git(this.workspacePath, ["rebase", "origin/main"]);
			logger.debug("Git: rebased on origin/main");
		} catch (err) {
			logger.warn("Git sync from main failed, continuing with local state", {
				error: String(err),
			});
		}
	}
}
