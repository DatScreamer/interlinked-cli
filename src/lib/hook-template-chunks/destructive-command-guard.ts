// Single source of truth for destructive shell-command detection.
//
// Two consumers, one implementation:
//   1. `src/hook-entry.ts` imports `checkDestructiveCommand` directly and runs
//      it in the cold-fallback path (when the harness daemon is unreachable).
//   2. The generated `.interlinked/hooks/interlinked-activity.mjs` cannot
//      `import` anything — it must run standalone. `guards-inline.ts` embeds
//      `DESTRUCTIVE_COMMAND_GUARD_SOURCE` (the `Function.toString()` of
//      `checkDestructiveCommand`) verbatim into the .mjs template string.
//
// Before this module existed, the destructive-command regexes lived ONLY in
// the .mjs template string, and `hook-entry.ts`'s cold fallback ran none of
// them — so `rm -rf /` sailed through whenever the daemon was down on the
// hook-entry.ts path. One shared function makes the two hook paths
// destructive-guard-identical by construction; no hand-kept parity.
//
// IMPORTANT: `checkDestructiveCommand` MUST stay fully self-contained — no
// module-scope references, every helper nested inside it. `Function.toString()`
// serializes only the function's own body, so any outside reference would be
// undefined in the emitted .mjs. The `new Function` round-trip test in
// `__tests__/destructive-command-guard.test.ts` pins this invariant.

/** A destructive-command block verdict. `reason` is shown to the agent. */
export interface DestructiveCommandVerdict {
	decision: "block";
	reason: string;
}

/**
 * Detect destructive shell commands — process killing, recursive deletes,
 * history-rewriting git, DROP/TRUNCATE, infra teardown, and so on. A pure
 * function of the command string: no fs, no env, no state, so it is safe to
 * run inline on any hook path. Returns a block verdict, or `null` when the
 * command is not destructive.
 *
 * Kept as one flat ladder (rather than split into per-family helpers) so it
 * stays self-contained for `Function.toString()` embedding — see the module
 * header.
 */
export function checkDestructiveCommand(cmd: string): DestructiveCommandVerdict | null {
	// Blank out quoted/escaped/commented spans so a destructive verb that only
	// appears as quoted DATA (e.g. `echo "reboot"`) is not mistaken for an
	// executable verb.
	function maskInlineQuotedShell(value: string): string {
		const out: string[] = [];
		let quote: string | null = null;
		let escaped = false;
		let comment = false;
		const backtick = String.fromCharCode(96);
		for (let i = 0; i < value.length; i++) {
			const ch = value[i];
			if (comment) {
				if (ch === "\n") {
					comment = false;
					out.push(ch);
				} else {
					out.push(" ");
				}
				continue;
			}
			if (quote) {
				if (escaped) {
					escaped = false;
					out.push(" ");
					continue;
				}
				if (ch === "\\") {
					escaped = true;
					out.push(" ");
					continue;
				}
				if (ch === quote) quote = null;
				out.push(" ");
				continue;
			}
			if (ch === "#" && (i === 0 || /\s/.test(value[i - 1] || ""))) {
				comment = true;
				out.push(" ");
				continue;
			}
			if (ch === "'" || ch === '"' || ch === backtick) {
				quote = ch;
				out.push(" ");
				continue;
			}
			out.push(ch);
		}
		return out.join("");
	}

	// Shutdown/reboot detection. Anchored to a command-start position and
	// tolerant of wrapper chains (`sudo`, `env VAR=v`, `bash -c "..."`).
	function matchesInlineShutdown(cmdValue: string): boolean {
		const masked = maskInlineQuotedShell(cmdValue);
		const directRe =
			/(^|\|\||&&|[;|\n])\s*(?:(?:env(?:\s+[A-Za-z_]\w*=\S+)*|command|exec|nohup|sudo)\s+|(?:bash|sh)\s+-c\s*["']?\s*)*(shutdown|reboot|halt|poweroff|init\s+[06]|systemctl\s+(poweroff|reboot|halt))\b/i;
		const quotedShellRe =
			/(^|\|\||&&|[;|\n])\s*(?:(?:env(?:\s+[A-Za-z_]\w*=\S+)*|command|exec|nohup|sudo)\s+)*(?:bash|sh)\s+-c\s*["']\s*(?:(?:env(?:\s+[A-Za-z_]\w*=\S+)*|command|exec|nohup|sudo)\s+)*(shutdown|reboot|halt|poweroff|init\s+[06]|systemctl\s+(poweroff|reboot|halt))\b/i;
		return directRe.test(masked) || quotedShellRe.test(cmdValue);
	}

	if (matchesInlineShutdown(cmd)) {
		return { decision: "block", reason: "BLOCKED: System shutdown/reboot commands." };
	}

	// Context detection: skip data-only references (grep/echo/cat examining strings).
	if (
		/^\s*(grep|egrep|fgrep|rg|ag|echo|printf|cat|head|tail|less|more|wc|diff|test|\[)\s/.test(cmd)
	) {
		return null;
	}

	// --- Sleep ---
	if (/^\s*(sleep|bash\s+-c\s+.*sleep)\s+/i.test(cmd) || /;\s*sleep\s+/i.test(cmd)) {
		return {
			decision: "block",
			reason: "Do not use bash sleep. Use the wait_for_work MCP tool instead.",
		};
	}

	// --- Process killing ---
	if (/\b(killall|pkill|skill)\s/i.test(cmd)) {
		return {
			decision: "block",
			reason:
				"BLOCKED: Mass process-killing commands (pkill/killall). Use 'kill <PID>' to target a single process.",
		};
	}
	if (/\bkill\s+-[1-9][0-9]*\b/.test(cmd) || /\bkill\s+-SIG/i.test(cmd) || /\bkill\s+-s\s/i.test(cmd)) {
		return {
			decision: "block",
			reason: "BLOCKED: Sending termination signals. Use plain 'kill <PID>' (SIGTERM) instead.",
		};
	}
	if (/\bkill\s+[0-9]+\s+[0-9]+/.test(cmd)) {
		return {
			decision: "block",
			reason: "BLOCKED: Killing multiple PIDs at once. Kill one PID at a time.",
		};
	}
	if (/\bkill\s+\$\(/.test(cmd) || /\|\s*xargs\s+(.*\s)?kill/i.test(cmd)) {
		return {
			decision: "block",
			reason:
				"BLOCKED: kill with command substitution/xargs. Find the PID first, then kill it by number.",
		};
	}
	if (/\bpgrep\b.*\|\s*xargs\s+kill/i.test(cmd) || /\bps\s+(aux|ef)\b.*\bxargs\s+kill/i.test(cmd)) {
		return {
			decision: "block",
			reason: "BLOCKED: Pattern kills processes system-wide. Use specific PID.",
		};
	}

	// --- Filesystem destruction ---
	if (/\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r|--force\s+--recursive)\s/i.test(cmd)) {
		return {
			decision: "block",
			reason: "BLOCKED: Recursive force-delete (rm -rf). Use targeted, non-recursive removal.",
		};
	}
	if (
		/\brm\s+-[a-zA-Z]*r[a-zA-Z]*\s+\/(?!tmp\b|var\/tmp\b)/i.test(cmd) ||
		/\brm\s+-rf\s+\*/i.test(cmd)
	) {
		return {
			decision: "block",
			reason: "BLOCKED: Recursive deletion of root-level or wildcard paths. Be more specific.",
		};
	}
	if (
		/\brm\s+(-[rf]+\s+)*\.wrangler\s*($|&&|\||;)/.test(cmd) ||
		/\brm\s+(-[rf]+\s+)*\.wrangler\/state\b/.test(cmd)
	) {
		return {
			decision: "block",
			reason:
				"BLOCKED: .wrangler contains the local development database. Try: rm -rf .wrangler/cache (keeps database)",
		};
	}
	if (/\brm\s+(-[rf]+\s+)*node_modules\s*($|&&|\||;)/.test(cmd)) {
		return {
			decision: "block",
			reason:
				"BLOCKED: Deleting node_modules requires a full reinstall. Try: npm cache clean --force && npm install",
		};
	}
	if (/\bdd\s.*of=\/dev\//i.test(cmd)) {
		return { decision: "block", reason: "BLOCKED: Writing directly to block devices with dd." };
	}
	if (/(^|\s|;|&&)(mkfs|fdisk|parted|gdisk)\s/i.test(cmd)) {
		return { decision: "block", reason: "BLOCKED: Disk formatting/partitioning commands." };
	}
	if (/\bchmod\s+(-R\s+)?777\s+\//i.test(cmd)) {
		return { decision: "block", reason: "BLOCKED: chmod 777 on system paths is a security risk." };
	}
	if (/\bsudo\s+rm\b/.test(cmd)) {
		return { decision: "block", reason: "BLOCKED: sudo rm is extremely dangerous." };
	}

	// --- Git destruction ---
	if (/\bgit\s+push\s+.*--force(?!-with-lease)\b/i.test(cmd) || /\bgit\s+push\s+-f\b/i.test(cmd)) {
		return { decision: "block", reason: "BLOCKED: git push --force. Use --force-with-lease instead." };
	}
	if (/\bgit\s+reset\s+--hard\b/.test(cmd)) {
		return {
			decision: "block",
			reason: "BLOCKED: git reset --hard destroys all uncommitted changes. Use git stash first.",
		};
	}
	if (/\bgit\s+clean\s+-[a-zA-Z]*f/.test(cmd) && !/\bgit\s+clean\s+.*(-n|--dry-run)/.test(cmd)) {
		return {
			decision: "block",
			reason:
				"BLOCKED: git clean -f permanently deletes untracked files. Use git clean -n (dry-run) first.",
		};
	}
	if (/\bgit\s+checkout\s+--\s+\./.test(cmd)) {
		return { decision: "block", reason: "BLOCKED: git checkout -- . discards all unstaged changes." };
	}
	if (/\bgit\s+restore\s+--worktree\s/.test(cmd)) {
		return {
			decision: "block",
			reason: "BLOCKED: git restore --worktree discards working tree changes.",
		};
	}
	if (/\bgit\s+branch\s+-D\s/.test(cmd)) {
		return {
			decision: "block",
			reason: "BLOCKED: git branch -D force-deletes a branch without merge check. Use -d instead.",
		};
	}
	if (/\bgit\s+stash\s+(drop|clear)/i.test(cmd)) {
		return {
			decision: "block",
			reason: "BLOCKED: git stash drop/clear permanently removes stashed work.",
		};
	}
	if (/\bgit\s+restore\s+\./.test(cmd)) {
		return {
			decision: "block",
			reason: "BLOCKED: git restore . discards all unstaged changes. Use git stash first.",
		};
	}
	if (/\bgit\s+filter-branch\b/i.test(cmd) || /\bgit\s+filter-repo\b/i.test(cmd)) {
		return {
			decision: "block",
			reason: "BLOCKED: git filter-branch/filter-repo rewrites entire repository history.",
		};
	}
	// `git rebase` with an interactive flag. The flag match uses the
	// `(?:\S+\s+)*` shape rather than a leading `\b` — `\b` before `-i`
	// requires a word char immediately before the dash, so the old inline
	// regex `\b(-i|--interactive)\b` never matched a space-preceded flag
	// (i.e. every real invocation). Fixed here, in the shared source.
	if (/\bgit\s+rebase\s+(?:\S+\s+)*(?:-i|--interactive)\b/i.test(cmd)) {
		return {
			decision: "block",
			reason:
				"BLOCKED: git rebase -i opens an interactive editor that hangs a non-interactive agent. Use a non-interactive rebase or run it yourself.",
		};
	}
	if (/\bgit\s+add\s+(?:\S+\s+)*(?:-i|-p|-e|--interactive|--patch|--edit)\b/i.test(cmd)) {
		return {
			decision: "block",
			reason:
				"BLOCKED: git add -i/-p/-e opens an interactive prompt that hangs a non-interactive agent. Use git add <pathspec>.",
		};
	}

	// --- Database destruction ---
	if (/\b(DROP\s+(DATABASE|TABLE|SCHEMA)|TRUNCATE\s+TABLE)/i.test(cmd)) {
		return {
			decision: "block",
			reason: "BLOCKED: Destructive database operations (DROP/TRUNCATE).",
		};
	}
	if (/\bDELETE\s+FROM\s+\w+\s*;/i.test(cmd)) {
		return { decision: "block", reason: "BLOCKED: DELETE without WHERE clause removes all rows." };
	}
	if (/\b(dropDatabase|dropCollection)\s*\(/i.test(cmd)) {
		return { decision: "block", reason: "BLOCKED: MongoDB drop operations." };
	}
	if (/\bredis-cli\s.*(FLUSHALL|FLUSHDB)/i.test(cmd)) {
		return { decision: "block", reason: "BLOCKED: Redis FLUSHALL/FLUSHDB clears all data." };
	}

	// --- Container/orchestration ---
	if (/\bdocker\s+(system|volume|image)\s+prune/i.test(cmd)) {
		return { decision: "block", reason: "BLOCKED: docker prune removes potentially important data." };
	}
	if (/\bdocker[- ]compose\s+down\s+-v/i.test(cmd)) {
		return {
			decision: "block",
			reason: "BLOCKED: docker-compose down -v removes volumes (data loss). Use 'down' without -v.",
		};
	}
	if (/\bkubectl\s+delete\s+(namespace|ns|all)\s/i.test(cmd)) {
		return {
			decision: "block",
			reason: "BLOCKED: kubectl mass deletion. Delete specific resources instead.",
		};
	}
	if (/\bkubectl\s+drain\s/i.test(cmd)) {
		return { decision: "block", reason: "BLOCKED: kubectl drain evicts all pods from a node." };
	}

	// --- Infrastructure-as-Code ---
	if (/\bterraform\s+destroy/i.test(cmd)) {
		return { decision: "block", reason: "BLOCKED: terraform destroy removes infrastructure." };
	}
	if (/\bterraform\s+apply\s+.*-auto-approve/i.test(cmd)) {
		return { decision: "block", reason: "BLOCKED: terraform apply -auto-approve skips human review." };
	}
	if (/\bpulumi\s+destroy/i.test(cmd)) {
		return { decision: "block", reason: "BLOCKED: pulumi destroy removes infrastructure." };
	}

	// --- Cloud provider ---
	if (/\baws\s.*(terminate-instances|delete-db-instance|delete-stack|delete-bucket)/i.test(cmd)) {
		return { decision: "block", reason: "BLOCKED: AWS destructive operations." };
	}
	if (/\baws\s+s3\s+(rm|mv)\s+.*--recursive/i.test(cmd)) {
		return { decision: "block", reason: "BLOCKED: Recursive S3 operations." };
	}
	if (/\brsync\s+.*--delete/i.test(cmd)) {
		return {
			decision: "block",
			reason: "BLOCKED: rsync --delete can wipe files at the destination.",
		};
	}

	// --- System-level ---
	// Re-checks shutdown/reboot directly (the early `matchesInlineShutdown`
	// gate also runs, before the data-only skip); kept so this ladder mirrors
	// the harness rule at builtin-rules-processes.ts one-to-one.
	if (
		/(^|\|\||&&|[;|\n])\s*(?:(?:env(?:\s+[A-Za-z_]\w*=\S+)*|command|exec|nohup|sudo)\s+|(?:bash|sh)\s+-c\s*["']?\s*)*(shutdown|reboot|halt|poweroff|init\s+[06]|systemctl\s+(poweroff|reboot|halt))\b/i.test(cmd)
	) {
		return { decision: "block", reason: "BLOCKED: System shutdown/reboot commands." };
	}
	if (/\b(lvremove|vgremove|pvremove)\s/i.test(cmd)) {
		return { decision: "block", reason: "BLOCKED: LVM removal commands." };
	}

	// --- Embedded destructive commands ---
	if (/(python3?|node|ruby|perl)\s+-(c|e)\s+.*\b(os\.remove|shutil\.rmtree|unlink|rimraf)\b/i.test(cmd)) {
		return {
			decision: "block",
			reason: "BLOCKED: Inline script containing destructive file operations.",
		};
	}
	if (/\bbash\s+-c\s+.*\b(rm\s+-rf|killall|pkill)\b/i.test(cmd)) {
		return {
			decision: "block",
			reason:
				"BLOCKED: Destructive command embedded in bash -c. Run directly so it can be properly reviewed.",
		};
	}

	return null;
}

/**
 * Source text of `checkDestructiveCommand`, for embedding into the
 * zero-import generated .mjs hook (which cannot `import`). `guards-inline.ts`
 * splices this in so the .mjs and `hook-entry.ts` run identical code.
 */
export const DESTRUCTIVE_COMMAND_GUARD_SOURCE: string = checkDestructiveCommand.toString();
