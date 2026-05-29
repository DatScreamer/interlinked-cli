# Linked workspace — multi-repo agent confinement

**Status:** v1 shipped 2026-05-28 (confinement only). Cross-root reservations /
trajectory / grep-index are deferred follow-ons.

## The tension

The harness confines an agent's writes to one project root
(`evaluateRepoConfinement` in `src/harness/evaluator/filesystem-guards.ts`) —
a safety property that stops an agent scribbling across the filesystem. But
real work spans repos: a client + server, microservices, or our own case — the
**public CLI** (`interlinked-cli`) plus the **private cloud** (soon a sibling
`interlinked-cloud` repo). A cross-cutting change (e.g. the auth contract that
touched both the Worker and the daemon) needs to write to two roots; single-root
confinement blocks the second.

This is also a workflow our **users** hit — so the harness handling it well is a
product capability, not just internal plumbing.

## The model

A **workspace = the primary project root + N declared linked roots.** Writes are
permitted inside any member; everything else is still blocked. The set is
explicit and declared in committed config — bounded, auditable, never "write
anywhere".

```text
  interlinked-cli/        ← primary root (where the agent starts)
  interlinked-cloud/      ← declared linked root (sibling)
       agent may write to BOTH; nothing else.
```

## Config

`linked_projects: string[]` on the guard config (`GuardRulesConfig`; default
`[]`). Relative paths resolve against the **project root**, so they're portable
across machines:

```jsonc
// interlinked-cli/.interlinked/guard-rules.json (or the merged config)
{ "linked_projects": ["../interlinked-cloud"] }
```

Distinct from `repo_confinement_allowlist` (absolute escape hatches like
`~/.claude`): `linked_projects` are **declared workspace members**, the
multi-repo model. Both feed the confinement allowlist; they're kept separate so
intent is legible.

Declaration is symmetric — each repo lists its sibling(s), so a session started
in either root can reach the other.

## Safety

- The set lives in **committed config** → visible in diffs, team-agreed,
  auditable. An agent can't silently widen its own write scope.
- Resolution is bounded to the declared roots; a write outside primary +
  linked + allowlist still returns the `builtin-repo-confinement` block.
- This is *not* a relaxation of the safety property — it's a precise widening
  of "the project" from one root to a declared set.

## Deferred follow-ons

v1 covers the **write-confinement** gate only (the thing that blocks). The
harness's other per-project state still anchors to a single root; extending
these to span linked roots is the next increment:

- **Reservations** — cross-root file leasing so concurrent agents coordinate
  across the workspace, not just one repo.
- **Trajectory / session state** — one session spanning two roots (relates to
  the daemon root-detection + the writes-tracker persistence work).
- **Grep index / project-graph** — index + dependency analysis across members.

Until those land, expect single-root behavior for reservations/index even with
linked_projects declared; only writes are workspace-aware.
