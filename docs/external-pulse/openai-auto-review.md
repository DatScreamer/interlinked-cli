# OpenAI Auto-review

- **Source:** OpenAI Alignment Research blog, "Auto-review of agent actions without synchronous human oversight", 2026-04-30, https://alignment.openai.com/auto-review/
- **Encountered:** 2026-05-03, user pasted full post text + `INTAKE.md` pointer.
- **Verdict:** lane 5 (cloud-only LLM-as-reviewer), lane 4 (boundary-review architecture pattern), thin lane 2 (deterministic unsafe-approval-config lint).

## 1. Core idea (one sentence, your words)

Codex Auto-review replaces frequent synchronous user approvals at sandbox boundaries with a separate reviewer agent that decides whether a boundary-crossing action should run, gives rejection rationale to the main agent, and stops trajectories after repeated denials.

## 2. Anatomy (load-bearing claims, your words)

Prose source, so anatomy = load-bearing claims worth carrying forward.

1. **Approval friction pushes users toward worse security defaults.** The post's central product claim is that frequent manual approval trains users to either switch to full access, add broad allow rules, or approve requests without understanding them. That is directly relevant to interlinked's guard UX: a high-friction "safe" mode can backfire if users route around it.
2. **The reviewer is a separate role, not the main agent grading itself.** The main agent optimizes for task completion and has pressure to treat a permission boundary as an obstacle. Auto-review moves the boundary decision into a separate model call with a narrower job: evaluate intent, policy, environment, and impact.
3. **The system accepts non-determinism deliberately.** Auto-review is an LLM judge. It is evaluated statistically, not proven correct. Reported internal numbers include about 99.1% approval on escalated actions, 99.93% effective approval across all actions, 90.3% recall on synthetic overeagerness, 99.3% recall on prompt-injection cases covering RCE / secret exfiltration / external upload, and 96.1% MonitoringBench Hard recall.
4. **Denial is a steering signal, not only a stop.** Rejections include rationale that helps the main Codex agent continue safely. In the illustrative deployment snapshot, most actions stay inside the sandbox, a small slice is auto-reviewed, and some denied requests still continue through a safer alternative.
5. **Repeated-denial trajectory control matters.** The post explicitly calls out attempts to game the reviewer and says trajectories are stopped after repeated denials. That is a useful pattern for any approval/review layer: a denial loop is itself a risk signal.
6. **The caution section is load-bearing.** Auto-review is not a deterministic guarantee, does not protect against all scheming, and only sees actions that cross the sandbox boundary. This maps cleanly onto interlinked's existing deterministic-harness boundary: local CLI checks should not silently become LLM judgment.

## 3. Deterministic or agentic?

**Agentic primary, hybrid system.**

- **Deterministic substrate:** sandbox boundary, workspace-write policy, configured allow rules, escalation event, repeated-denial stop condition, production metrics, eval harnesses, and action telemetry.
- **Agentic core:** the approval decision itself is made by a separate Codex reviewer model. The value proposition depends on model judgment about user intent and likely harm.

License: prose source for this intake, so no license gate for the pattern. The post says Auto-review is open source in the Codex repository; this entry does not evaluate that repository or license. If code reuse becomes tempting, do a separate source read first.

## 4. Substrate vs. surface

- **Surface:** Codex Auto-review mode, replacing human approval for sandbox escalations.
- **Substrate:** a boundary-event schema, a security policy, a reviewer prompt/model call, a rejection-rationale channel back to the main agent, repeated-denial trajectory control, and friction/safety eval telemetry.

The substrate can be copied as an architecture pattern. The reviewer decision itself should not move into interlinked-cli because it violates the deterministic-only CLI harness rule. It does fit guardrails-cloud / agency-cloud where model-based review can be evaluated, monitored, and improved across deployments.

## 5. Lane

**Lane 5 primary, lane 4 secondary, thin lane 2.**

- **Lane 5 - cloud-only fodder.** Auto-review is exactly the shape of guardrails-cloud: model-based oversight for boundary-crossing agent actions, with evals, red-teaming, and production monitoring. It should not be implemented as a local CLI default because the CLI has no fleet telemetry, A/B surface, or central red-team loop to calibrate a model judge safely.
- **Lane 4 - pattern.** The separation between task agent and approval reviewer is the main reusable architecture. So are denial-as-steering, repeated-denial trajectory stop, and measuring both friction and safety recall instead of optimizing only one.
- **Lane 2 - deterministic lint opportunity.** The post's broad-allow-rule examples are directly lintable. Interlinked can inspect Codex config for risky approval bypasses such as `--yolo`, full-access defaults, or overly broad prefix approvals like `python` without making any LLM judgment.

Not lane 3 yet. Although the implementation is reportedly open source, this intake did not read the Codex repository. Invoke/borrow decisions require a separate source and license pass.

## 6. Smallest spike

**Unsafe Codex approval-config lint - half a day.**

Add a deterministic check that runs from `interlinked doctor` and possibly `interlinked enable --clients codex`:

1. Read `.codex/config.toml`, `.codex/hooks.json`, and known Codex rule files when present.
2. Flag full-access / yolo-style settings as high-severity warnings.
3. Flag broad command-prefix approvals such as `python`, `node`, `sh`, `bash`, `curl`, `wget`, `npx`, and `npm` when the approval rule grants unsandboxed execution without narrower arguments.
4. Include a concrete safer suggestion: narrow the prefix, keep network off by default, or route the action through an explicit one-off approval.
5. Add regression tests with synthetic config fixtures. No model calls, no server dependency.

This is small, local, and aligned with the post's strongest deterministic lesson: approval friction creates pressure to write unsafe bypasses, so detect the bypasses.

## 7. Artifact

Memory note (this file) + half-day CLI lint spike when prioritized. A separate guardrails-cloud RFC is warranted if model-based boundary review becomes near-term.

## 8. Surface

- **interlinked-cli:** deterministic unsafe-approval-config lint for Codex settings.
- **guardrails-cloud:** model-based review for boundary-crossing actions, with eval and red-team loops.
- **agency-cloud:** reviewer-agent pattern for autonomous agent teams where human synchronous approval would kill throughput.

## Notes

- This reinforces the current external-pulse cluster: agent-facing surfaces should be designed for agents, not exposed as legacy "all or nothing" authority. Railway showed the failure mode at provider API level; Auto-review shows the same pressure at local sandbox-boundary level.
- This also sharpens the product split. The local CLI should keep deterministic pre-blocks and warnings. The cloud products can host LLM review because they can gather telemetry, run evaluations, and iterate reviewer policy across real deployments.
- The eval methodology is as important as the feature: usability approval rate, effective approval rate across all actions, recall on overeagerness, prompt-injection recall, trajectory-level malicious-action recall, latency, overrides, and frequently flagged commands. Any future guardrails-cloud reviewer needs the same scorecard before it is trusted.
- The denial-rationale channel is worth copying even for deterministic rules. A block that gives the agent a safer route is more useful than a block that only says no.
- Repeated-denial stop condition maps to existing trajectory work in `src/harness/trajectory.ts`: repeated rejected escalations should become their own trajectory signal if interlinked ever observes enough approval events to model it.

## Methodology notes

- This is a clean example of the determinism filter doing real work. The idea is compelling, but the core approval decision is model judgment, so it routes to lane 5 rather than becoming a local CLI harness feature.
- Prose-source intake needs to preserve caution language, not just the headline metric. The post's "not a guarantee" caveat is part of the architecture, because it defines where deterministic systems must remain in front of or alongside model-based review.
