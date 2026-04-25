// ===========================================
// Built-in Rules — Supply Chain, Process Safety, Information Flow
// ===========================================
// Covers package.json lifecycle-script injection, .npmrc / .yarnrc manipulation,
// npm publish guards, fork bombs, nohup/disown background network,
// cron/systemd/launchd persistence, and clipboard exfiltration.

import type { GuardRule } from "../types.js";

/**
 * Public API — consumed by `rules/builtin-rules.ts` to assemble the full
 * BUILTIN_RULES array exported by `rules-loader.ts`.
 */
export const SECURITY_AND_SAFETY_RULES: GuardRule[] = [
	// ===========================================
	// Supply chain patterns (Feature 3)
	// ===========================================
	{
		id: "builtin-build-script-injection",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Write", "Edit", "WriteFile", "EditFile", "write_file", "edit_file"],
		action: "warn",
		patterns: [
			{
				field: "content",
				regex: '"(preinstall|postinstall|prepare|prepublish)"\\s*:\\s*"[^"]*\\b(curl|wget|nc|bash\\s+-c|eval|exec)\\b',
			},
			{
				field: "new_string",
				regex: '"(preinstall|postinstall|prepare|prepublish)"\\s*:\\s*"[^"]*\\b(curl|wget|nc|bash\\s+-c|eval|exec)\\b',
			},
		],
		reason: "Package lifecycle script contains network/exec commands (possible supply chain injection)",
		suggestion: "Review the lifecycle script carefully for malicious patterns",
		severity: "high",
		category: "supply-chain",
	},

	// ===========================================
	// Supply chain: config file manipulation
	// ===========================================
	{
		id: "builtin-npmrc-manipulation",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Write", "Edit", "WriteFile", "EditFile", "write_file", "edit_file"],
		action: "block",
		patterns: [
			{
				field: "file_path",
				regex: "(\\.npmrc|\\.yarnrc|\\.yarnrc\\.yml|\\.pnpmfile\\.cjs)$",
			},
		],
		reason: "Modifying package manager config can redirect dependency resolution to attacker-controlled registries (dependency confusion)",
		suggestion:
			"If you need to change registry settings, ask the user to edit the file manually",
		severity: "critical",
		category: "supply-chain",
	},
	{
		id: "builtin-npm-publish",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Bash", "Shell", "run_command"],
		action: "warn",
		patterns: [
			{ field: "command", regex: "\\bnpm\\s+publish\\b" },
			{ field: "command", regex: "--dry-run", negate: true },
		],
		reason: "npm publish without --dry-run will publish to the registry. Accidental publishes can expose private code",
		suggestion:
			"Use npm publish --dry-run first to preview, then ask the user to confirm the real publish",
		severity: "high",
		category: "supply-chain",
	},

	// ===========================================
	// Information flow: scanner LOCAL-ONLY artifacts
	// ===========================================
	// Defense-in-depth on top of protected_files. `.interlinked/scanner/pending/`
	// holds raw flagged PII captured by the content scanner; the systemMessage /
	// redacted-reason design only works if the agent can't pull the content
	// back via a Bash/Grep/Glob side-channel. protected_files catches direct
	// Read/Write/Edit; this rule catches the long-tail tools that traffic in
	// arbitrary paths or commands.
	{
		id: "builtin-scanner-pending-access",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: [
			"Bash",
			"Shell",
			"run_command",
			"Grep",
			"grep",
			"Search",
			"Glob",
			"glob",
			"FileSearch",
		],
		action: "block",
		patterns: [
			// Bash command body — catches `cat .interlinked/scanner/pending/...`,
			// `head/tail/less/grep/jq/find/ls/rg .interlinked/scanner/pending/...`,
			// `xxd .interlinked/content-scanner.audit.jsonl`, etc. The regex
			// matches the path itself, so any tool that mentions it gets blocked
			// regardless of the program in front.
			{
				field: "command",
				regex: "\\.interlinked/(scanner/pending|content-scanner\\.audit)",
			},
			// Grep tool — `path` field tells the tool where to search.
			{
				field: "path",
				regex: "\\.interlinked/(scanner/pending|content-scanner\\.audit)",
			},
			// Glob tool — `pattern` field is the glob expression.
			{
				field: "pattern",
				regex: "\\.interlinked/(scanner/pending|content-scanner\\.audit)",
			},
		],
		reason:
			"BLOCKED: .interlinked/scanner/pending/ contains raw PII the privacy filter quarantined for the user only. Reading it through any tool would re-introduce the values into the model's context — that defeats the entire systemMessage design. Open the file in a separate terminal if you need to review.",
		suggestion:
			"If you genuinely need to inspect a pending file, open it in a non-agent terminal: `cat .interlinked/scanner/pending/<id>.json` from your shell directly.",
		severity: "critical",
		category: "Security",
	},

	// ===========================================
	// Process safety: fork bombs, persistence, background network
	// ===========================================
	{
		id: "builtin-fork-bomb",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Bash", "Shell", "run_command"],
		action: "block",
		patterns: [
			{ field: "command", regex: ":\\(\\)\\s*\\{\\s*:\\|:\\s*&\\s*\\}\\s*;\\s*:" },
			{ field: "command", regex: "\\bwhile\\s+(true|1|:)\\s*;?\\s*do.*&\\s*done" },
			{ field: "command", regex: "\\bfor\\b.*\\bdo\\b.*\\bfork\\b.*&\\s*done", flags: "i" },
		],
		reason: "Fork bomb detected — this will exhaust system resources and freeze the machine",
		suggestion:
			"Do not run fork bombs. If you need parallel processes, use controlled concurrency",
		severity: "critical",
		category: "process-safety",
	},
	{
		id: "builtin-nohup-network",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Bash", "Shell", "run_command"],
		action: "block",
		patterns: [
			{
				field: "command",
				regex: "\\bnohup\\b.*\\b(curl|wget|nc|netcat|python3?|node|ruby|perl)\\b.*&",
				flags: "i",
			},
			{
				field: "command",
				regex: "\\bdisown\\b.*\\b(curl|wget|nc|netcat|python3?|node|ruby|perl)\\b",
				flags: "i",
			},
		],
		reason: "Detached background process with network capability — this is a RAT persistence pattern (ref: axios@1.14.1 used nohup python3 dropper with ppid:1)",
		suggestion:
			"Run network commands in the foreground so their output is visible and they terminate with the session",
		severity: "critical",
		category: "process-safety",
	},
	{
		id: "builtin-background-network",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Bash", "Shell", "run_command"],
		action: "warn",
		patterns: [
			{
				field: "command",
				regex: "\\b(curl|wget|nc|netcat|python3?|node|ruby|perl)\\b[^|;]*\\s+&\\s*$",
			},
		],
		reason: "Background process with network capability. Background network activity is rarely legitimate in an agent context",
		suggestion: "Run network commands in the foreground. If you need async work, explain why",
		severity: "high",
		category: "process-safety",
	},
	{
		id: "builtin-cron-persistence",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Bash", "Shell", "run_command"],
		action: "block",
		patterns: [
			{ field: "command", regex: "\\bcrontab\\s+(-e|-r|-)\\b" },
			{ field: "command", regex: "\\bsystemctl\\s+(enable|mask)\\b" },
			{ field: "command", regex: "\\blaunchctl\\s+(load|submit)\\b" },
		],
		reason: "Modifying scheduled tasks or system services creates persistent effects beyond this session",
		suggestion: "Ask the user to configure cron jobs or system services manually",
		severity: "critical",
		category: "process-safety",
	},
	{
		id: "builtin-cron-file-write",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Write", "Edit", "WriteFile", "EditFile", "write_file", "edit_file"],
		action: "block",
		patterns: [
			{
				field: "file_path",
				regex: "(/etc/cron\\.d/|/etc/crontab|\\.service$|/LaunchAgents/|/LaunchDaemons/)",
			},
		],
		reason: "Writing to cron/systemd/launchd directories creates persistent scheduled tasks",
		suggestion: "Ask the user to install services or cron jobs manually",
		severity: "critical",
		category: "process-safety",
	},

	// ===========================================
	// Information flow: clipboard exfiltration
	// ===========================================
	{
		id: "builtin-clipboard-exfil",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Bash", "Shell", "run_command"],
		action: "warn",
		patterns: [
			{ field: "command", regex: "\\|\\s*(pbcopy|xclip|xsel|clip\\.exe)\\b" },
			{ field: "command", regex: "\\b(pbcopy|xclip|xsel|clip\\.exe)\\b.*<" },
		],
		reason: "Piping data to clipboard — data leaves the terminal silently and may contain sensitive content",
		suggestion: "Print the output to the terminal instead so it's visible and reviewable",
		severity: "medium",
		category: "information-flow",
	},
];
