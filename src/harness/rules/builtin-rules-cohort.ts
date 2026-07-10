// ===========================================
// Cohort git discipline — blast-radius rules
// ===========================================
// Bun's 64-agent false start, mechanized (docs/design/cohort-git-discipline.md
// §1): one Claude ran `git stash`, another `git stash pop`, then
// `git reset HEAD --hard` — the fix was a PROMPT rule ("never run git stash or
// git reset or any git command that doesn't commit a specific file at once"),
// and a prompt rule is exactly what this harness exists to replace with a
// mechanism.
//
// These rules gate commands whose effect is NOT bounded by the paths the agent
// named — stash moves every uncommitted change, rebase rewrites history under
// everyone, branch switching moves HEAD under everyone. Cohort size is the
// SCOPING condition, not the rationale: solo, the blast radius covers only
// your own work, so every rule here is dormant below 2 active agents
// (`active_agent_count_at_least` — evaluator/active-when.ts). No daemon/cohort
// state → predicate false → rules dormant: coordination rules fail OPEN
// (feedback_safety_continuity), so no inline/cold-fallback mirror is needed.
//
// Deliberately ABSENT: `git add -A` / `git commit -a`. Live-firing this pack
// surfaced prior art the plan missed — `git-session-scope-gate`
// (session-git-baseline.ts) already gates both with per-file OWNERSHIP
// granularity (`ask`, naming exactly which files predate this session), which
// strictly beats a blanket cohort block: when every dirty file is
// session-owned, `add -A` is harmless even with siblings present.

import type { GuardRule } from "../types.js";

const COHORT_GATE = {
	predicate: { name: "active_agent_count_at_least", args: { count: 2 } },
} as const;

const BASH_TOOLS = ["Bash", "Shell", "run_command"];

export const COHORT_DISCIPLINE_RULES: GuardRule[] = [
	{
		id: "builtin-cohort-git-stash",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: BASH_TOOLS,
		action: "block",
		patterns: [
			{
				field: "command",
				// Read-only stash subcommands stay allowed; drop/clear are
				// blocked unconditionally by builtin-git-stash-destroy already.
				regex: "\\bgit\\s+stash\\b(?!\\s+(?:list|show)\\b)",
				executed_only: true,
			},
		],
		reason:
			"Another agent is active in this worktree. `git stash` removes EVERY uncommitted change from the tree — including a sibling agent's in-flight work it never named (`stash pop` later reintroduces unknown state on top of theirs).",
		suggestion:
			"Commit named paths instead: `git commit <path> … -m '…'`. Coordinate before touching shared git state.",
		severity: "high",
		category: "cohort-discipline",
		keywords: ["stash"],
		active_when: COHORT_GATE,
	},
	{
		id: "builtin-cohort-git-rebase",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: BASH_TOOLS,
		action: "block",
		patterns: [{ field: "command", regex: "\\bgit\\s+rebase\\b", executed_only: true }],
		reason:
			"Another agent is active in this worktree. `git rebase` rewrites the shared local branch base under every concurrent agent's feet.",
		suggestion:
			"Merge instead, or wait until you are the only active agent. (`git rebase -i` is separately gated solo too.)",
		severity: "high",
		category: "cohort-discipline",
		keywords: ["rebase"],
		active_when: COHORT_GATE,
	},
	{
		id: "builtin-cohort-git-switch-branch",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: BASH_TOOLS,
		action: "block",
		patterns: [
			{
				field: "command",
				// First argument is not a flag → a branch/path target. Creation
				// forms (`-b`/`-c`) start with a flag and stay allowed — creating
				// a branch is how an agent AVOIDS stepping on a shared branch;
				// never make branch creation harder than committing.
				regex: "\\bgit\\s+(?:checkout|switch)\\s+(?!-)",
				executed_only: true,
			},
		],
		reason:
			"Another agent is active in this worktree. Switching branches moves HEAD and rewrites the working tree under every concurrent agent.",
		suggestion:
			"Wait until you are the only active agent, or use a separate worktree (`git worktree add`) for branch work.",
		severity: "high",
		category: "cohort-discipline",
		keywords: ["checkout", "switch"],
		active_when: COHORT_GATE,
	},
];
