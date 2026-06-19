# Grype + Syft (Anchore)

- **Source:** https://github.com/anchore/grype · https://github.com/anchore/syft (DB pipeline: https://github.com/anchore/grype-db + https://github.com/anchore/vunnel)
- **Encountered:** 2026-06-13, user-supplied GitHub links ("adapt something from either or both")
- **Verdict:** Compound — **PR-able spike** (opt-in `interlinked cve` subcommand, invoke-as-subprocess, zero new dep) + **RFC/memory note** (swap the already-planned cloud `cdxgen + OSV/Snyk` SBOM/CVE step for `syft + grype`). **Reject** importing-as-library, bundling the DB, or putting the heavy scan on the per-edit hook path. **Keep** our typosquat + allowlist + license layers — Grype/Syft don't do those.

> One file for two projects (the rubric prefers one-per-project) because they are a matched producer→consumer pair from one vendor — Grype's primary input is a Syft SBOM — and our single equivalent (the `interlinked allowlist` supply-chain system) spans both. Splitting them would duplicate the equivalence table.

## 1. Core idea (one sentence, your words)

**Syft** walks a filesystem / container image and emits a package inventory (SBOM) by parsing lockfiles, *installed*-package databases, and compiled binaries; **Grype** takes that package list (or scans directly) and looks each `name@version` up in a downloaded, offline SQLite vulnerability database aggregated from ~14 distro and language feeds, emitting matched CVEs with severity and exploit-likelihood. Both are pure deterministic parsers/lookups — no model in the loop.

## 2. Anatomy (concrete walkthrough)

**Syft** (`syft <source> -o <format>`):
- Sources: container image (`alpine:latest`), directory (`./my-project`), archive.
- Catalogers span three kinds of evidence, which is the breadth that matters here:
  1. **Declared/lockfile** — `package-lock.json`/`yarn.lock`, `requirements.txt`/`poetry.lock`, `Cargo.lock`, `go.mod`, `pom.xml`, `Gemfile.lock`, etc.
  2. **Installed-state DBs** — Alpine `apk`, Debian `dpkg`, RPM. These describe what is *actually installed*, not just declared.
  3. **Compiled binaries** — Go binary build info, Rust, .NET, ELF. Finds dependencies with no manifest at all.
- Output: `spdx-json`, `cyclonedx-json`, `syft-json` (and conversions + signed in-toto attestations).
- Purely local file parsing; no network to *generate* an SBOM.

**Grype** (`grype <source>` or `grype sbom:./sbom.json` or `cat sbom.json | grype`):
- Input: a Syft SBOM (the tight-integration path), a container image, or a directory.
- DB: a SQLite file built by **grype-db** from **vunnel** ("vulnerability data funnel"), **published daily**, downloaded and cached locally; matching runs **offline** against the local copy (air-gap supported by hosting the DB internally and pointing Grype at the URL). Refresh-at-scan-start is default-on but defeatable.
- Matching: CPE matching + ecosystem-specific matchers doing version-range comparison (`name@version` vs affected ranges). Carries **EPSS** (exploit-prediction) + **CISA KEV** (known-exploited) + risk scoring for prioritization.
- Output: `table` (default), `json`, `cyclonedx`/`cyclonedx-json`, **`sarif`** (→ GitHub code scanning), `template`. `-o/--output`.
- CI gate: **`--fail-on <severity>`** (alias `-f`) sets the exit-code threshold (`--fail-on high` fails on high+critical); **`--only-fixed`** filters to vulns with an available fix.

**vunnel provider list (the data sources):** `alpine`, `amazon` (ALAS), `chainguard`, `debian`, `echo`, `github` (GHSA), `mariner`, `minimos`, `nvd` (NIST), `oracle` (ELSA), `rhel`, `sles`, `ubuntu`, `wolfi` — classified *Comprehensive* (disclosures + fixes) vs *Supplementary* (fixes layered over another source).

## 3. Deterministic or agentic?

**Fully deterministic, cleanly so** — and worth saying because the determinism filter is the dominant one and these *pass it without a CodeWiki/narsil-style hidden-LLM catch.* Syft = file parsing → inventory. Grype = SQLite lookup + semver-range compare. The only curation is upstream in vunnel (scrapers + human review of feeds), never an LLM in *our* path. **License: Apache-2.0** (both) — no block for invoke-as-subprocess or code-borrow.

## 3b. Role in its native architecture — and does it transfer?

Native role: an **oracle** (Syft answers "what packages are here?", Grype answers "which are vulnerable?") feeding a **CI gate** (`--fail-on`). That role transfers intact — it is deterministic and tighten-only, so it needs no sandbox backstop. The one constraint that *doesn't* transfer is latency: as a standing full-repo scan it is a seconds-class job, so the gate-role survives only off the per-edit hook path (CLI subcommand or cloud step), not as a sub-10ms PreToolUse blocker.

## 4. Substrate vs. surface

- **Substrate:** (a) multi-evidence package cataloging (Syft); (b) an offline, multi-source, daily vuln DB + version-range matcher with exploit prioritization (Grype). Both are borrowable **as subprocesses** without their CLIs' surface.
- **Surface:** the `syft`/`grype` CLIs + SBOM/SARIF artifacts. We'd keep our own surface (`interlinked cve`, `verify`) and shell out.

## 5. Lane (1–6)

**Lane 3 (substrate), compound with Lane 5 (cloud-only fodder).** It's a reusable capability invoked as a subprocess (Lane 3), but the *standing full-repo* scan is too heavy for the per-edit budget, so that slice routes to the cloud surface per the determinism filter's compute-budget rule (INTAKE §48) — Lane 5 by *budget*, not by *agenticness*.

## 6. Dependency & displacement

- **Deps:** **No new runtime dependency.** Both are standalone Go binaries — shell out exactly as the harness already does for `semgrep`, `gitleaks`, `cargo`, `rustfmt` (detect on PATH, degrade loudly if absent). Grype's DB is a runtime *data* artifact (hundreds of MB, cached/downloaded), not a code dep — a real cost, but only where Grype runs (cloud Sandbox or opt-in local), never bundled into the CLI.
- **Displacement (internal overlap):**
  - `three-product-architecture.md` already specs the cloud **"SBOM + license + CVE graph"** step as `npx @cyclonedx/cdxgen -o sbom.json` + **"Snyk / OSV in Sandbox."** `syft + grype` is a near-drop-in, Apache-2.0, offline-capable alternative for that exact step (Grype vs Snyk = cost win; Grype vs raw OSV = offline + multi-distro-source + EPSS/KEV + `--fail-on` + SARIF). **A/B it; not an automatic swap** — cdxgen is Node-native and may bundle more cleanly into a JS Sandbox.
  - `supermodel-port-groundwork.md` calls the `project-graph.ts` local/external split a "near-free code-derived SBOM win" — that's a *module-level* graph, not a *package-level* SBOM; Syft fills the package layer it can't.
  - `agt-cloud-tier-adoptions.md` ASI04: we claim supply-chain coverage via `interlinked allowlist` + typosquat but concede **"no SBOM."** Syft closes that gap honestly.
- **Equivalence (capability-by-capability):**

  | Capability | Grype/Syft | Our equivalent | Status |
  |---|---|---|---|
  | Declared-dep parsing (package.json, requirements.txt, Cargo.toml, go.mod…) | Syft lockfile catalogers | `package-install-parser.ts` + `manifest-edit-guard` | **shipped** (narrower: declared-only, edit-time diff) |
  | Installed-state cataloging (dpkg/apk/rpm) + transitive | Syft installed-DB catalogers | — | **absent** |
  | Compiled-binary cataloging (Go buildinfo, Rust, ELF) | Syft binary catalogers | — | **absent** |
  | Container-image SBOM | Syft image source | — | **absent** (CLI is repo-scoped) |
  | SBOM artifact (SPDX / CycloneDX) | `syft -o spdx-json` | — | **absent** (`project-graph.ts` = partial module graph, not package SBOM) |
  | Vuln matching (name+version → advisory) | Grype + grype-db | `registry-metadata.ts::queryOsvAdvisories` | **shipped** (narrower: live OSV single API, admission-time only, fails open, not in CI/hook path) |
  | Offline multi-source vuln DB (14 feeds) | grype-db SQLite, daily, air-gappable | — | **absent** (online-only, single-source OSV) |
  | Exploit prioritization (EPSS / CISA KEV) | Grype risk scoring | — | **absent** |
  | CVE-severity CI gate | `grype --fail-on high` | `allowlist verify` (non-zero on *unapproved dep* — approval axis, not CVE) | **shipped, different axis** |
  | SARIF → GitHub code scanning | `grype -o sarif` | — | **absent** |
  | License-policy allowlist (SPDX) | (Syft surfaces declared license; not a policy engine) | `license-policy.ts` + `registry-metadata` license fetch | **shipped — ours is richer** |
  | Typosquat detection | — (neither tool does this) | `supply-chain.ts::findTyposquatMatch` | **shipped — ours only, complementary** |

  Read this table top-to-bottom: we own the *declared-dep + single-source-OSV + typosquat + license* slice; Grype/Syft add *SBOM breadth (installed/binary/container) + an offline multi-source DB + exploit prioritization*, and lack our typosquat/license layers. **Complementary, not a rebuild.**

## 7. Smallest spike (≤1 day)

`interlinked cve [path]` — a new opt-in, human-invoked subcommand (NOT the hook path):
1. Detect `syft`/`grype` on PATH using the existing optional-tool pattern (`check-engine/tool-runners/` — same as semgrep/gitleaks).
2. `syft <path> -o syft-json` piped to `grype --output json --fail-on high --only-fixed`.
3. Parse Grype JSON into our finding shape; map severity → exit code.
4. Degrade loudly if either binary is absent ("syft/grype not installed — CVE scan skipped"), exactly like the optional checks.

One subcommand, one tool-runner, invoke-as-subprocess, zero new deps. Bigger-than-spike (→ RFC): replacing the admission-time OSV call in `allowlist add` with an offline Grype-DB lookup, and the cloud `cdxgen+OSV` swap.

## 8. Phase relevance

| Surface (phase) | Slice that lands here | Spike | Horizon |
|---|---|---|---|
| Free CLI (P1) | Opt-in `interlinked cve` subcommand (§7); later, offline Grype-DB replaces the live single-source OSV call in `allowlist add` (network → offline multi-source) and adds a `--fail-on`-style CVE-severity gate to `allowlist verify`. | the §7 subcommand | **next** |
| Guardrails (P2–3) | With a *resident* pre-warmed Grype DB, block a manifest-edit/install that introduces a package carrying a **KEV / critical** CVE — deterministic, but only viable if the DB is memory-resident; vuln-match isn't a natural sub-second blocker. | DB-resident lookup behind `manifest-edit-guard` | **parked** |
| Agent CI (P4–5) | Replace/augment the already-designed `cdxgen + OSV/Snyk` SBOM+CVE Sandbox step (`three-product-architecture.md` §Check inventory) with `syft + grype`: Apache-2.0, offline SQLite DB over 14 feeds, EPSS/KEV prioritization, SARIF→GitHub code scanning, `--fail-on` gate, SBOM→R2. | A/B `syft+grype` vs `cdxgen+OSV` in a Sandbox | **next** |

## 9. Artifact

**Compound:**
- **PR** — the `interlinked cve` invoke-as-subprocess subcommand (§7). Ships in the Free CLI, adds no dep, genuinely ≤1 day.
- **RFC / doc-update** — fold the `syft+grype`-vs-`cdxgen+OSV/Snyk` A/B into `three-product-architecture.md`'s SBOM/CVE step rather than a from-scratch RFC; note the EPSS/KEV + offline-DB + SARIF advantages and the cdxgen Node-bundling counter-point.
- **Carve-out:** ADOPT invoke-as-subprocess SBOM+CVE (CLI subcommand + cloud step). REJECT import-as-library, DB-bundling, and per-edit-hook placement. KEEP typosquat + allowlist + license (Grype/Syft lack them).

## Notes

- **The clean differentiators over our current OSV path:** (1) *offline* multi-source DB vs a live single-API call that fails open; (2) **EPSS/KEV exploit prioritization** — lets a gate fire on "known-exploited," not raw CVSS, which is the single biggest CVE-noise reducer we don't have; (3) `--fail-on` exit-code gate + SARIF for native GitHub code-scanning integration.
- **Determinism caveat that *passes*:** unlike CodeWiki/narsil intakes, reading past the marketing confirms no hidden LLM — Syft is parsers, Grype is a SQLite lookup. The catch is the *compute-budget* second gate (INTAKE §44–48), not agenticness: that's what routes the standing scan to cloud / CLI-subcommand and off the hook path.
- **Open question for the A/B:** Syft's edge over cdxgen is installed-state + binary + container cataloging; for a *source repo* (our usual target, not a built image) that edge is smaller — cdxgen + lockfiles may already cover the declared graph. The decisive factor is likely Grype (offline DB + EPSS/KEV + Apache-2.0) more than Syft-vs-cdxgen.
- Related intakes: `agent-governance-toolkit.md` (ASI04 framing), `narsil-mcp.md` (the compute-budget filter this surfaced).
