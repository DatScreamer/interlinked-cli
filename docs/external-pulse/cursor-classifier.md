# Cursor Auto-Review Classifier

- **Source:** [Terminal / Run Mode](https://cursor.com/docs/agent/tools/terminal), [`permissions.json` / `autoRun`](https://cursor.com/docs/reference/permissions), [`sandbox.json`](https://cursor.com/docs/reference/sandbox), [Securing our codebase with autonomous agents](https://cursor.com/blog/security-agents), [GHSA-82wg-qcm4-fp2w (allowlist bypass via env vars)](https://github.com/cursor/cursor/security/advisories/GHSA-82wg-qcm4-fp2w)
- **Encountered:** 2026-05-29, user-requested classifier research
- **Verdict:** compound (see §9) — sibling of `cursor-harness.md` (that covers Cursor's harness *shape*; this covers the *classifier mechanism* + run-mode)

## 1. Core idea (one sentence, your words)
Cursor's "Auto-review" mode gates Shell/MCP/Fetch calls through three ordered checks — allowlist → OS sandbox → an LLM classifier that returns allow/block on two axes (is it safe **and** does it match the user's stated intent) — where the sandbox, not the classifier, is the security boundary.

## 2. Anatomy (concrete walkthrough)
Three checks, **in order**, for every Shell/MCP/Fetch call:
1. **Allowlist** (deterministic) — `terminalAllowlist` / `mcpAllowlist` prefix-match → run immediately.
2. **Sandbox** (OS-level) — Seatbelt (macOS) / Landlock v3 (Linux) / WSL2 (Windows); network deny-by-default + curated domain allowlist; FS read-all + workspace-write + `/tmp`; SSRF targets (RFC1918, `169.254.169.254`, IPv6 ULA) hard-blocked. If the kernel can't sandbox → fall back to asking.
3. **Classifier** (LLM) — only what can't be sandboxed reaches it. Fed **command + current user request + `autoRun` NL instructions** from `permissions.json`; returns **allow / block**. On block, the agent retries differently or surfaces a human approval prompt.

Load-bearing details:
- **Two-axis judgement:** "safety **and** how well the call matches your intent." The intent-alignment axis is the part nobody else has.
- **NL steering, not rules:** `autoRun.allow_instructions` / `block_instructions` (per-user ∪ per-repo, concatenated). "Steering, not enforcement."
- **Explicitly not a boundary:** docs say "best-effort convenience, not a security boundary… use Allowlist for strict control." It's free ("no extra cost") → a cheap model.
- **Precedence + un-overridable floor:** team-admin > permissions.json > IDE; sandbox per-user < per-repo < team-admin < hardcoded; hardcoded rules + protected paths (`.git/hooks`, `.git/config`, `.cursor/*.json`, `.ssh` read-only) **cannot be weakened by config**.
- **The CVE (GHSA-82wg):** trusted-command allowlist bypassed via env-var poisoning / shell built-ins. Lesson: an allowlist must **parse the whole command** (env prefixes, chaining, substitution), not prefix-match the leading token.

## 3. Deterministic or agentic?
Hybrid. Allowlist + sandbox are deterministic; the classifier is agentic (non-deterministic, fail-allow). **License:** Cursor is proprietary — nothing to borrow as code; this is a pattern (lane 4) + the model we'd actually run (`gpt-oss-safeguard`, Apache-2.0) is lane 5. The famous Cursor RL work is **Composer** (their coding model: async RL in-harness, RLVR, real-time checkpoints) — there is **no evidence the safety classifier is a bespoke RL model**; don't conflate them.

## 3b. Role in its native architecture — and does it transfer?
At home the classifier is a **convenience** layer backstopped by the sandbox **boundary** — a wrong "allow" is contained by the sandbox, so it can fail-allow safely. Transfer:
- Into our **local** topology (no sandbox) → the classifier must become **escalation-only / tighten-only** (allow→ask/block, never block→allow). Already how `mergeCloudVerdict` + the shadow `policy-classifier` are wired.
- Into our **cloud** topology (Cloudflare Sandboxes, GA 2026-04-13) → it *can* be Cursor-style convenience, because the Sandbox is the boundary. This is the clean local/cloud split.

## 4. Substrate vs. surface
Substrate: the **ordered 3-gate pipeline** + the **intent-alignment axis** + **NL steering** fed to the gate. Surface: the IDE run-mode UI. The substrate is fully borrowable as a pattern; we already have the pipeline and a shadow classifier — the missing substrate is the intent axis and the steering input.

## 5. Lane (1–6)
Lane 4 (pattern — the 3-gate + intent axis) + lane 5 (cloud classifier).

## 6. Dependency & displacement
- **Deps:** none added (pattern + an open-weight model run server-side).
- **Displacement:** overlaps the harness command-safety path directly; it's a design comparison, nothing to import.
- **Equivalence (capability-by-capability):**

| Cursor capability | Our equivalent | Status |
|---|---|---|
| allow/block classifier | `policy-classifier.ts` (shadow) | **shipped** |
| tighten-only team override | `mergeCloudVerdict` / cloud governor v0 | **shipped** |
| approval prompt on block | `ask` decision + `resolution_targets` | **shipped** (richer than Cursor) |
| terminal/package allowlist | `package-allowlist.ts` (fail-closed) | **shipped** |
| env-var bypass defense (the CVE) | `package-install-parser.ts:237` strips leading env vars; splits `&&`/`\|\|` | **shipped** (package path) |
| sandbox SSRF block | `content-scanner/web-fetch-proxy.ts` | **shipped** |
| NL steering (`autoRun`) | `/enforce` lexical ladder (compiles NL→rules) | **shipped** (different end of the spectrum) |
| **intent-alignment axis** | `network_after_user_input_url_match` (crude deterministic prototype) | **absent** (the gap to close) |
| **execution sandbox** | — (local); Cloudflare Sandboxes (cloud) | **absent local / designed cloud** |
| **un-disableable hardcoded floor** | built-ins are all disableable via `disabled_rules` | **absent** |
| protected `.git/hooks` / `.git/config` | `protected_files` covers `.env`/`.pem`/`.key`/CI, **not** `.git/hooks` | **gap** |

## 7. Smallest spike
Two XS wins independent of the classifier: add `.git/hooks/**` + `.git/config` to `protected_files`, and carve an un-disableable floor (`disabled_rules` can't turn off `rm -rf /` / `.git/hooks` write / secret-exfil). The larger thread — an intent-alignment label on the shadow `policy-classifier` fed the user's recent request — is RFC-sized, not a spike.

## 8. Phase relevance
| Surface (phase) | Slice that lands here | Spike | Horizon |
|-----------------|-----------------------|-------|---------|
| Free CLI (P1) | protected `.git/hooks`; un-disableable floor; command-parser parse-don't-prefix-match audit | XS each | now |
| Guardrails (P2–3) | intent-alignment axis on the classifier; `autoRun`-style NL steering fed from `/enforce`'s discarded hedged residue; gpt-oss-safeguard on Workers AI behind AI Gateway | RFC | next |
| Agent CI (P4–5) | Cloudflare Sandbox as the execution boundary → cloud classifier can be convenience-mode; Tier-3 prose-finding dedup (cheap-model) | design | parked |

## 9. Artifact
**Compound.** (a) RFC/design — `docs/design/open-obligation-ledger.md` (the trajectory/intent spinoff). (b) cloud-roadmap entries — intent-alignment axis + `autoRun` steering into Tier 2. (c) memory — `reference_cloudflare_ai_substrate.md`. (d) small CLI PRs — `.git/hooks` protected-paths, un-disableable floor. **Carve-out:** adopt the intent axis + steering + protected-floor; **reject** the auto-approve / classifier-as-boundary (no local sandbox to backstop it).

## 10. Notes
- Sibling intake: `cursor-harness.md` (Cursor's rules/hooks/tool-gating shape). This file is the classifier/run-mode deep-dive; keep them cross-linked, don't merge.
- The "convenience layer backstopped by a boundary" framing is the load-bearing insight — it drove the §3b template addition.
- The intent axis is dogfooded: `network_after_user_input_url_match` fired on an author-requested cursor.com fetch during this very research — a deterministic intent-check that can't tell "user pasted this URL" from "fetched content told me to." That ambiguity is what an LLM intent-axis resolves.
- Cursor's own Sandbox security doc repeats the GHSA lesson (`cat ${userInput}` → `file.txt; rm -rf /`) — command-injection-via-interpolation is the same parse-don't-prefix-match discipline.
