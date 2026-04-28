// ===========================================
// Built-in Rules — Resource Bombs (SRPS ports)
// ===========================================
//
// Patterns that don't destroy data, but slow the user's machine to a crawl
// or trash workstation stability — fork bombs, infinite spin loops, runaway
// memory allocation, file-descriptor exhaustion. SRPS
// (system_resource_protection_script) inspired this list — we adopt the
// patterns it identifies as problematic into our PreToolUse evaluator.
//
// Plan reference: docs/plans/free-cli-adoption/03-resource-bomb-rules.md.
// Phase-matrix rows 11-20: docs/plans/free-cli-adoption/_phase1-phase-matrix.md.
//
// Action mix:
//   - block:    fork-bomb, infinite-spin (clearly never legitimate).
//   - ask:      everything else (tunable thresholds — flagged for human review).
//
// Keyword gating per Plan 01 §1.3: every rule declares `keywords` for the
// quick-reject pre-pass in `evaluator/keyword-quick-reject.ts`. The fork bomb
// has no word tokens, so its keywords list is intentionally empty (= always
// evaluate). The empty array is meaningful — do not omit the field.

import type { GuardRule } from "../types.js";

/**
 * Public API — consumed by `rules/builtin-rules.ts` to assemble the full
 * BUILTIN_RULES array exported by `rules-loader.ts`.
 *
 * The 10 rules below correspond exactly to rows 11-20 of the Phase-1
 * matrix and to the table in Plan 03 §"The 10 rules". Order is preserved
 * for reviewability — do not reorder without also updating the matrix.
 */
export const RESOURCE_BOMB_RULES: GuardRule[] = [
	// Row 11: classic fork bomb. The canonical pattern `:(){:|:&};:` has no
	// word tokens, so we tag with `keywords: []` to route into the
	// always-evaluate set (Plan 01 §1.3). The regex is short and bounded —
	// roughly 1µs per command — so the constant cost is acceptable.
	{
		id: "builtin-fork-bomb",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Bash", "Shell", "run_command"],
		action: "block",
		patterns: [
			{
				field: "command",
				regex: ":\\(\\)\\s*\\{\\s*:\\|:&\\s*\\};\\s*:",
				flags: "i",
			},
		],
		reason:
			"Fork bomb detected — this will exhaust system resources and freeze the machine.",
		suggestion:
			"Do not run fork bombs. If you need parallel processes, use controlled concurrency (xargs -P, GNU parallel --jobs, or a job queue).",
		severity: "critical",
		category: "resource",
		keywords: [],
	},

	// Row 12: infinite spin. Matches `while true; do :; done` and
	// `while :; do :; done` — loops with no terminating side-effect inside.
	// Deliberately does NOT match loops with sleep/curl/echo bodies; those
	// have a way to terminate naturally or be observed and killed.
	{
		id: "builtin-infinite-spin",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Bash", "Shell", "run_command"],
		action: "block",
		patterns: [
			{
				field: "command",
				regex:
					"\\bwhile\\s+(?:true|:)\\s*;?\\s*do\\s+(?::|true)\\s*;?\\s*done\\b",
				flags: "i",
			},
		],
		reason:
			"Infinite spin loop detected — `while true; do :; done` (or `while :; do :; done`) burns 100% CPU and never exits.",
		suggestion:
			"Add a terminating condition or a sleep with an external trigger. If you need a long-running watcher, use inotifywait/fswatch or a proper service.",
		severity: "high",
		category: "resource",
		keywords: ["while"],
	},

	// Row 13: dd writing /dev/zero|urandom|random to a file. Permits
	// read-only `dd if=/dev/zero ... | hexdump`; flags only writes (`of=`).
	// Common legit shape: making a swapfile or sparse fixture — that's why
	// this is `ask` not `block`.
	{
		id: "builtin-dd-if-zero",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Bash", "Shell", "run_command"],
		action: "ask",
		patterns: [
			{
				field: "command",
				regex: "\\bdd\\b.*\\bif=/dev/(?:zero|urandom|random)\\b.*\\bof=",
				flags: "i",
			},
		],
		reason:
			"`dd if=/dev/zero|urandom|random of=...` writes a (potentially huge) file from a kernel pseudo-device. Easy to typo into filling a partition or overwriting unintended data.",
		suggestion:
			"Verify the size (count*bs) and the destination path. For swapfiles, prefer `fallocate -l <size>` (which this guard also catches at huge sizes — that's intentional).",
		severity: "high",
		category: "resource",
		keywords: ["dd"],
	},

	// Row 14: brace-expansion `for` loops with >=1M iterations. Brace
	// expansion materializes the full list before the loop runs, so a
	// 10-million-iteration loop allocates a 10M-element array up front —
	// that's the failure mode SRPS guards against.
	{
		id: "builtin-unbounded-seq-loop",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Bash", "Shell", "run_command"],
		action: "ask",
		patterns: [
			{
				field: "command",
				regex: "\\bfor\\s+\\w+\\s+in\\s+\\{1\\.\\.[1-9]\\d{6,}\\}",
				flags: "i",
			},
		],
		reason:
			"Brace-expansion `for` loop with 1M+ iterations. Bash materializes the full sequence in memory before the loop runs — at 10M iterations that's hundreds of megabytes of strings just for the iteration variable.",
		suggestion:
			"Use `seq` piped to `while read` (lazy) or `for ((i=0; i<N; i++))` (no allocation). If you genuinely need 10M+ iterations, batch them into chunks.",
		severity: "medium",
		category: "resource",
		keywords: ["for"],
	},

	// Row 15: `xargs -P` with >= 100 jobs. -P 100 is a legitimate ETL
	// concurrency setting; -P 10000 is a way to crash the user's shell.
	// We don't pretend to know the line; the threshold is tunable per
	// customer (Plan 13 — surface the knob via .interlinked/guard-rules.local.json).
	{
		id: "builtin-xargs-parallel-large",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Bash", "Shell", "run_command"],
		action: "ask",
		patterns: [
			{
				field: "command",
				regex: "\\bxargs\\s+(?:.*\\s)?-P\\s*([1-9]\\d{2,})\\b",
				flags: "i",
			},
		],
		reason:
			"`xargs -P` with 100+ parallel jobs can fork-bomb the user's machine in slow-motion. Each job typically inherits the parent's file descriptors and memory mappings.",
		suggestion:
			"For most workloads, -P $(nproc) or 2x nproc is plenty. If you need many more workers, switch to a queue-based job runner that bounds concurrent processes.",
		severity: "medium",
		category: "resource",
		keywords: ["xargs"],
	},

	// Row 16: ulimit -n raising file-descriptor limit to 5+ digits (10K+).
	// Sometimes legit (high-FD test harness, very-busy-server local dev),
	// sometimes a sign of an FD leak the agent is trying to mask. `ask`
	// gives the user a one-time confirmation per session.
	{
		id: "builtin-ulimit-fd-raise",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Bash", "Shell", "run_command"],
		action: "ask",
		patterns: [
			{
				field: "command",
				regex: "\\bulimit\\s+-n\\s+\\d{5,}\\b",
				flags: "i",
			},
		],
		reason:
			"`ulimit -n` raising the file-descriptor cap to 10K+. Often a sign of an FD-leak workaround rather than a deliberate sizing decision.",
		suggestion:
			"If a test harness genuinely needs 10K+ FDs, document it. Otherwise investigate whether sockets/files are being closed properly first.",
		severity: "medium",
		category: "resource",
		keywords: ["ulimit"],
	},

	// Row 17: GNU parallel with --jobs >= 100. Same logic as xargs -P.
	// `parallel --jobs 100` is the GNU parallel default in some scripts —
	// if FP noise is high we'll raise to 200 in v2.
	{
		id: "builtin-parallel-large-jobs",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Bash", "Shell", "run_command"],
		action: "ask",
		patterns: [
			{
				field: "command",
				regex: "\\bparallel\\b.*--jobs\\s*=?\\s*([1-9]\\d{2,})\\b",
				flags: "i",
			},
		],
		reason:
			"GNU `parallel --jobs` with 100+ workers can saturate the system the same way `xargs -P 100+` does. Each worker is a child shell.",
		suggestion:
			"For most workloads, --jobs $(nproc) is fine. Use a queue-backed runner if you need more.",
		severity: "medium",
		category: "resource",
		keywords: ["parallel"],
	},

	// Row 18: inotifywait recursive on `/`. Watching the entire root
	// filesystem creates a kernel-side watch for every inode — quickly hits
	// /proc/sys/fs/inotify/max_user_watches. Legit for some monitoring
	// tools; `ask` lets the user confirm.
	{
		id: "builtin-inotify-root-watch",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Bash", "Shell", "run_command"],
		action: "ask",
		patterns: [
			{
				field: "command",
				regex: "\\binotifywait\\s+(?:-[a-z]+\\s+)*-(?:r|m|rm)\\b\\s+/(?:\\s|$)",
				flags: "i",
			},
		],
		reason:
			"`inotifywait` recursively watching `/` creates a watch per inode for the entire filesystem — quickly hits the kernel max_user_watches limit and may slow the system noticeably.",
		suggestion:
			"Watch a specific directory (e.g. /home/user/project, /var/log/myapp). If you genuinely need root-wide monitoring, audit `cat /proc/sys/fs/inotify/max_user_watches` first.",
		severity: "medium",
		category: "resource",
		keywords: ["inotifywait"],
	},

	// Row 19: nohup + an embedded loop + & (detached background loop).
	// Detached loops survive the agent session — they're persistence, not
	// transient work. `ask` lets the user confirm if it's a deliberate
	// daemon-like task.
	{
		id: "builtin-nohup-detach-loop",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Bash", "Shell", "run_command"],
		action: "ask",
		patterns: [
			{
				field: "command",
				regex: "\\bnohup\\b.*\\b(?:while\\b.*\\bdo\\b|for\\b.*\\bdo\\b).*&",
				flags: "i",
			},
		],
		reason:
			"`nohup ... while/for ... do ... done &` detaches a loop that survives the agent session. This is persistence, not transient work.",
		suggestion:
			"If you need a long-running daemon, use a proper service manager (systemd, launchd, supervisord). If it's transient, drop the `nohup` and `&` so the user can see/kill it.",
		severity: "medium",
		category: "resource",
		keywords: ["nohup"],
	},

	// Row 20: fallocate -l with >=1GB allocation. The regex matches either
	// 10-digit raw byte counts (1e9 — 1GB and up) OR any digit-count
	// followed by G/T (gigabytes/terabytes — case-insensitive). Smaller
	// allocations (M/k) are not flagged.
	{
		id: "builtin-fallocate-huge",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Bash", "Shell", "run_command"],
		action: "ask",
		patterns: [
			{
				field: "command",
				regex: "\\bfallocate\\s+-l\\s+(?:[1-9]\\d{9,}|\\d+[GgTt])\\b",
				flags: "i",
			},
		],
		reason:
			"`fallocate -l` with a 1GB+ allocation. On a small disk this can fill the partition; on a sparse filesystem the apparent free space hides the actual reservation.",
		suggestion:
			"Verify the size and target. For swapfiles, prefer `mkswap`-aware tooling. For test fixtures, generate the smallest size that exercises the code path.",
		severity: "medium",
		category: "resource",
		keywords: ["fallocate"],
	},
];
