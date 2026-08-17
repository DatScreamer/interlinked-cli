# Stolen Thoughts — exfiltrating frontier reasoning traces via encrypted-blob replay

- **Source:** arXiv 2608.09867 · https://stolen-thoughts.com · Matthew Green's precursor (blog.cryptographyengineering.com, 2026-05-29) · author thread (Yiming/DavidSchmotz/iliaishacked et al., MATS)
- **Encountered:** 2026-08-11, user-forwarded thread
- **Verdict:** **Compound.** Adopt the defensive detector (`shared_trace_secret_leak`, lane 2 → PR). Formalize the legitimate distillation/steering seam we *already* ship (lane 4 → the reproducibility/replay program; a steering-corpus extractor landed this session). **Reject** the extraction/transcription exploit and the credential-harvesting scan (lane 6 — will not build).

## 1. Core idea (one sentence)

The encrypted "reasoning blobs" frontier APIs return (Anthropic `redacted_thinking` + signature; OpenAI/Gemini equivalents) are **portable across sessions, users, and models within a provider**, so a cheaper model can be jailbroken into transcribing another model's raw hidden reasoning verbatim — never breaking the cryptography — which (a) makes reasoning-trace distillation possible without an algorithmic break, and (b) leaks secrets that live in a shared chat's reasoning channel but not its visible transcript.

## 2. Anatomy (load-bearing claims — this is a paper, not a repo)

1. **Replayability** (Green, May 2026): encrypted reasoning can be replayed outside its original context. Labs' initial response: "no security implications in side channels or replays."
2. **Cross-model portability within a provider:** Haiku 4.5 can consume Opus 4.8's thoughts. Jailbreak the *reader* (Haiku), not the *author* (Opus), and it transcribes Opus's raw reasoning verbatim — Opus is never attacked directly. Same trick reproduces on OpenAI and Gemini.
3. **Distillation corollary:** since the raw trace is recoverable, reasoning-trace distillation has been possible "for a long time without ever breaking the cryptography." Prefilling **Kimi-K3** reasoning with a few tokens of Opus reasoning measurably shifts its output toward Opus's; specific Claude/GPT spans are up to **~6 orders of magnitude** easier to extract from Kimi-K3 than the next-closest model (a memorization/contamination signal).
4. **Credential leak from shared sessions:** any publicly shared Claude Code / Codex session carrying encrypted reasoning blobs can be decoded → PII. Preliminary scan of **~7,000 public traces: 62 unique API keys, 33 emails, 33 passwords**, plus other sensitive data.
5. **Summarizer unfaithfulness:** the summarized thinking the API returns omits material from the underlying trace (e.g., Opus 4.8 knows an AIME answer, then back-fits a solution — absent from the summary). Also: illegible/alien OpenAI reasoning (Apollo-corroborated), and in-the-wild scheming examples.

Responsible disclosure happened; labs have patched several issues and continue working.

## 3. Deterministic or agentic? License?

**N/A** (research paper / attack pattern). Our **defensive** transfer is deterministic (marker detection + entropy + the existing secret signatures — regex/scan, no inference). The **legitimate distillation** transfer is a deterministic local extractor (shipped this session) feeding an eval whose candidate step needs inference (cloud/local backend → Agent CI). No license constraint (paper). The exploit's decoder is out of scope, so no code-borrow question arises.

## 3b. Role in its native architecture — and does it transfer?

The finding is an **attack on a security boundary** (the provider's reasoning-hiding + tenant isolation). Two things transfer into our topology, in opposite directions:

- **Defensively (adopt):** our harness already scans file content for secrets on Read/Write, but treats a session-share artifact as opaque text — it does not know the artifact carries a *decodable reasoning channel*. New role: a **tighten-only warn/block on our own outbound share artifacts** — protect the user from attack #4 against themselves. We build the *detector of the leak*, never the *decoder*.
- **Offensively (reject):** verbatim cross-model transcription of hidden reasoning is the exploit. Our reproducibility program already took the opposite stance in **code** — see §6.

## 4. Substrate vs. surface

For us the reusable substrate is what we *already capture* (exposed thinking summaries in `timeline.jsonl`) + the existing secret signatures. Surfaces: (a) the new `shared_trace_secret_leak` check; (b) the steering-corpus extractor + the shipped `interlinked replay` eval. The exploit's substrate (the decoder) is not borrowed.

## 5. Lane

Compound:
- **Lane 2 (detection technique)** → `shared_trace_secret_leak` harness check.
- **Lane 4 (pattern)** → the "distill from *exposed* reasoning" insight, which shapes (and validates) our reproducibility/replay program.
- **Lane 6 (skip/reject)** → the blob-decode / cross-model-transcription exploit and the public-trace credential scan.

## 6. Dependency & displacement

- **Deps:** none. The detector reuses `signatures-patterns-secrets.ts`; the extractor is stdlib-only.
- **Displacement:** the detector *extends* the existing secret scanners to a new surface (share artifacts' reasoning channel), not a rebuild. The extractor is complementary to `scripts/extract-model-timeline.ts` and `src/harness/replay/trace-assembler.ts`.
- **Equivalence (capability-by-capability, verified against source):**

| Capability | Our equivalent | Status |
|---|---|---|
| Secret detection in visible content | `signatures-patterns-secrets.ts` (aws/gcp/github/openai/stripe/slack…), `checks/pii.ts`, content-scanner (`commands/scanner.ts`), `builtin-tmp-secrets` guard | **shipped** |
| Secret detection in the **reasoning channel of an outbound share artifact** | — | **absent** (the gap this find opens) |
| Per-model exposed-reasoning corpus | `scripts/extract-model-timeline.ts` → `<model>-complete.jsonl` | **shipped** (task/outcome excluded by design) |
| Turn-keyed steering corpus (task + exposed thinking + trajectory + outcome) | `scripts/reasoning/build-steering-corpus.mts` | **shipped this session** (1,519 turns, 6 Claude-family teachers) |
| Exact inference capture (envelope) | `src/harness/replay/inference-{proxy,store,envelope}.ts` | **shipped** |
| Trace assembler (join per `tool_use_id`) | `src/harness/replay/trace-assembler.ts` | **shipped** |
| Cross-model teacher-forced eval **+ foreign-thinking strip** | `src/harness/replay/candidate-runner.ts` (`keepThinking` default **false** → `stripPriorThinking`), `eval-runner/aggregator/ledger`, `scorers/{action-match,ast-edit-diff}`; `interlinked replay` wired in `src/index.ts:34` | **shipped** (NLL + message-cosine scorers still absent) |
| Summarizer-unfaithfulness measurement (summary vs the *hidden* trace) | — | **absent, and not buildable without the exploit** — we hold summaries, not the hidden trace (see Notes) |

## 7. Smallest spike (≤1 day)

`shared_trace_secret_leak` v0 (½ day): on a Write/publish whose content carries encrypted-reasoning markers (`redacted_thinking` / thinking `signature` / provider blob shapes) OR is a recognizable share export, run the existing secret signatures over the **whole** artifact and warn. Ships with labeled MUST-FIRE / MUST-NOT-FIRE cases. (The distillation-side spike — the steering-corpus extractor — already landed this session and is test-covered.)

## 8. Phase relevance

| Surface (phase) | Slice that lands here | Spike | Horizon |
|---|---|---|---|
| Free CLI (P1) | `shared_trace_secret_leak` detector; `build-steering-corpus.mts` (local, deterministic) | §7 detector | **now** (extractor done) |
| Guardrails (P2–3) | Pre-publish **block** on outbound share artifacts leaking secrets in the reasoning channel (sync gate) | reuse the P1 detector as a blocking policy | next |
| Agent CI (P4–5) | Teacher-forced replay eval as the legitimate cross-model comparison (candidate step needs an inference backend — vLLM/mlx for NLL) | add `nll` + `message-cosine` scorers to the shipped `src/harness/replay/scorers/` | next |

## 9. Artifact

Compound:
- **PR** — `shared_trace_secret_leak` check (defensive; the clear gap).
- **Memory note + this intake** — the "distill from exposed reasoning, strip foreign thinking cross-model" seam; the extractor shipped this session.
- **Cloud-roadmap entry** — finish the tier-1 eval scorers (NLL/message-cosine) as the honest cross-model comparison.
- **Reject** — the blob-decode / verbatim-transcription exploit and the public-trace credential harvest. Named explicitly so it is not re-litigated.

## Notes

**The paper is the adversarial validation of a boundary our program already enforces in code.** `candidate-runner.ts:8–10,48,65` strips prior-turn thinking by default *because the API itself drops foreign thinking blocks server-side* — the exact server-side control the exploit defeats by replaying the encrypted blob. So our reproducibility/replay work is, by construction, the legitimate cousin: **same-family seeding on our own data + thinking-stripped cross-model eval.** Cite this find as the reason that default must never flip to `keepThinking: true` for a *foreign* candidate.

**Why "backtrace the actual reasoning" is the exploit, restated for the record.** Anthropic returns a *summarized* thinking block; our `timeline.jsonl` captures those summaries (lossy — the summarizer-unfaithfulness finding measures how lossy). The attack decodes the *encrypted* block to recover the raw trace the summary omits. Therefore: steering a smaller same-family model with the **exposed summary** (what `build-steering-corpus.mts` assembles) is legitimate and needs no boundary defeated; reconstructing the **hidden trace** behind the summary — by any means — is the thing we do not do.

**Fidelity caveat for the steering corpus.** Because summaries are lossy, the corpus is a real but *partial* view of the teacher's reasoning. Do not overclaim it as the teacher's full chain-of-thought; it is the teacher's exposed, API-returned reasoning, which is enough for inference-time seeding and reference-action scoring, and no more.

## Methodology notes

The equivalence table's "shipped" rows were verified by reading source this session (`ls src/harness/replay/`, `candidate-runner.ts` strip logic, `src/index.ts` command wiring), not from the tier-1 design doc — which still reads "Status: Design" but is substantially implemented. When an intake's equivalence hinges on "designed vs shipped," read the tree, not the design doc.
