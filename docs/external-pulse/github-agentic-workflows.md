# GitHub Agentic Workflows (gh-aw)

- **Source:** https://github.com/github/gh-aw (graduated from `githubnext/gh-aw`; blog still links the old org) • docs https://github.github.com/gh-aw/ • announcement https://github.blog/changelog/2026-06-11-github-agentic-workflows-is-now-in-public-preview/ • prebuilt catalog https://github.com/githubnext/agentics
- **Encountered:** 2026-06-11, user prompt — public-preview changelog post
- **Verdict:** compound — **PR** (port the hidden-channel content-sanitization inventory into our signature families) + **pattern notes** (staged typed side-effects, DIFC integrity lattice, one-allowlist-drives-two-enforcements) + **cloud-roadmap entry** (threat-detection job = our Tier 3, MIT prompt reusable; Agent CI category validation) + **skip** (GitHub-Actions plumbing, trigger-role gates, reactions)

## 1. Core idea (one sentence, your words)

A markdown file whose YAML frontmatter declares an agent's full capability envelope (triggers, read-only perms, egress domains, tool allowlist, typed side-effect quota) and whose body is the prompt, compiled by a Go CLI into a ~1,600-line GitHub Actions lock file that runs the agent read-only inside an iptables-firewalled container, sanitizes everything entering its context, and applies its typed, capped side-effect requests through separate privileged jobs only after an LLM threat-detection pass.

## 2. Anatomy (concrete walkthrough)

**Load-bearing pieces (annotated):**

```
pkg/workflow/            Go compiler: frontmatter → .lock.yml. Compile-time security is real:
                         schema validation, expression-safety checks, action SHA-pinning, and
                         third-party scanners (actionlint, zizmor, poutine) run on the OUTPUT.
pkg/workflow/markdown_security_scanner.go
                         804-line deterministic regex scan of the workflow MARKDOWN itself:
                         HTML comments carrying shell keywords, CSS-hidden spans (display:none,
                         font-size:0…), 4+ HTML-entity runs, data:/javascript: URIs, IP-literal
                         URLs, URL shorteners, credential-shaped query params (?token=…).
actions/setup/js/sanitize_content_core.cjs
                         1,335-line dependency-free sanitization pipeline applied to untrusted
                         text (issue/comment bodies) before it reaches the model. Stages, in
                         order: NFC → HTML-entity decode (incl. double-encoded and NAMED-entity
                         forms of invisible chars: &shy; &zwnj; &ZeroWidthSpace; &af;…) → strip
                         zero-width/invisible (U+00AD, U+034F, U+200B–F, U+2060–2064, BOM) →
                         strip Unicode TAG block U+E0000–E007F (fully invisible 1:1 ASCII
                         payloads) → strip bidi controls (U+202A–E, U+2066–69) → full-width→
                         ASCII → NFKC → TR#39 Cyrillic/Greek homoglyph map → ANSI/control strip
                         → strip ALL HTML comments (depth-tracking, handles <!--!…--!>) →
                         neutralize markdown link-title steganography ([t](url "TITLE") — title
                         invisible when rendered, visible to the model) → escape all @mentions →
                         non-allowlisted HTML tags → parens, strip on*/style/title/data-* attrs →
                         redact every non-https protocol (with %25-deep-decode so javascript%253A
                         can't slip) → redact https URLs whose domain is NOT on the network
                         allowlist (anti-exfil; redacted domains logged) → truncate → neutralize
                         "fixes #123" bot-trigger floods → escape template delimiters ({{, <%=,
                         ${…). Code fences/inline code preserved throughout. Fuzz-tested.
github/gh-aw-firewall    AWF, separate MIT repo: privileged container configures iptables and
                         launches the agent container with --allow-domains. Frontmatter `network:`
                         takes ecosystem identifiers — named, compile-time-validated domain
                         bundles (`python`, `node`, `rust`, `containers`…) — plus wildcards.
                         THE SAME allowlist drives both egress enforcement and the sanitizer's
                         URL redaction. `gh aw audit <run-id>` prints per-domain allow/deny with
                         request volume and policy attribution, diffable across two runs.
safe-outputs (compiler + runtime)
                         ~40 typed side-effect verbs (create-issue, add-labels max:3, push-to-pr-
                         branch…), each with per-verb caps and constraints (e.g. close-issue
                         `target: "triggering"` = may only close the issue that fired the run).
                         Exposed to the agent as MCP tools; requests buffer to a JSONL artifact;
                         separate jobs with scoped write perms validate and apply. `missing-tool`
                         and `missing-data` are first-class outputs — a sanctioned "I'm blocked"
                         channel instead of improvising around a gap.
MCP gateway + integrity filtering (`tools.github.min-integrity`)
                         DIFC trust lattice on CONTENT PROVENANCE: merged > approved > unapproved
                         > none > blocked, computed from author association + merge status. The
                         gateway strips below-threshold items from GitHub tool results before the
                         model sees them, logging DIFC_FILTERED. Promotions: trusted-users,
                         approval-labels, (flagged) endorsement reactions; blocked-users always
                         deny. Trust is the filter axis — not permissions.
pkg/workflow/threat_detection.go
                         Compiles an LLM second-opinion job between the agent and the apply jobs:
                         analyzes output + patches for prompt injection, secret leaks, malicious
                         diffs; own AI-credit budget (default 400) independent of the agent's;
                         custom prompt/steps appendable; auto-on whenever safe-outputs exist.
```

**What the user invokes:** `gh aw add githubnext/agentics/issue-triage` → `gh aw compile` → commit the `.md` + `.lock.yml`; later `gh aw logs` / `gh aw audit <run-id>`.

**What the agent sees:** sanitized event text, a read-only filtered GitHub MCP, the declared tools, and safe-output MCP tools as its only write path.

**End-to-end (the `agentics/issue-triage.md` I read):** frontmatter: `on: issues[opened,reopened]`, `permissions: read-all`, `network: defaults`, safe-outputs `add-labels max:5 / add-comment / set-issue-type / close-issue target:triggering`, `tools.github.toolsets:[issues,labels]`, `timeout-minutes:10`; body: a stepwise triage prompt. Run: activation job (role/permission checks, `reaction: eyes` ack, sanitize event text) → agent job (read-only token, AWF + API proxy + MCP gateway containers; agent emits label/comment intents via MCP) → threat-detection job → per-verb apply jobs (scoped writes, caps enforced) → audit artifacts. A ~50-line markdown source compiles to a 1,582-line lock.yml.

The architecture doc's three-layer trust model (substrate / configuration / plan) is unusually rigorous for product docs — the threat model explicitly assumes a fully compromised agent container and bounds blast radius per stage.

## 3. Deterministic or agentic?

**Hybrid, cleanly separated — and the deterministic parts are exactly the portable ones.** Deterministic: the compiler, both sanitizers, the markdown scanner, AWF, integrity filtering, safe-output caps/validation. Agentic: the workflow runtime itself (by design) and the threat-detection job (LLM second opinion). Marketing survives source-reading; if anything the docs undersell the sanitizer.

**License:** MIT on `gh-aw`, `gh-aw-firewall`, and `agentics` — code-borrow and pattern reuse both clean (attribute on verbatim ports).

## 3b. Role in its native architecture — and does it transfer?

At home, safe-outputs + AWF + read-only tokens are the **security boundary**, and the boundary holds because of substrate isolation: privileged containers the agent can't touch, credentials the agent process never possesses. Transplanted into our local topology none of that exists — the agent holds the user's shell, and per `feedback_local_checks_not_a_trust_boundary` local checks are advisory. So every boundary-role component demotes to **detection/warn** in the Free CLI (their rewrite-at-boundary sanitizer becomes our detect-and-flag — we can't mutate `tool_response`, and our own egress-filter comment in `post-tool.ts` already defers response rewriting). The boundary role only re-emerges in our **cloud tier** (Agent CI staged apply, proof-of-enforcement), where we control the substrate. The DIFC integrity lattice transfers intact as a *labeling* discipline — it's metadata computation, not enforcement.

## 4. Substrate vs. surface

Surface: the Actions-native product (compile, triggers, catalog). Substrate: the sanitization pattern inventory, the markdown scanner, AWF, the DIFC gateway, the typed-output validator. The inventories are borrowable without the surface (dependency-free regex/scan logic); AWF is container-topology-bound and does not transplant locally.

## 5. Lane (1–6)

**Lane 2 + 4 + 5** — a mature multi-layer system decomposes, and the determinism filter routes each slice: detection inventories (lane 2 → harness signatures), three architecture patterns (lane 4 → memory/RFC), the agentic jobs and category itself (lane 5 → Agent CI roadmap).

## 6. Dependency & displacement

- **Deps:** none. Everything adoptable is regex/pattern logic re-implemented in `signatures-patterns.ts` / `checks/`; nothing is imported or shelled out to. (AWF would be a subprocess but doesn't fit the local topology at all.)
- **Displacement:** nothing replaced — the sanitization inventory *enriches* the existing `output_scanning` path; AWF overlaps no local component (Claude Code's own sandbox owns local egress; our package-install guard covers the registry layer).
- **Equivalence (capability-by-capability, verified by grep before claiming absence):**

| gh-aw capability | Our equivalent | Status |
|---|---|---|
| NL markdown → compiled deterministic artifact | `/enforce` → distilled-rules.json/Cedar (rules, not pipelines) | shipped |
| Untrusted-content injection scan on fetched/read text | `scanWebFetchInjection` / `scanFileReadInjection` + `INDIRECT_INJECTION_RULES`/`OBFUSCATION_RULES` | shipped — **inventory gap** (below) |
| Hidden-channel inventory: TAG block U+E0000–E007F, entity-encoded invisibles, bidi isolates U+2066–69, homoglyph confusables, link-title steg, CSS-hidden, generic entity runs, %25-deep-decode, full-width bypass, data:/IP/shortener/credential-param links, generic HTML-comment channel | our sigs: 4 zero-width chars (5+ same-type), U+202D/E only, 5 hardcoded base64 phrases, 4 hardcoded entity patterns, `<!-- AI:`/`<!-- SYSTEM:` prefixes only | **absent → the PR** |
| Egress allowlist w/ ecosystem identifiers; same list drives content redaction | package-install guard (registry layer, shipped); `network_after_user_input_url_match` (shipped — fired on this very intake); no per-session domain allowlist | partial |
| DIFC integrity lattice on content provenance | taint-tracker = confidentiality axis only; integrity axis nowhere | absent (pattern) |
| Typed side-effect verbs + caps, privilege-separated apply; `missing-tool`/`missing-data` channel | PreToolUse guards gate in-line; commit gate; proof-of-enforcement R1 (designed) covers refereed apply; sanctioned-blocked channel absent (adjacent: `claim_obligation_ledger`, `gate_gaming` designs) | designed/absent (pattern) |
| LLM threat-detection between output and apply, own budget | Tier 3 async deep review + cloud governor v0 substrate | designed — their MIT prompt is a seed |
| Compile-time injection scan of instruction markdown | `/enforce` distills but never screens its inputs | absent (cheap reuse of the same new sigs) |
| Per-domain egress audit, cross-run diff (`gh aw audit`) | activity.jsonl + recurrence (different cut) | partial, parked |
| Curated catalog of governed workflows (`agentics`, ~60) | Agent CI GTM idea | parked |

## 7. Smallest spike

≤1 day: extend `signatures-patterns.ts` with a hidden-channel inventory ported from `sanitize_content_core.cjs` + `markdown_security_scanner.go` — (a) TAG-block chars (threshold 1 — zero legitimate uses in tool output), (b) invisible-char class widened to U+00AD/034F/200B–F/2060–2064 incl. named-entity-encoded forms, (c) bidi embeddings+isolates U+202A–C/2066–69, (d) homoglyph runs (≥3 TR#39 confusables inside a Latin token), (e) markdown link-title steg, (f) CSS-hidden spans, (g) generic `(&#x?…;){4,}` runs, (h) `%25`-deep-encoded protocol smuggling, (i) full-width ASCII runs, (j) data:/javascript: URIs + IP-literal/shortener/credential-param link targets, (k) HTML comments containing shell/tool keywords. Flows through the **existing** `scanPromptInjection` call sites — zero new wiring. FP discipline: scope (e) to web-fetched content only (titles are legitimate authoring in local docs), scope (f) to non-stylesheet content; ≥3 positive + ≥3 negative cases per new id per house rules. Warning-severity, default gate.

## 8. Phase relevance

| Surface (phase) | Slice that lands here | Spike | Horizon |
|-----------------|-----------------------|-------|---------|
| Free CLI (P1) | Hidden-channel signature inventory into existing scan paths; then reuse the same sigs to screen `/enforce` inputs; DIFC-lite warn (author_association floor on `gh`/GitHub-MCP issue payloads) | §7 | now |
| Guardrails (P2–3) | One-allowlist-two-enforcements: a single committed domain allowlist driving both cloud egress policy and content redaction (their `network:` → sanitizer coupling) as a config-schema design input | schema sketch in the Guardrails design doc | next |
| Agent CI (P4–5) | Category validated at GitHub scale. Port their threat-detection prompt as the Tier 3 seed; their buffer→validate→apply staging maps onto proof-of-enforcement R1 (CF Sandboxes substrate). Differentiation: local-first + repo-host-agnostic + per-edit cadence (theirs is per-run, GitHub-locked) | prompt port + mapping memo | next |

## 9. Artifact

Compound, per the verdict line: **PR** (lane-2 inventory — adopt), **memory note + future RFC seeds** (lane-4 patterns: staged typed side-effects, integrity lattice, unified allowlist), **cloud-roadmap entry** (lane-5: Tier 3 prompt seed + competitor validation), **skip** the Actions-specific plumbing (trigger-role gates, reactions, bot-trigger neutralization, lock-file compilation — host-bound).

## Notes

- Releases 0.68.4–0.71.3 were retired for a **billing-impacting bug** — a concrete datum that agentic CI carries real cost blast radius; relevant to our Agent CI budget design (their per-job `max-ai-credits` split between agent and detection is the mitigation shape).
- The three-layer trust writeup (substrate/configuration/plan, explicit threat model assuming a fully compromised agent container) is worth citing in our proof-of-enforcement docs.
- `integrity-reactions` (feature-flagged): 👍/❤️ from a sufficiently-trusted user *promotes* content integrity — human-in-the-loop trust promotion via native UI affordances.
- SSL bump option in AWF (URL-path-level filtering via MitM) — they ship it but warn loudly; default stays domain-level.
- `network.allowed-input: true` lets reusable-workflow callers union extra domains at runtime — extensibility without forking the lock file.
- Agent-first docs: README opens with an HTML comment addressed to agents; `llms.txt` / `llms-full.txt` published.
- Related intakes: `failproofai.md` (local-hook competitor), `sondera-coding-agent-hooks.md` (Cedar gate), `devin-cloud-verification.md` (anti-confabulation second witness — threat detection is a third witness for the "referee the agent's output before it lands" shape).

## Methodology notes (optional)

- The blog links `githubnext/gh-aw` but the canonical repo is `github/gh-aw`; the docs site content lives in-repo under `docs/src/content/docs/` — reading it there beats fetching the rendered site.
- Near-miss recorded: the first equivalence draft claimed we had no fetched-content injection scan; grep found `scanWebFetchInjection` shipped. Re-confirms `project_tdd_quality_checks_exist_real_gaps`: verify "X doesn't exist" by grep before writing it down.
