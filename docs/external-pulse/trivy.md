# Trivy

- **Source:** https://github.com/aquasecurity/trivy (Apache-2.0)
- **Encountered:** 2026-06-22, user-requested clone + intake
- **Verdict:** Compound — **PR** (inline secret corpus + keyword-gate; native IaC checks) · **cloud-roadmap entry** (offline/continuous vuln DB; always-on IaC gate) · **RFC/memory** (DB-as-OCI distribution; VEX as suppression format) · **skip** (importing any Trivy Go code)

## 1. Core idea (one sentence, your words)
A single deterministic Go binary that scans a target (filesystem, repo, container image, k8s cluster, SBOM) and reports five issue classes — known CVEs in OS/language dependencies, IaC misconfigurations, hardcoded secrets, disallowed licenses, plus an SBOM of what it found — by combining a periodically-refreshed offline vulnerability database, a regex+keyword secret engine, and an OPA/Rego policy engine.

## 2. Anatomy (concrete walkthrough)
Annotated map of `pkg/` (48 packages; `cmd/trivy/main.go` is a 1-line shim into `pkg/commands`):

```
pkg/
  fanal/secret/        secret engine — scanner.go (939L), builtin-rules.go (106 rules), builtin-allow-rules.go
  fanal/analyzer/      file-type analyzer registry; language/ has 15 SBOM extractors (go,java,nodejs,python,rust…)
  db/                  vuln-DB client (db.go) — pulls trivy-db as an OCI artifact, refreshes on a timer
  iac/rego/            misconfig engine — scanner.go calls rego.New().Eval() (OPA v1.17); policies embedded from
  iac/{providers,scanners}/  11 cloud providers × 8 file formats (terraform, cloudformation, helm, k8s, dockerfile, ansible…)
  vex/                 VEX consumers: openvex.go, csaf.go, cyclonedx.go — "this CVE doesn't apply" suppression
  rpc/{server,client}/ client/server mode: `trivy server` holds the DB, `--remote` clients send Twirp/protobuf scan RPCs
  sbom/                CycloneDX + SPDX emit/parse
  module/wasm/         WASM (wazero) plugin sandbox for custom analyzers
```

Load-bearing files I read:
- **`pkg/fanal/secret/scanner.go`** — the secret engine. The clever part is `scanChunk` (line 748): for each of 106 rules it first runs `MatchKeywords` (a cheap `bytes.Contains` of the lowercased content against the rule's keyword list) and **skips the expensive regex entirely** if no keyword hits. Then `FindLocations` → regex → per-rule + global `AllowRules` (path-regex + match-regex FP suppression) → `ExcludeBlock` (skip regions). Streams in 64KB chunks with 4KB overlap so boundary-spanning secrets aren't missed; censors matches to `*` in output. No entropy check.
- **`pkg/fanal/secret/builtin-rules.go`** — 106 rules across ~70 vendors. Each rule = `{ID, Category, Severity, Title, Regex (named `secret` submatch), Keywords, SecretGroupName, optional Path/AllowRules}`. e.g. `aws-secret-access-key` only runs its 40-char regex if the content contains the keyword `key`.
- **`pkg/fanal/secret/builtin-allow-rules.go`** — 13 path-based allow rules: skip `*test*`, `example`, `/vendor/`, `*.md`, `.dist-info/`, language stdlib dirs in container images. Pure FP suppression.
- **`pkg/db/db.go`** — vuln DB is a BoltDB file (`go.etcd.io/bbolt`, embedded KV) packaged as an **OCI artifact** (`application/vnd.aquasec.trivy.db.layer.v1.tar+gzip`), pulled from `ghcr.io/aquasecurity/trivy-db` (`mirror.gcr.io` fallback), schema-versioned by OCI tag, refreshed when `NextUpdate` passes (skip if downloaded < 1h ago). Air-gapped via `--skip-db-update` + a manually-placed DB.
- **`pkg/iac/rego/scanner.go`** — `runQuery` builds `rego.New(...)` and calls `.Eval(ctx)`. OPA Rego is a deterministic logic engine; the actual policy corpus is the separate `aquasecurity/trivy-checks` module (`go.mod`: `trivy-checks v1.12.2`), embedded at build.

End-to-end session: `trivy fs --scanners vuln,secret,misconfig,license myproject/` → fanal analyzers walk the tree and extract packages per ecosystem → vuln detector joins extracted packages against the local BoltDB → secret scanner runs the keyword-gated regex battery per file → Rego engine evaluates embedded policies against parsed IaC → license matcher checks SPDX against policy → one unified report (table/JSON/SARIF/CycloneDX), non-zero exit on findings above `--severity`.

## 3. Deterministic or agentic?
**Fully deterministic.** `grep -riE 'openai|anthropic|llm|genai|gpt-|mcp|inference|embedding'` over `pkg/ cmd/ internal/` returns nothing load-bearing. The five scanners: vuln = static BoltDB lookup; secret = keyword→regex→allow-rule; misconfig = OPA/Rego `.Eval()` (logic engine, no model); license = SPDX string matching; SBOM = package extraction. This is the rare mature security tool with **zero** LLM at the leaves — it clears the determinism filter outright, so the binding constraint becomes §6 (deps) and the per-edit compute budget, not model-in-the-loop. **License: Apache-2.0** — permissive, so code/data borrow is legally fine; the blocker is that it's Go (see §6).

## 3b. Role in its native architecture — and does it transfer?
At home Trivy is the **security boundary** (CI gate: exits non-zero on findings) and an **oracle** (the DB is authoritative truth about CVEs). Transplant:
- **As an `interlinked verify` subprocess** → it keeps the oracle/advisor role unchanged (we already treat gitleaks/semgrep/hadolint this way). Safe transplant.
- **As ported inline checks** (secret regexes, a few IaC rules) → the role *upgrades* to a **blocking boundary at PreToolUse**, intercepting a secret/misconfig **before it hits disk** — a role Trivy itself structurally cannot play (it scans the disk, post-hoc). This is the agent-era pre-disk frontier (`project_agent_era_checks`).
- **The DB-lookup oracle role** can only transfer to our **cloud tier** — hosting and refreshing an authoritative vuln DB is not a per-edit local job. Locally it must stay advisory (invoke-as-subprocess) or be the live OSV admission screen we already have.

## 4. Substrate vs. surface
- **Surface:** the `trivy` CLI, `trivy server`, the k8s operator, the GitHub Action.
- **Separable substrate:** (a) the **106-rule secret corpus + keyword-gate algorithm** — data + a tiny pre-filter, portable to TS; (b) the **vuln DB** (`trivy-db`, a *separate repo*, distributed as OCI); (c) the **Rego policy corpus** (`trivy-checks`, a *separate repo*); (d) the analyzer/SBOM-extraction framework (Go).
- Only **(a)** is borrowable into our TS CLI as code/data. (b)(c)(d) are invoke-as-subprocess or cloud-only.

## 5. Lane (1–6)
**Lane 2 (detection technique)** + **Lane 3 (substrate, but *invoke-as-subprocess*, not import)** as the primary CLI landings, with **Lane 4** (DB-as-OCI / VEX / client-server *patterns* → memory/RFC) and **Lane 5** (offline/continuous vuln + always-on IaC → cloud) carve-outs. Explicitly **not** lane-3-import: the engine is Go with heavy deps (OPA, aws-sdk, go-containerregistry, wazero, cyclonedx-go, spdx-tools) and cannot enter our TS, single-dep CLI.

## 6. Dependency & displacement
- **Deps:** Code-import = impossible (Go; the deps above are permanent + huge). **Data-borrow of the secret corpus = no dep** (regex + keyword strings transcribe to TS). **Invoke-as-subprocess = no dep** (optional binary on PATH — identical to our existing `gitleaks`/`semgrep`/`hadolint`/`actionlint` entries in `check-engine/tool-catalog.ts`). "No new dep" holds for every recommended slice.
- **Displacement:** secrets overlaps `gitleaks` (already invoked in `verify`) *and* our inline `containsSecrets` (9 patterns + entropy floor); vuln overlaps `registry-metadata.ts` OSV-at-admission; license overlaps `license-policy.ts`; IaC partially overlaps `hadolint`+`actionlint`. The **non-displaced** wins: (1) inline secret corpus 9→~106 + keyword-gate — *gitleaks can't block pre-disk; our inline path is the pre-disk gate*; (2) IaC breadth (Terraform/K8s/CloudFormation/Helm — total gap); (3) continuous/offline CVE scan of **installed** deps (we only screen at admission); (4) SBOM (absent).
- **Equivalence (capability → our equivalent → status):**

  | Trivy capability | Our equivalent | Status |
  |---|---|---|
  | Secret scan, inline/pre-disk | `containsSecrets` (9 regex + Shannon-entropy floor) | **shipped, narrow** |
  | Secret scan, project/git-history | `gitleaks` subprocess in `verify` | **shipped (optional)** |
  | CVE/advisory lookup | `registry-metadata.ts` live OSV query at admission | **shipped — no offline DB, no installed-dep scan** |
  | License policy | `license-policy.ts` SPDX allowlist (admission + per-edit) | **shipped** |
  | IaC misconfig | `hadolint` (Dockerfile) + `actionlint` (GH Actions) | **partial — no TF/K8s/CFN/Helm** |
  | SBOM (CycloneDX/SPDX) | — (lockfile-snapshot hash is a primitive cousin) | **absent** |
  | Whole-repo scan | `interlinked verify` + `recurrence-scanner.ts` | **shipped (per-edit + batch, not one-pass)** |
  | Daemon holds state, thin clients query | harness daemon + hooks (we hold index/rules; Trivy holds the DB) | **shipped** |

## 7. Smallest spike (≤1 day)
**Inline secret corpus expansion gated by a keyword pre-filter**, in `signatures-patterns-secrets.ts` + `quality-checks/secret-detection.ts`:
1. Add a `keywords: string[]` field to `SecretPattern`.
2. In `containsSecrets`, compute `content.toLowerCase()` once and **skip a pattern's `matchAll` unless one of its keywords is present** — pure perf, this is what lets the corpus grow ~10× without adding to the PreToolUse/PostToolUse budget (currently all 9 regexes run unconditionally on every content scan).
3. Port ~30–40 of Trivy's highest-value vendor rules (regex + keywords) from `builtin-rules.go` into `SECRET_PATTERNS`, **keeping our Shannon-entropy floor as the confirmer** (Trivy has no entropy check — ours is strictly additive) and adding Trivy's path allow-rules (skip `*test*`/`example`/`/vendor/`/`*.md`).
4. Ship ≥3 positive + ≥3 negative cases per added vendor (per `feedback_generalize_across_codebases` and our check-authoring convention).

Deterministic, local, zero new dep, license-clean (Apache-2.0 data). The combined FP stack becomes best-of-both: **keyword-gate (Trivy) → regex (Trivy corpus) → entropy floor (ours/narsil) → allow-rules (Trivy)**.

## 8. Phase relevance

| Surface (phase) | Slice that lands here | Spike | Horizon |
|-----------------|-----------------------|-------|---------|
| Free CLI (P1) | §7 secret corpus + keyword-gate + allow-rules (native); 3–5 marquee IaC inline checks (container-as-root, `privileged: true`, `hostNetwork`, `:latest` tag, no resource limits — deterministic, pre-disk blockable); optional `trivy` entry in `check-engine/tool-catalog.ts` for `verify` (offline vuln + IaC breadth + SBOM in one subprocess call) | §7 (~½ day) + tool-catalog wiring (~½ day) | now |
| Guardrails (P2–3) | always-on IaC misconfig + offline/continuous vuln gate as a sub-second cloud check — DB hosted server-side, daemon merges the verdict. This is **Trivy's own client/server split** (`trivy server` + `--remote`) mapped onto our cloud governor. Cloudflare primitive: a Worker fronting an R2-hosted DB mirror (or a cached AI-Gateway-style fetch); the BoltDB→OCI artifact maps to an R2 object pulled on a timer. | host a trivy-db mirror / port the join; daemon `mergeCloudVerdict` | next |
| Agent CI (P4–5) | full `trivy fs --scanners vuln,misconfig,secret,license` deep scan over the staged tree in the async deep-review fan-out; VEX-format suppression interop. Cloudflare primitive: run the `trivy` binary inside a **Cloudflare Sandbox** (VM-isolated) over the worktree. | run trivy in a Sandbox, parse SARIF | parked |

## 9. Artifact
**Compound** (a mature find is rarely all-or-nothing):
- **PR (now):** inline secret corpus + keyword-gate + path allow-rules (native, P1) — the marquee. Optionally the `trivy` tool-catalog entry for `verify`.
- **PR/RFC (next):** 3–5 native IaC inline checks (port the highest-value deterministic misconfig rules for **pre-disk** blocking — the role Trivy can't fill).
- **Cloud-roadmap entry:** offline/continuous vuln DB + always-on IaC, via the daemon-holds-DB client/server pattern Trivy validates → Guardrails.
- **Memory note:** DB-as-OCI-artifact distribution (model for our signed cloud rule-packs) + **VEX** as the standard machine-readable suppression format (our `baseline-integrity-gate` is conceptually a VEX-integrity gate; aligning the baseline shape with OpenVEX buys interop + provenance).
- **Skip:** importing any Trivy Go code.

## Notes
- **Keyword pre-gate is the transferable perf lesson.** Trivy runs 106 regexes but gates each behind a cheap `bytes.Contains` keyword check, so only a handful execute per file. This is exactly what keeps a large corpus on a latency-bound hook path — the mechanism we lack and the reason our corpus has stayed at 9.
- **Entropy is *our* edge, not theirs.** Trivy relies on keyword+regex+allow-rules; our narsil-borrowed Shannon-entropy floor (`SECRET_ENTROPY_FLOOR = 3.0`) separates filler/example keys from real ones without a path allowlist. Combining both is strictly better than either.
- **DB shape:** BoltDB (embedded KV) shipped as an OCI artifact, cosign-verifiable, timer-refreshed, air-gappable. The "ship signed data packs as OCI" pattern generalizes to our cloud rule/feed distribution (cf. the Ed25519-signed sponsor feed — same trust goal, different transport).
- **Misconfig = OPA/Rego**, corpus in the separate `trivy-checks` repo (11 providers × 8 formats). Heavy + Go — invoke-as-subprocess or port a handful of rules natively; do **not** try to embed OPA.
- **We already shell out external security tools** (`gitleaks`, `semgrep`, `hadolint`, `actionlint`) via `check-engine/tool-catalog.ts` — adding `trivy` is the same well-worn pattern, not new machinery, and stays optional (degrades gracefully when the binary is absent).
- **Sibling repos** (Aqua Security org; all uniformly deterministic, no LLM anywhere in the org). Verified stars | license | language:
  - **`trivy-mcp`** (43★, MIT, Go, created 2025-04) — an **MCP server that wraps the Trivy binary**. Aqua's entire "AI agent" story is "expose the deterministic scanner over MCP and let the agent call it" — a direct validation of our thesis (deterministic checks + agent integration), and the one sibling worth its own intake for us specifically.
  - **`trivy-checks`** (81★, MIT, Rego/OPA) — the misconfig corpus behind the IaC gap (§6). Invoke or port-a-few; do not embed OPA.
  - **`chain-bench`** (774★, Apache-2.0, Go+Rego) — CIS **Software Supply Chain** benchmark; deterministic, adjacent to our supply-chain allowlist. Worth a look for additional supply-chain checks.
  - **`trivy-db` / `trivy-java-db` / `vuln-list-*` / `trivy-db-data`** — the DB build/distribution pipeline + raw vuln-list data feeds (relevant only if we ever host an offline vuln DB).
  - **`vexhub` + `vex-repo-spec`** — Aqua's VEX infrastructure; confirms VEX is a real, invested-in standard to align our suppression/baseline shape with.
  - **`tracee` / `libbpfgo` / `btfhub` / `traceeshark`** (eBPF **runtime** security; `traceeshark` is GPL-2.0, the org's one copyleft outlier) and **`kube-bench` / `kube-hunter` / `trivy-operator` / `starboard`** (k8s posture/ops) — kernel- and cluster-level, outside a dev-edit-time CLI's scope. Cloud-runtime someday at most; otherwise skip.
  - `defsec` + `trivy-iac` are **archived** (folded into Trivy core 2025-01) — don't intake the corpses; the live code is in `pkg/iac/`.

## Methodology notes (optional)
- This is the first intake where **the determinism filter passes cleanly but the dependency filter is decisive** — a fully-deterministic find that still can't be imported because of *language + dep weight*, forcing the lane-3 → invoke-as-subprocess / data-borrow / cloud split. §6's "deps raise the bar, don't reroute" worked, but the *language mismatch* (Go vs TS) is a sharper gate than dep-count alone; worth a one-line mention in INTAKE.md §52 if it recurs.
