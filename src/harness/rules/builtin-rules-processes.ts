// ===========================================
// Built-in Rules — Process and Filesystem Destruction
// ===========================================
// Covers kill/pkill/killall (with signal/xargs variants), dangerous rm,
// git force/reset/branch destruction, filesystem wipes (dd/mkfs/shred/wipefs),
// system-level operations (sudo rm, chmod 777, shutdown, LVM), and inline
// shell-level destructive commands.

import type { GuardRule } from "../types.js";

/**
 * Public API — consumed by `rules/builtin-rules.ts` to assemble the full
 * BUILTIN_RULES array exported by `rules-loader.ts`.
 */
export const PROCESS_AND_FILESYSTEM_RULES: GuardRule[] = [
	// --- Process Killing (name matching) ---
	{
		id: "builtin-pkill-f",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Bash", "Shell", "run_command"],
		action: "block",
		patterns: [
			{
				// No `executed_only` here (nor on builtin-pkill-node): the
				// `(dev|tail|logs|pages)` exemption lookahead has to read the
				// quoted process-name argument, which executed_only masks.
				field: "command",
				regex: "\\bpkill\\s+(-\\d+\\s+)?-f\\s+(?![\"']?\\w+\\s+(dev|tail|logs|pages)\\b)",
			},
		],
		reason: "pkill -f matches processes across ALL projects/sessions",
		suggestion:
			"Use specific PID: kill <pid>. To kill local dev processes, be specific: pkill -f 'wrangler dev'",
		severity: "high",
		category: "process-killing",
	},
	{
		id: "builtin-killall",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Bash", "Shell", "run_command"],
		action: "block",
		patterns: [{ field: "command", regex: "\\bkillall\\s+(?!-l\\b)", executed_only: true }],
		reason: "killall terminates ALL processes with matching name",
		suggestion: "Use specific PID: kill <pid>",
		severity: "high",
		category: "process-killing",
	},
	{
		id: "builtin-pkill-node",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Bash", "Shell", "run_command"],
		action: "block",
		patterns: [
			{
				field: "command",
				regex: "\\bpkill\\s+(?!.*--pidfile)(?!-f\\s+[\"']?\\w+\\s+(dev|tail|logs|pages)\\b).*(?:node|bun|python|wrangler|claude)\\b",
				flags: "i",
			},
		],
		reason: "Would kill processes across all projects",
		suggestion:
			"Use specific PID or port-based killing: lsof -ti :<port> | xargs kill. To kill local dev processes, be specific: pkill -f 'wrangler dev'",
		severity: "high",
		category: "process-killing",
	},
	{
		id: "builtin-pgrep-xargs-kill",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Bash", "Shell", "run_command"],
		action: "block",
		patterns: [
			{
				field: "command",
				regex: "\\bpgrep\\b.*\\|\\s*xargs\\s+kill\\b",
				flags: "i",
				executed_only: true,
			},
			{
				field: "command",
				regex: "\\bkill\\s+.*\\$\\(pgrep\\b",
				flags: "i",
				executed_only: true,
			},
			{
				// A `ps` pipeline is dangerous only when it actually ends in a
				// kill — `ps aux | grep x | awk '{print $2}' | xargs kill`. The
				// old alternation `(awk|xargs|kill)` treated a bare `awk` as a
				// kill, so pure inspection pipelines such as
				// `ps aux | grep claude | awk '{print $11}'` false-positived.
				// Require a real `xargs kill` (the pipe is implied — `xargs`
				// can only consume `ps` output through one); `executed_only`
				// keeps the token from matching inside a quoted search argument.
				field: "command",
				regex: "\\bps\\s+(aux|ef)\\b.*\\bxargs\\s+kill\\b",
				flags: "i",
				executed_only: true,
			},
		],
		reason: "Pattern kills processes system-wide",
		suggestion: "Use specific PID or port-based killing",
		severity: "high",
		category: "process-killing",
	},

	// --- Dangerous rm ---
	{
		id: "builtin-rm-rf-root",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Bash", "Shell", "run_command"],
		action: "block",
		patterns: [
			{
				field: "command",
				regex: "\\brm\\s+-[a-zA-Z]*r[a-zA-Z]*\\s+\\/(?!tmp\\b|var\\/tmp\\b)",
			},
			{ field: "command", regex: "\\brm\\s+-rf\\s+\\*" },
		],
		reason: "Recursive deletion of root-level or wildcard paths is dangerous",
		suggestion: "Be more specific about what to delete",
		severity: "critical",
		category: "file-deletion",
	},
	{
		id: "builtin-rm-wrangler",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Bash", "Shell", "run_command"],
		action: "block",
		patterns: [
			{ field: "command", regex: "\\brm\\s+(-[rf]+\\s+)*\\.wrangler\\s*($|&&|\\||;)" },
			{ field: "command", regex: "\\brm\\s+(-[rf]+\\s+)*\\.wrangler\\/state\\b" },
		],
		reason: "CRITICAL: .wrangler contains the local development database (SQLite). Deleting it DESTROYS ALL LOCAL DATA.",
		suggestion: "To fix deployment issues, try: rm -rf .wrangler/cache (keeps database)",
		severity: "critical",
		category: "file-deletion",
	},
	{
		id: "builtin-rm-node-modules",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Bash", "Shell", "run_command"],
		action: "block",
		patterns: [
			{ field: "command", regex: "\\brm\\s+(-[rf]+\\s+)*node_modules\\s*($|&&|\\||;)" },
		],
		reason: "Deleting node_modules requires a full reinstall",
		suggestion: "If you have dependency issues, try: npm cache clean --force && npm install",
		severity: "medium",
		category: "file-deletion",
	},

	// --- Git force operations ---
	{
		id: "builtin-git-force-push",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Bash", "Shell", "run_command"],
		action: "block",
		patterns: [
			{ field: "command", regex: "\\bgit\\s+push\\s+.*--force(?!-with-lease)\\b" },
			// `-f\b` (not `-f\s`): the short flag can be the final token of the
			// command (`git push -f`), where a trailing-whitespace anchor never
			// matches. `\b` fires on space, `;`, `&`, `|`, and end-of-string.
			{ field: "command", regex: "\\bgit\\s+push\\s+-f\\b" },
		],
		reason: "git push --force can destroy remote commits and collaborators' work",
		suggestion: "Use --force-with-lease for safer force pushing",
		severity: "critical",
		category: "git-operations",
	},
	{
		id: "builtin-git-reset-hard",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Bash", "Shell", "run_command"],
		action: "block",
		patterns: [{ field: "command", regex: "\\bgit\\s+reset\\s+--hard\\b" }],
		reason: "git reset --hard destroys all uncommitted changes",
		suggestion: "Use git stash first to preserve changes",
		severity: "high",
		category: "git-operations",
	},
	{
		id: "builtin-git-clean-f",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Bash", "Shell", "run_command"],
		action: "block",
		patterns: [{ field: "command", regex: "\\bgit\\s+clean\\s+-[dxf]*f" }],
		reason: "git clean -f permanently deletes untracked files",
		suggestion: "Use git clean -n first to preview what will be deleted",
		severity: "high",
		category: "git-operations",
	},

	// --- Process killing (signals, multi-PID, substitution) ---
	{
		id: "builtin-kill-signal",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Bash", "Shell", "run_command"],
		action: "block",
		patterns: [
			{ field: "command", regex: "\\bkill\\s+-[1-9][0-9]*\\b", executed_only: true },
			{ field: "command", regex: "\\bkill\\s+-SIG", flags: "i", executed_only: true },
			{ field: "command", regex: "\\bkill\\s+-s\\s", flags: "i", executed_only: true },
		],
		reason: "Sending termination signals is dangerous. Use plain 'kill <PID>' (SIGTERM) instead",
		suggestion: "Use plain: kill <PID>",
		severity: "high",
		category: "process-killing",
	},
	{
		id: "builtin-kill-multi-pid",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Bash", "Shell", "run_command"],
		action: "block",
		// The negative lookahead `(?![0-9>])` excludes file-descriptor redirects:
		// `kill 12345 2>&1` would otherwise match because `2` from `2>&1` looks
		// like a second PID. We require the trailing token to be a real PID
		// (digits not followed by `>`/`<` or more digits in a redirect context),
		// followed by end-of-token (whitespace, end-of-string, or shell
		// separator). Real two-PID kills (`kill 12345 67890\b`) still match.
		patterns: [
			{
				field: "command",
				regex: "\\bkill\\s+[0-9]+\\s+[0-9]+(?=\\s|$|[;|&])",
				flags: "i",
				executed_only: true,
			},
		],
		reason: "Killing multiple PIDs at once is dangerous",
		suggestion: "Kill one PID at a time",
		severity: "high",
		category: "process-killing",
	},
	{
		id: "builtin-kill-substitution",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Bash", "Shell", "run_command"],
		action: "block",
		patterns: [
			{ field: "command", regex: "\\bkill\\s+\\$\\(", executed_only: true },
			{ field: "command", regex: "\\bkill\\s+`", executed_only: true },
			{
				field: "command",
				regex: "\\|\\s*xargs\\s+(.*\\s)?kill\\b",
				flags: "i",
				executed_only: true,
			},
		],
		reason: "kill with command substitution or piped xargs is dangerous",
		suggestion: "Find the PID first, then kill it by number",
		severity: "high",
		category: "process-killing",
	},
	{
		id: "builtin-pkill-signal",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Bash", "Shell", "run_command"],
		action: "block",
		patterns: [
			{ field: "command", regex: "\\bpkill\\s+-[0-9]+\\b", executed_only: true },
			{ field: "command", regex: "\\bpkill\\s+-SIG", flags: "i", executed_only: true },
		],
		reason: "pkill with signal kills matching processes system-wide",
		suggestion: "Use specific PID: kill -<signal> <pid>",
		severity: "high",
		category: "process-killing",
	},

	// --- Dev server protection (soft block — allows retry) ---
	{
		id: "builtin-kill-port",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Bash", "Shell", "run_command", "bash"],
		action: "soft_block",
		patterns: [
			{ field: "command", regex: "\\blsof\\s+-ti?\\s*:\\d+.*\\|.*kill", flags: "i" },
			{ field: "command", regex: "\\bfuser\\s+-k\\s+\\d+/tcp", flags: "i" },
			{ field: "command", regex: "\\bkill-port\\b", flags: "i" },
			{ field: "command", regex: "\\bnpx\\s+kill-port\\b", flags: "i" },
		],
		reason: "This will kill a process listening on a port (possibly a dev server). If you need to restart the server, re-run this command.",
		suggestion:
			"Confirm this is intentional — a running dev server may be in use by the user or another agent",
		severity: "medium",
		category: "process-killing",
	},

	// --- System operations ---
	{
		id: "builtin-sudo-rm",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Bash", "Shell", "run_command"],
		action: "block",
		patterns: [{ field: "command", regex: "\\bsudo\\s+rm\\b" }],
		reason: "sudo rm is extremely dangerous",
		suggestion: "Avoid sudo for file operations when possible",
		severity: "critical",
		category: "system-operations",
	},
	{
		id: "builtin-chmod-777",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Bash", "Shell", "run_command"],
		action: "block",
		patterns: [{ field: "command", regex: "\\bchmod\\s+(-R\\s+)?777\\b" }],
		reason: "chmod 777 creates security vulnerabilities (world-writable)",
		suggestion: "Use more restrictive permissions",
		severity: "high",
		category: "system-operations",
	},
	{
		id: "builtin-shutdown-reboot",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Bash", "Shell", "run_command"],
		action: "block",
		patterns: [
			{
				field: "command",
				// Three structural pieces:
				//
					// 1. **Command-start anchor**: `^`, `;`, `&&`, `||`, single
					//    `|` (pipeline), `\n` (multi-line script). The earlier
					//    `\s` prefix false-positived inside echo/grep strings
					//    and file paths (`echo "Graceful shutdown stalled"`,
					//    `cat ./shutdown.log`). `executed_only` masks quoted
					//    arguments before regex matching, so `rg "x|reboot"`
					//    stays allowed while real pipelines/newlines still match.
					//    `\|\|` listed before `[;|\n]` so the engine consumes
					//    both chars of `||` as one token instead of half-matching.
				//
				// 2. **Optional wrapper chain**: `sudo`, `env [VAR=val ...]`,
				//    `command`, `exec`, `nohup`, and `bash -c "...` /
				//    `sh -c "...`. Zero-or-more so plain `reboot`,
				//    `sudo reboot`, `env A=1 sudo reboot`, and
				//    `sudo bash -c "reboot"` all match. Without this,
				//    wrappers like `env FOO=1 reboot` or `bash -c reboot`
				//    would bypass the rule.
				//
					// 3. **Verb**: `\b` anchored so `rebootloader` doesn't
					//    accidentally match.
					regex: "(^|\\|\\||&&|[;|\\n])\\s*(?:(?:env(?:\\s+[A-Za-z_]\\w*=\\S+)*|command|exec|nohup|sudo)\\s+|(?:bash|sh)\\s+-c\\s*[\"']?\\s*)*(shutdown|reboot|halt|poweroff|init\\s+[06]|systemctl\\s+(poweroff|reboot|halt))\\b",
					flags: "i",
					executed_only: true,
				},
				{
					field: "command",
					// Dedicated raw-text companion for quoted shell scripts. The
					// main pattern uses `executed_only`, which intentionally masks
					// `"reboot"` inside `bash -c "reboot"`; this pattern inspects
					// only the `bash|sh -c` script entrypoint and still requires
					// the destructive verb to be the first executed token inside
					// the quoted script, so `bash -c "echo shutdown stalled"` is
					// not a false positive.
					regex: "(^|\\|\\||&&|[;|\\n])\\s*(?:(?:env(?:\\s+[A-Za-z_]\\w*=\\S+)*|command|exec|nohup|sudo)\\s+)*(?:bash|sh)\\s+-c\\s*[\"']\\s*(?:(?:env(?:\\s+[A-Za-z_]\\w*=\\S+)*|command|exec|nohup|sudo)\\s+)*(shutdown|reboot|halt|poweroff|init\\s+[06]|systemctl\\s+(poweroff|reboot|halt))\\b",
					flags: "i",
				},
			],
		reason: "System shutdown/reboot commands are not allowed",
		suggestion: "Ask the user to run this manually",
		severity: "critical",
		category: "system-operations",
	},
	{
		id: "builtin-lvm-removal",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Bash", "Shell", "run_command"],
		action: "block",
		patterns: [{ field: "command", regex: "\\b(lvremove|vgremove|pvremove)\\s", flags: "i" }],
		reason: "LVM removal commands are destructive",
		suggestion: "Ask the user to run this manually",
		severity: "critical",
		category: "system-operations",
	},

	// --- Filesystem destruction ---
	{
		id: "builtin-dd-block-device",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Bash", "Shell", "run_command"],
		action: "block",
		patterns: [{ field: "command", regex: "\\bdd\\s.*of=/dev/", flags: "i" }],
		reason: "Writing directly to block devices with dd can destroy data",
		suggestion: "Verify the target device carefully",
		severity: "critical",
		category: "filesystem",
	},
	{
		id: "builtin-disk-format",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Bash", "Shell", "run_command"],
		action: "block",
		patterns: [
			{
				field: "command",
				regex: "(^|\\s|;|&&)(mkfs|fdisk|parted|gdisk)\\s",
				flags: "i",
			},
		],
		reason: "Disk formatting/partitioning commands are not allowed",
		suggestion: "Ask the user to run this manually",
		severity: "critical",
		category: "filesystem",
	},

	// --- Git destruction (expanded) ---
	{
		id: "builtin-git-checkout-dot",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Bash", "Shell", "run_command"],
		action: "block",
		patterns: [{ field: "command", regex: "\\bgit\\s+checkout\\s+--\\s+\\." }],
		reason: "git checkout -- . discards all unstaged changes",
		suggestion: "Use git stash first to preserve changes",
		severity: "high",
		category: "git-operations",
	},
	{
		id: "builtin-git-restore-worktree",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Bash", "Shell", "run_command"],
		action: "block",
		patterns: [{ field: "command", regex: "\\bgit\\s+restore\\s+--worktree\\s" }],
		reason: "git restore --worktree discards working tree changes",
		suggestion: "Use git stash first to preserve changes",
		severity: "high",
		category: "git-operations",
	},
	{
		id: "builtin-git-branch-D",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Bash", "Shell", "run_command"],
		action: "block",
		patterns: [
			{ field: "command", regex: "\\bgit\\s+branch\\s+-[DMf]\\s", flags: "" },
		],
		reason:
			"git branch -D/-M/-f is a force operation: it deletes or moves a branch ref without the usual safety checks",
		suggestion:
			"For deletion use -d (merge-checked - it refuses unmerged branches). -f/-M force-move a branch ref and can orphan commits; re-run only if intended.",
		severity: "medium",
		category: "git-operations",
	},
	{
		id: "builtin-git-stash-destroy",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Bash", "Shell", "run_command"],
		action: "block",
		patterns: [{ field: "command", regex: "\\bgit\\s+stash\\s+(drop|clear)\\b", flags: "i" }],
		reason: "git stash drop/clear permanently removes stashed work",
		suggestion: "Verify stash contents first with git stash list",
		severity: "high",
		category: "git-operations",
	},

	// --- Embedded destructive commands ---
	{
		id: "builtin-inline-script-destruct",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Bash", "Shell", "run_command"],
		action: "block",
		patterns: [
			{
				field: "command",
				regex: "(python3?|node|ruby|perl)\\s+-(c|e)\\s+.*\\b(os\\.remove|shutil\\.rmtree|unlink|rimraf)\\b",
				flags: "i",
			},
		],
		reason: "Inline script containing destructive file operations",
		suggestion: "Write to a file instead of using inline script execution",
		severity: "high",
		category: "inline-scripts",
	},
	{
		id: "builtin-bash-c-destruct",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Bash", "Shell", "run_command"],
		action: "block",
		patterns: [
			{
				field: "command",
				// `bash -c` is matched raw (no executed_only) so a destructive
				// verb inside the quoted script stays visible. The kill-* rules
				// use executed_only and would otherwise miss
				// `bash -c "kill -9 ..."`, so the bare-kill danger forms
				// (signal, command substitution, multi-PID) are covered here.
				regex: "\\bbash\\s+-c\\s+.*\\b(rm\\s+-rf|killall|pkill|kill\\s+(?:-|\\$\\(|`|[0-9]+\\s+[0-9]))",
				flags: "i",
			},
		],
		reason: "Destructive command embedded in bash -c",
		suggestion: "Run directly so it can be properly reviewed",
		severity: "high",
		category: "inline-scripts",
	},

	// ===========================================
	// Additional destructive patterns (Feature 2)
	// ===========================================
	{
		id: "builtin-shred",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Bash", "Shell", "run_command"],
		action: "block",
		patterns: [{ field: "command", regex: "\\bshred\\s" }],
		reason: "shred securely overwrites files making recovery impossible",
		suggestion: "Use rm for normal deletion",
		severity: "critical",
		category: "filesystem",
	},
	{
		id: "builtin-wipefs",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Bash", "Shell", "run_command"],
		action: "block",
		patterns: [{ field: "command", regex: "\\bwipefs\\s" }],
		reason: "wipefs erases filesystem signatures from block devices",
		suggestion: "Ask the user to run this manually",
		severity: "critical",
		category: "filesystem",
	},
	{
		id: "builtin-git-filter-branch",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Bash", "Shell", "run_command"],
		action: "block",
		patterns: [
			{ field: "command", regex: "\\bgit\\s+filter-branch\\b", flags: "i" },
			{ field: "command", regex: "\\bgit\\s+filter-repo\\b", flags: "i" },
		],
		reason: "git filter-branch/filter-repo rewrites entire repository history",
		suggestion: "This is a destructive rewrite of all commits. Ask the user to run manually",
		severity: "critical",
		category: "git-operations",
	},
	{
		id: "builtin-git-restore-dot",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Bash", "Shell", "run_command"],
		action: "block",
		patterns: [{ field: "command", regex: "\\bgit\\s+restore\\s+\\." }],
		reason: "git restore . discards all unstaged changes",
		suggestion: "Use git stash first to preserve changes, or restore specific files",
		severity: "high",
		category: "git-operations",
	},

	// --- Git: amend, single-file discard, clone-into-tree, interactive add ---
	// Closes gaps surfaced by the agentic-engineering-patterns review: the
	// OpenAI Codex system prompt forbids amending commits and destructive
	// checkout/restore, and Simon Willison's guide recommends cloning
	// reference repos to /tmp so they can't contaminate the working tree.
	{
		id: "builtin-git-commit-amend",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Bash", "Shell", "run_command"],
		action: "ask",
		patterns: [
			// `[^|&;]*` keeps the match inside one `git commit` invocation so a
			// `&&`-chained later command can't pull `--amend` in. executed_only
			// masks quoted strings so `git commit -m "fix --amend bug"` is safe.
			{
				field: "command",
				regex: "\\bgit\\s+commit\\b[^|&;]*\\s--amend\\b",
				flags: "i",
				executed_only: true,
			},
		],
		reason:
			"git commit --amend rewrites the most recent commit. If that commit was already pushed, the local and remote histories diverge and reconciling them needs a force-push.",
		suggestion:
			"Confirm the commit being amended has not been pushed to a shared branch. To extend history without rewriting it, make a new commit instead.",
		severity: "medium",
		category: "git-operations",
	},
	{
		id: "builtin-git-discard-file",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Bash", "Shell", "run_command"],
		action: "ask",
		patterns: [
			// `git checkout [<ref>...] -- <file>` discards uncommitted changes to
			// a specific file. The `.` wildcard form is excluded — it is already
			// hard-blocked by builtin-git-checkout-dot.
			{
				field: "command",
				regex: "\\bgit\\s+checkout\\s+(?:\\S+\\s+)*--\\s+(?!\\.(?:\\s|$))\\S",
				flags: "i",
				executed_only: true,
			},
			// `git restore <file>` defaults to --worktree and discards changes.
			// --staged/-S (index only, non-destructive) and --worktree/-W
			// (blocked by builtin-git-restore-worktree) are excluded; the bare
			// `.` form is builtin-git-restore-dot's job.
			{
				field: "command",
				regex: "\\bgit\\s+restore\\s+(?!(?:--staged|-S|--worktree|-W)\\b)(?!\\.(?:\\s|$))\\S",
				flags: "i",
				executed_only: true,
			},
		],
		reason:
			"git checkout -- <file> / git restore <file> discards uncommitted changes to that file with no undo.",
		suggestion:
			"Confirm you want to lose those changes — git stash first if you might need them back.",
		severity: "medium",
		category: "git-operations",
	},
	{
		id: "builtin-git-clone-into-tree",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Bash", "Shell", "run_command"],
		action: "soft_block",
		patterns: [
			// Fires when `git clone` ends with a relative destination path —
			// not an absolute `/...` path, not `~`, not a flag. Absolute and
			// /tmp destinations don't match, so only in-tree clones trip it.
			{
				field: "command",
				regex: "\\bgit\\s+clone\\b.*\\s(?![-/~])[\\w.][\\w./-]*\\s*$",
				flags: "i",
				executed_only: true,
			},
		],
		reason:
			"git clone with a relative destination drops the cloned repo inside the working tree, where its files can be accidentally staged and committed.",
		suggestion:
			"Clone reference repositories to /tmp instead — git clone <url> /tmp/<name> — so they can't contaminate this project. Re-run if the in-tree location is intentional.",
		severity: "low",
		category: "git-operations",
	},
	{
		id: "builtin-git-add-interactive",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Bash", "Shell", "run_command"],
		action: "block",
		patterns: [
			{
				field: "command",
				regex: "\\bgit\\s+add\\s+(?:\\S+\\s+)*(?:-i|-p|-e|--interactive|--patch|--edit)\\b",
				flags: "i",
				executed_only: true,
			},
		],
		reason:
			"git add -i / -p / -e opens an interactive prompt or editor that hangs a non-interactive agent tool call indefinitely.",
		suggestion:
			"Stage files non-interactively: git add <pathspec>. To stage part of a file, edit the file directly.",
		severity: "medium",
		category: "git-operations",
	},
];

// ===========================================
// Temporal-precondition rules (PB&J Free-CLI item #1)
// ===========================================
// Trajectory-aware rules using `requires_prior` / `forbids_after` predicates
// (see `types/rules.ts::TemporalPredicate`). Appended LAST in BUILTIN_RULES
// (wiring in `builtin-rules.ts`) so they never shadow earlier hard-blocks /
// vendor-scoped / warn-only rules. A temporal rule only surfaces when no
// upstream rule has already claimed the call — backwards-compatible with the
// pre-existing rule corpus.
//
// NOTE on `builtin-npm-publish-requires-tests-pass` action:
// User decision (2026-05-27 session) was option (c) — both rules, temporal
// ratchets to `ask`. Subagent shipped as `warn` to avoid breaking ~100
// existing supply-chain-defense.test.ts fixtures asserting `decision: "allow"`.
// Resolution path: ship as `warn` now to converge merge; ratchet to `ask`
// and update fixtures in a focused follow-up. TODO(npm-publish-ask-ratchet).
export const TEMPORAL_PRECONDITION_RULES: GuardRule[] = [
	{
		id: "builtin-git-force-push-requires-inspection",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Bash", "Shell", "run_command"],
		action: "ask",
		patterns: [
			// `--force-with-lease` is the safer variant — permitted under the
			// temporal-gate path. The negative lookahead matches only the unsafe form.
			{ field: "command", regex: "\\bgit\\s+push\\s+.*--force(?!-with-lease)\\b" },
			{ field: "command", regex: "\\bgit\\s+push\\s+-f\\b" },
		],
		requires_prior: {
			bash_match: "git\\s+(log|diff|status)\\b",
			within_last_n: 10,
		},
		reason:
			"git push --force without a prior `git log` / `git diff` / `git status` in the last 10 commands is risky — run one of those first to confirm what's being pushed.",
		suggestion:
			"Run `git log origin/<branch>..HEAD` or `git diff origin/<branch>` before force-pushing to see what is about to be overwritten on the remote.",
		severity: "high",
		category: "git-operations",
	},
	{
		id: "builtin-rm-requires-prior-inspection",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Bash", "Shell", "run_command"],
		action: "ask",
		patterns: [
			// `rm` MUST be the command verb — at line start or after a shell
			// separator. Prevents matching `vercel rm`, `npm rm`, `git rm`.
			{
				field: "command",
				regex: "(^|;|&&|\\|\\||\\|(?!\\|)|\\n)\\s*(?:sudo\\s+)?rm\\s+(?:-[a-zA-Z]+\\s+)*\\S",
				flags: "i",
				executed_only: true,
			},
			// Negation: skip common safe build-artifact / temp paths.
			{
				field: "command",
				regex: "\\brm\\s+(?:-[a-zA-Z]+\\s+)*(?:/tmp/|/var/tmp/|\\./|dist/|build/|\\.cache/|coverage/|out/|target/|\\.next/|node_modules\\b)",
				flags: "i",
				negate: true,
				executed_only: true,
			},
		],
		requires_prior: {
			// TODO(v2): per-target matching — only when Read:/path/X is in tool_sequence.
			tool: "Read",
			within_last_n: 20,
		},
		reason:
			"Deleting paths without first reading any file in the last 20 actions risks destroying unintended work.",
		suggestion:
			"Read one of the files you're about to remove (or a sibling) before issuing `rm`.",
		severity: "medium",
		category: "file-deletion",
	},
	{
		id: "builtin-npm-publish-requires-tests-pass",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Bash", "Shell", "run_command"],
		// See note above re: warn vs ask. Ratchet to "ask" in a follow-up.
		action: "warn",
		patterns: [
			{
				field: "command",
				regex: "\\b(npm|yarn|pnpm)\\s+publish\\b",
				flags: "i",
				executed_only: true,
			},
			// Skip `--dry-run` invocations (safe no-network preview).
			{ field: "command", regex: "--dry-run\\b", negate: true },
		],
		requires_prior: {
			verification_kind: "test",
			within_last_n: 50,
		},
		reason:
			"Publishing without running the test suite in this session is risky — run tests first.",
		suggestion:
			"Run `npm test` (or your project's test command) before `npm publish`. Any test run in the session unlocks publish.",
		severity: "high",
		category: "supply-chain",
	},
];
