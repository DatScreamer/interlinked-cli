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
		patterns: [{ field: "command", regex: "\\bkillall\\s+(?!-l\\b)" }],
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
			{ field: "command", regex: "\\bpgrep\\b.*\\|\\s*xargs\\s+kill\\b", flags: "i" },
			{ field: "command", regex: "\\bkill\\s+.*\\$\\(pgrep\\b", flags: "i" },
			{
				field: "command",
				regex: "\\bps\\s+(aux|ef)\\b.*\\|\\s*grep\\b.*\\|\\s*(awk|xargs|kill)\\b",
				flags: "i",
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
			{ field: "command", regex: "\\bgit\\s+push\\s+-f\\s" },
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
			{ field: "command", regex: "\\bkill\\s+-[1-9][0-9]*\\b" },
			{ field: "command", regex: "\\bkill\\s+-SIG", flags: "i" },
			{ field: "command", regex: "\\bkill\\s+-s\\s", flags: "i" },
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
			{ field: "command", regex: "\\bkill\\s+\\$\\(" },
			{ field: "command", regex: "\\bkill\\s+`" },
			{ field: "command", regex: "\\|\\s*xargs\\s+(.*\\s)?kill\\b", flags: "i" },
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
			{ field: "command", regex: "\\bpkill\\s+-[0-9]+\\b" },
			{ field: "command", regex: "\\bpkill\\s+-SIG", flags: "i" },
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
		patterns: [{ field: "command", regex: "\\bgit\\s+branch\\s+-D\\s" }],
		reason: "git branch -D force-deletes a branch without merge check",
		suggestion: "Use -d instead for safe deletion",
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
				regex: "\\bbash\\s+-c\\s+.*\\b(rm\\s+-rf|killall|pkill)\\b",
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
];
