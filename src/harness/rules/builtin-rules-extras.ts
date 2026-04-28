// ===========================================
// Built-in Rules — Plan 02 destructive command extras (DCG ports)
// ===========================================
//
// Ten high-signal destructive-command guards ported from
// destructive_command_guard (DCG) per Plan 02 in
// `docs/plans/free-cli-adoption/02-destructive-command-rules.md`.
//
// Each entry closes a gap in the existing 77-rule corpus:
//   - kubernetes namespace / pvc / mass deletion (the catch-all rules
//     in builtin-rules-database.ts cover only the verb, not these
//     specific resource types)
//   - docker system / volume prune with --dry-run carve-out
//   - git stash drop|clear (irreversible, no reflog)
//   - git rebase --interactive (history rewrite, ask not block)
//   - terraform state rm / taint (state surgery, easy to orphan
//     resources)
//   - helm uninstall in a production namespace (catastrophic,
//     conservative — only fires on explicit `--namespace prod`)
//
// Regex strings are copied verbatim from Plan 02 §2.1–§2.10.
// Keywords are populated for Plan 01's keyword-quick-reject so these
// rules don't run on every Bash call — only when the command line
// contains `kubectl`, `docker`, `git`, `terraform`, or `helm`.
//
// All entries use `tool_match: ["Bash", "Shell", "run_command"]` to
// match the convention in the rest of the corpus (Plan 02 lists only
// "Bash", but the existing rules consistently include the legacy
// `Shell` and `run_command` aliases for cross-runner compatibility —
// see `_phase1-phase-matrix.md` per-runner column).

import type { GuardRule } from "../types.js";

/**
 * Public API — consumed by `rules/builtin-rules.ts` to assemble the full
 * BUILTIN_RULES array exported by `rules-loader.ts`. Ordering note: this
 * pack is registered AFTER `RAILWAY_RULES` and BEFORE
 * `MCP_DESTRUCTIVE_RULES` so vendor-specific rules retain priority while
 * these refinements override generic catch-all matches that follow.
 */
export const DESTRUCTIVE_V1_EXTRA_RULES: GuardRule[] = [
	// 2.1 — kubectl delete namespace
	{
		id: "builtin-kubectl-delete-namespace",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Bash", "Shell", "run_command"],
		action: "block",
		patterns: [
			{
				field: "command",
				regex: "\\bkubectl\\b.*\\bdelete\\s+(namespace|ns)\\b",
				flags: "i",
			},
		],
		reason:
			"kubectl delete namespace destroys all resources in the namespace (pods, pvcs, services, secrets)",
		suggestion:
			"Preview first: kubectl delete ns NAME --dry-run=client. To remove only specific resources: kubectl -n NAME delete <resource> -l <selector>",
		severity: "critical",
		category: "kubernetes",
		keywords: ["kubectl"],
	},

	// 2.2 — kubectl delete <type> --all (negative-lookahead permits
	// `pods --all`, `secret --all`, `configmap --all` for scratch envs)
	{
		id: "builtin-kubectl-delete-all",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Bash", "Shell", "run_command"],
		action: "block",
		patterns: [
			{
				field: "command",
				regex:
					"\\bkubectl\\b.*\\bdelete\\s+(?!secret|configmap|pod\\b)[^\\s]+\\s+--all\\b",
				flags: "i",
			},
		],
		reason:
			"kubectl delete <type> --all removes all resources of a type (rarely intentional, no undo)",
		suggestion: "Use a label selector instead: kubectl delete <resource> -l app=<label>",
		severity: "high",
		category: "kubernetes",
		keywords: ["kubectl"],
	},

	// 2.3 — kubectl delete pvc / pvcs
	{
		id: "builtin-kubectl-delete-pvc",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Bash", "Shell", "run_command"],
		action: "block",
		patterns: [
			{
				field: "command",
				regex: "\\bkubectl\\b.*\\bdelete\\s+pvc(?:\\b|s\\b)",
				flags: "i",
			},
		],
		reason:
			"kubectl delete pvc destroys persistent volume claims; if reclaim policy is Delete, the underlying disk is wiped",
		suggestion:
			"Check reclaim policy first: kubectl get pvc NAME -o jsonpath='{.spec.volumeName}' | xargs kubectl get pv -o jsonpath='{.spec.persistentVolumeReclaimPolicy}'",
		severity: "high",
		category: "kubernetes",
		keywords: ["kubectl"],
	},

	// 2.4 — docker system prune (ask; --dry-run permitted)
	{
		id: "builtin-docker-system-prune",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Bash", "Shell", "run_command"],
		action: "ask",
		patterns: [
			{
				field: "command",
				regex: "\\bdocker\\s+system\\s+prune\\b(?!.*--dry-run)",
				flags: "i",
			},
		],
		reason:
			"docker system prune removes dangling images, stopped containers, networks, and (with -a) unused images",
		suggestion: "Preview first: docker system df -v. Or scope: docker system prune --filter 'until=24h'",
		severity: "medium",
		category: "containers",
		keywords: ["docker"],
	},

	// 2.5 — docker volume prune / volume rm $(...)
	{
		id: "builtin-docker-volume-prune",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Bash", "Shell", "run_command"],
		action: "block",
		patterns: [
			{
				field: "command",
				regex: "\\bdocker\\s+volume\\s+(?:prune|rm\\s+\\$\\(.*\\))",
				flags: "i",
			},
		],
		reason: "docker volume prune deletes unused volumes; data loss if not backed up",
		suggestion:
			"List first: docker volume ls -q -f dangling=true. Inspect: docker volume inspect <name>",
		severity: "high",
		category: "containers",
		keywords: ["docker"],
	},

	// 2.6 — git stash drop / clear
	{
		id: "builtin-git-stash-drop-or-clear",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Bash", "Shell", "run_command"],
		action: "block",
		patterns: [
			{
				field: "command",
				regex: "\\bgit\\s+(?:\\S+\\s+)*stash\\s+(?:drop|clear)\\b",
				flags: "i",
			},
		],
		reason:
			"git stash drop / clear permanently discards stashed changes (no reflog for stashes)",
		suggestion: "Review first: git stash list. Inspect a stash: git stash show -p stash@{N}",
		severity: "high",
		category: "git",
		keywords: ["git"],
	},

	// 2.7 — git rebase -i / --interactive (ask, not block)
	{
		id: "builtin-git-rebase-interactive",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Bash", "Shell", "run_command"],
		action: "ask",
		patterns: [
			{
				field: "command",
				regex: "\\bgit\\s+rebase\\b.*\\b(-i|--interactive)\\b",
				flags: "i",
			},
		],
		reason:
			"Interactive rebase rewrites commit history; destructive on shared branches and easy to lose work in",
		suggestion:
			"Confirm the branch is local-only. Back up first: git branch backup-$(date +%s) HEAD",
		severity: "medium",
		category: "git",
		keywords: ["git"],
	},

	// 2.8 — terraform state rm
	{
		id: "builtin-terraform-state-rm",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Bash", "Shell", "run_command"],
		action: "block",
		patterns: [
			{
				field: "command",
				regex: "\\bterraform\\s+state\\s+rm\\b",
				flags: "i",
			},
		],
		reason:
			"terraform state rm deletes resource state; resource becomes orphaned in cloud (still costs money, no longer managed)",
		suggestion:
			"Use terraform taint to mark for recreation, or terraform state mv to relocate. To stop managing: terraform state list, then plan a refactor",
		severity: "high",
		category: "infrastructure",
		keywords: ["terraform"],
	},

	// 2.9 — terraform taint (ask)
	{
		id: "builtin-terraform-taint",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Bash", "Shell", "run_command"],
		action: "ask",
		patterns: [
			{
				field: "command",
				regex: "\\bterraform\\s+taint\\b",
				flags: "i",
			},
		],
		reason: "terraform taint marks a resource for destruction and recreation on next apply",
		suggestion:
			"Review terraform plan output before applying. Use replace flag: terraform apply -replace=<resource>",
		severity: "medium",
		category: "infrastructure",
		keywords: ["terraform"],
	},

	// 2.10 — helm uninstall in production namespace
	{
		id: "builtin-helm-uninstall-prod",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Bash", "Shell", "run_command"],
		action: "block",
		patterns: [
			{
				field: "command",
				regex: "\\bhelm\\s+(?:uninstall|delete)\\b.*\\b(?:--namespace|-n)\\s+(?:prod|production)\\b",
				flags: "i",
			},
		],
		reason: "helm uninstall in a production namespace removes a release entirely",
		suggestion: "Use helm rollback to a previous revision instead. Verify: helm list -n prod",
		severity: "critical",
		category: "kubernetes",
		keywords: ["helm"],
	},
];
