# GitOps

- **Source:** OpenGitOps (opengitops.dev — the CNCF project that formalized the four principles); pattern originally coined by Weaveworks ~2017. Reference reconcilers: Flux, Argo CD.
- **Encountered:** 2026-05-18 — surfaced by a teaching question in an interlinked-cli session ("how is GitOps relevant to our phases?").
- **Verdict:** memory note → RFC. Lane 4 pattern. One spin-off worth a spike (§7).

## 1. Core idea (one sentence, my words)

GitOps is a control loop: a system's desired state lives as declarative, version-controlled files, and a long-running agent inside the environment continuously pulls those files and reconciles actual state back to them — so a deploy is a side effect of a commit and a rollback is `git revert`.

## 2. Anatomy (load-bearing claims — GitOps is a pattern, not a repo)

1. **Desired state is declarative and versioned.** Describe what should be true, in files, with full Git history; every change is reviewed, attributable, revertable.
2. **A reconciler continuously closes the gap.** A long-running agent compares actual vs desired and acts — it converges forever, doesn't fire once. Drift is the error signal.
3. **Pull beats push.** The reconciler lives inside the environment and pulls; no external pipeline needs inbound credentials, and the loop self-heals because it keeps re-checking.
4. **CI and CD separate.** CI builds and tests artifacts; "CD" is just a Git write the reconciler later picks up. The pipeline never touches the environment directly.
5. **Often paired with an admission controller.** OPA Gatekeeper / Kyverno reject non-conforming changes *before* they apply — gate-at-write, complementing reconcile-after-the-fact.

Canonical triad to keep: desired state / actual state / drift. Rollback = revert the setpoint; the loop re-converges. Audit = "which SHA was active?"

## 3. Deterministic or agentic?

Deterministic. The reconcile loop is pure compare-and-converge — no model inference anywhere in canonical GitOps. So it does **not** auto-route to Lane 5. Applied to interlinked-cli the GitOps *mechanism* (pull desired state from a ref, diff, report/converge) stays deterministic on every surface; in Guardrails / Agent CI the LLM is the *check being gated*, not the reconcile mechanism.

License: N/A — borrowing a pattern, not code or text. Flux and Argo CD are Apache-2.0 if ever invoked as subprocesses; no constraint either way.

## 4. Substrate vs. surface

Substrate = the reconcile loop + the desired/actual/drift triad. Surface = `kubectl`-free container deployment. interlinked-cli would borrow only the substrate (reconcile loop applied to guard-rules / policy); the surface is irrelevant — nothing here deploys containers.

## 5. Lane (1–6)

**Lane 4 — pattern / architecture.** GitOps is a design idea, not code, a regex, or a parser; the rubric's own Lane-4 examples (Sondera escalate, Supermodel regime) are the same shape. It is a *thin* Lane 4, though: see Notes — the lens mostly renames components that already exist and generates exactly one concrete new action.

## 6. Dependency & displacement

- **Deps:** none. GitOps is a pattern — adopting it imports no library and adds no runtime dependency. Flux / Argo CD are Kubernetes controllers; nothing here would invoke them, so even the subprocess option is moot.
- **Displacement:** it overlaps two things already in the harness — `registry-parity.ts` (already a declared-vs-actual drift reconciler) and rules-loader hot-reload (already a partial reconciler that pulls desired state from disk). The lens says *consolidate* those under one reconcile abstraction, not add anything new. Displacement here means consolidation, not replacement.

## 7. Smallest spike

≤½ day. **Measure drift on the loop that already exists.** Add one diff to `interlinked verify` (or `harness status`): load the running guard-rules and compare against (a) the committed `.interlinked/guard-rules.json` and (b) the `origin/main` version of that file; report "running rules differ by N entries."

It's a JSON diff over two reads — a measurement, not a feature. If drift is always zero, the GitOps reconcile framing adds little here. If the working-tree-vs-`origin/main` delta is ever nonzero, that confirms the real gap: an agent can weaken `guard-rules.json` in the working tree and the harness trusts it on the next call. The measurement de-risks the actual feature — **ref-pinned policy evaluation**: `rules-loader.ts` loads guard-rules from a reviewed ref (merge-base / `origin/main`), not the working tree, so a human changes rules via commit→push→review while an agent's working-tree edit is ignored until merged.

## 8. Phase relevance

GitOps is a lane-4 pattern that shapes all three products.

| Surface (phase) | Slice that lands here | Spike | Horizon |
|-----------------|-----------------------|-------|---------|
| Free CLI (P1) | Drift measurement + ref-pinned policy evaluation; generalize `registry-parity.ts` into one declared-vs-actual reconciler | §7 (drift measurement) | now |
| Guardrails (P2–3) | Cloud gate pulls policy artifacts from a Git ref by SHA → every decision reproducible and auditable | wire a policy SHA into the gate's load path | next |
| Agent CI (P4–5) | Write-back reconciliation: scheduled `verify` against `main` → auto cleanup-PR for `codebase_existing` drift | medium — reuse the recurrence scanner | next |

Beyond the §8 rollout: at multi-agent scale (the collaboration axis in `project_vision_multiagent.md`, not a numbered phase) GitOps becomes multi-tenant — many reconcilers, one policy source, reservations as optimistic concurrency, desired-state-down / observed-state-up channels. A scale the cloud tier enables, not a surface to ship to.

## 9. Artifact

Memory note now (Lane 4 default). The §7 spike → if it shows drift signal, an RFC for ref-pinned policy evaluation, landing as a PR to `rules-loader.ts` + a config flag — the **now** row of §8. The Guardrails and Agent CI rows need no new artifact; they are already implied by `docs/design/tier-2-llm-policy-gate.md` and `tier-3-async-deep-review.md`. The multi-agent-scale angle is context, not scheduled work.

## Notes

- **The honest verdict: the lens mostly renames.** `registry-parity.ts` = a drift reconciler; rules-loader hot-reload = a partial reconciler; reservations = GitOps optimistic concurrency (k8s `resourceVersion`); recurrence `codebase_existing` = a drift inventory; the advisory→default→block ratchet = progressive delivery of policy. Renaming is communication value, not action. The **one** action the lens generates that isn't already on the roadmap is ref-pinned policy evaluation (§7). Weight the verdict on that finding, not the vocabulary.
- Connects to `project_settings_permission_validator.md` (the agent-edits-its-own-guardrails gap — ref-pinning is the GitOps-shaped fix) and `feedback_hook_latency_budget.md` (pull desired state on a slow loop into an in-memory snapshot; never reach to Git on the sub-10ms path).
- Anti-pattern to avoid: do **not** let the lens push high-churn actual-state (activity events, trigram index, trajectory) into Git. GitOps governs desired state only.

## Methodology notes (optional)

- A pure pattern (Lane 4) is handled as a prose source — §2 = load-bearing claims, §3 = is the *mechanism* deterministic. §2's prose-source clause now names patterns explicitly, folded in during the May-2026 rubric expansion that also added §6 (Dependency & displacement) and §8 (Phase relevance). This intake is filled in against that expanded template.
