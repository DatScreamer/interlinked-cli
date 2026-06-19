# anomalib

- **Source:** https://github.com/open-edge-platform/anomalib (cloned `--depth 1` to `/tmp/anomalib-intake`, Apache-2.0, HEAD `b737e7f`, README announces v2.5.0; author "Intel OpenVINO"; ICIP-2022 paper)
- **Encountered:** 2026-06-17, direct pointer for adoption evaluation
- **Verdict:** memory note + RFC-when-scheduled. **Compound:** adopt the *one-class anomaly-detection methodology* as the reference architecture for cloud-side **trajectory anomaly detection** ([[project_agent_era_checks]]); reject the code/substrate outright (vision-specific, torch/lightning ecosystem — fails the CLI's determinism *and* one-dep filters). Not a PR (nothing ships to the CLI), not a skip (the pattern is load-bearing for a named roadmap moat).

## 1. Core idea (one sentence, your words)

A PyTorch/Lightning library of ~35 deep-learning **visual** anomaly detectors that all share one recipe — learn a model of "normal" from normal-only images, score each test image/pixel by how far it deviates, pick a threshold, flag outliers — plus the train/benchmark/export plumbing (Engine, datamodules, metrics, OpenVINO export) around them.

It is **industrial defect detection** (MVTec-AD-style): the input is *images and video*, never code or agent traces.

## 2. Anatomy (concrete walkthrough)

Directory map (`src/anomalib/`):

```
models/image/{patchcore,padim,fastflow,efficient_ad,draem,stfpm,reverse_distillation,
              winclip,dinomaly,anomalyvfm,vlm_ad,glass,...}   ~33 image models
models/video/{ai_vad,fuvas}                                   2 video models
models/components/{feature_extractors,sampling,flow,stats,...} shared neural blocks
engine/engine.py            960 lines — thin wrapper over a Lightning Trainer (fit/test/predict/export)
metrics/{auroc,aupr,aupro,pimo,f1_score,min_max,threshold/}   deterministic eval + threshold selection
post_processing/one_class.py  normalize → adaptive-threshold → sensitivity
pre_processing/             transforms + tiling
data/{datamodules,datasets} MVTecAD etc. (train split = normal-only; test = normal + anomalous)
deploy/                     Torch / OpenVINO / ONNX inferencers
cli/cli.py                  `anomalib` entry (pyproject `anomalib = anomalib.cli.cli:main`)
```

Load-bearing path, traced through **PatchCore** (the canonical "memory-bank" model, `models/image/patchcore/torch_model.py`):

1. **Feature extraction — NEURAL, irreducible.** `TimmFeatureExtractor(backbone="wide_resnet50_2", pre_trained=True, layers=["layer2","layer3"])` (`torch_model.py:122`). A frozen pretrained CNN. Run under `torch.no_grad()`.
2. **Embedding (deterministic given features).** Concatenate multi-scale maps, avg-pool, reshape to per-patch vectors (`generate_embedding`/`reshape_embedding`).
3. **Memory bank (deterministic, classical).** `KCenterGreedy` coreset subsampling keeps a representative subset of *normal* patch embeddings (`torch_model.py:283`, `components/sampling/k_center_greedy.py`).
4. **Scoring (deterministic given features).** Brute-force nearest-neighbor Euclidean distance to the memory bank + a softmax-weighted image score (`nearest_neighbors`/`compute_anomaly_score`, `torch_model.py:321-442`). Anomaly map = upsampled patch scores.
5. **Threshold (deterministic given scores).** `F1AdaptiveThreshold.compute()` sweeps the precision-recall curve and returns `thresholds[argmax(f1_score)]` (`metrics/threshold/f1_adaptive_threshold.py:210-216`).
6. **Normalize + flag (deterministic).** Min-max centered on threshold: `((preds - threshold) / (max - min)) + 0.5`, clamped to `[0,1]`; sensitivity = `1.0 - sensitivity`; flag = `preds > threshold` (`post_processing/one_class.py:315,349,291`).

What the user invokes: `anomalib train --model Patchcore --data anomalib.data.MVTecAD` (or the `Engine().fit(...)` Python API). There is no agent; the "consumer" is a human/CI training and exporting a detector for a vision pipeline.

**Read-the-source payoff (the marketing-vs-reality beat):** PatchCore's docstring says it "requires no optimization/backpropagation" (`torch_model.py:95`). A skim could mistake it for a classical, borrowable method (memory bank + kNN — sounds deterministic). The source shows the opposite: *every bit of signal* comes from the frozen pretrained deep net in step 1. **"No training" ≠ "no model."** The flow-based (FastFlow/CFlow, via `freia`), student-teacher (STFPM/EfficientAD), reconstruction (DRAEM/GANomaly), and foundation-model/zero-shot (WinCLIP/AnomalyVFM/Dinomaly/`vlm_ad`) families are *more* model-dependent, not less.

## 3. Deterministic or agentic?

**Hybrid, but the load-bearing component is irreducibly neural.** Detection signal = a pretrained CNN/ViT (or CLIP/VLM) feature extractor. The entire tail — coreset, kNN, F1-adaptive threshold, min-max normalization, AUROC/AUPRO metrics — is deterministic but operates *on neural embeddings* and is worthless without them. By the INTAKE determinism filter, value depends on model inference ⇒ auto-routes to lane 5 (cloud), not the CLI. (Note: it's not "LLM-as-judge" agentic — it's classical deep learning — but it is just as off-limits for a deterministic, sub-second, zero-model CLI harness.)

Nuance worth keeping: the **model** is one-class (trained on normal-only) but the **threshold** wants a few labeled anomalies — `F1AdaptiveThreshold` logs a warning and degrades if the validation set has no anomalous samples (`f1_adaptive_threshold.py:173-185`). So it's unsupervised-model + lightly-supervised-cutoff.

**License: Apache-2.0** (permissive — code-borrow would be *legally* fine; it's the deps + determinism that block it, not the license).

## 3b. Role in its native architecture — and does it transfer?

Native role: the anomaly detector **is the oracle / decision boundary** on a manufacturing line — it decides pass/fail. The "model normal, flag deviation" oracle role transfers *conceptually* to "model normal agent behavior, flag anomalous trajectory." But in interlinked's topology that role must downgrade: a learned anomaly score can only ever carry the `[heuristic]` determinism tag (it didn't *run* the code), and per [[feedback_harness_deterministic_only]] it cannot block. So **native role = boundary/oracle; transplanted role = advisory escalation signal only** — async, cloud-tier, never a per-edit sync gate.

## 4. Substrate vs. surface

- **Surface:** train/benchmark/deploy a *vision* anomaly detector. Zero overlap with interlinked — there is nothing image-shaped in the harness to point it at.
- **Substrate:** the reusable capability is the *methodology* (one-class modeling + score→normalize→threshold→flag), not the code. The code substrate (timm feature extraction, `freia` normalizing flows, coreset, OpenVINO export) is all vision/torch-bound and not separable into anything interlinked could use. Even **invoke-as-subprocess is N/A**: anomalib eats images; interlinked has no images to feed it (contrast grype/syft, which interlinked *can* shell out to — [[grype-syft]]).

## 5. Lane (1–6)

**Primary: Lane 4 (pattern / architecture).** The one-class anomaly-detection recipe is the reference design for interlinked's named trajectory/cross-session moat.
**Secondary: Lane 5 (cloud-only fodder).** If/when interlinked builds ML-backed trajectory anomaly detection, that capability is inherently cloud (needs embeddings/inference + a training corpus + central state) → Agent CI.
**Explicit rejections:** Lane 2/3 — no deterministic detection technique or CLI substrate transfers (vision-specific, torch-heavy). Lane 6 (skip) is wrong because the pattern attaches to a real roadmap item, not idle curiosity.

## 6. Dependency & displacement

- **Deps:** importing anomalib pulls the *entire* `torch>=2.6` / `torchvision` / `lightning` / `timm` / `torchmetrics` / `freia` / `kornia` / `opencv` / `scikit-learn` / `pandas` / `matplotlib` stack (core deps, `pyproject.toml:31-58`) — categorically incompatible with the CLI's one-runtime-dep (`commander`) stance. Subprocess-instead-of-import doesn't rescue it (§4: nothing to feed it). **"No new dep" is unwinnable here.**
- **Displacement:** nearest interlinked analogues are `error-history.ts` (pattern memory + optional embeddings), `pattern-detector.ts`, `recurrence.ts` (repeating-pattern aggregation), `suggestion-scorer.ts` (weighted finding scoring). All deterministic counting/regex — none is a learned anomaly model, so there's no real overlap to displace.
- **Equivalence (capability-by-capability):**
  - One-class / OOD detection over a behavior corpus → **absent** (the trajectory-anomaly moat in [[project_agent_era_checks]] is named but unbuilt). *This is the only genuinely missing capability — and it's exactly anomalib's lane.*
  - Score normalization + threshold selection → **shipped** but different mechanism: interlinked's cutoffs are policy constants/ratchets/high-water marks (line cap, complexity cap, `coverage-baseline.json`), *chosen* not *learned-from-a-labeled-score-distribution*. anomalib's F1-adaptive threshold is liftable as ~15 lines of pure tensor math, but interlinked has no labeled normal/anomalous score distribution per check to feed it, so it's a non-fit, not a borrow.
  - Repeating-pattern aggregation → `recurrence.ts` **shipped**; finding scoring/ranking → `suggestion-scorer.ts` **shipped**.
  - (Tangential) known-bad version / advisory pinning — see Notes — interlinked's OSV admission screen already **ships** the automated form of anomalib's hand-maintained pins.

## 7. Smallest spike

**Offline corpus probe — does the anomaly signal even exist? (≤1 day, research-only, touches nothing in the harness pipeline.)**

Take a slice of the existing `activity.jsonl`, featurize each session as tool-call n-grams / action-type histograms, fit a trivial one-class model over the "normal" sessions (frequency baseline, or a PatchCore-shaped kNN-distance-to-normal-centroid), and check whether known-weird sessions score as outliers — using `recurrence.ts` `harness_caught` rows and the probe-dominated reconciliation runs ([[project_echo_reconciliation_corpus_probe_dominated]]) as the *labeled anomalies* that calibrate the cutoff (mirrors anomalib's "threshold wants a few labels", §3). Pure offline analysis on data we already collect ([[project_activity_log_storage_direction]]: a full-fidelity per-occurrence ML corpus is deliberately retained) — **no new CLI dep, no cloud infra, no edit to the deterministic check path.** If the signal isn't there, the moat is moot; if it is, that's the evidence the RFC needs.

## 8. Phase relevance

| Surface (phase) | Slice that lands here | Spike | Horizon |
|-----------------|-----------------------|-------|---------|
| Free CLI (P1) | **Nothing.** Fails determinism (neural core) + one-dep (torch stack) filters; can't even subprocess (no image input). | — | n/a |
| Guardrails (P2–3) | **Nothing.** Sub-second sync gate; anomaly scoring needs a corpus + inference and is post-hoc, not per-edit. | — | parked |
| Agent CI (P4–5) | The home. Async, cloud-side **trajectory anomaly detection** over `activity.jsonl`: model normal sessions, flag anomalous ones for review — advisory escalation, never a block (§3b). | §7 offline probe → RFC | next (gated on the trajectory-corpus moat being scheduled) |

## 9. Artifact

**Memory note now + RFC when the cloud trajectory-anomaly feature is scheduled.** Compound, per §5: *adopt* the one-class methodology (model-normal → score-deviation → adaptive-threshold → flag, with a few labeled anomalies for the cutoff) as the reference architecture for the Agent-CI trajectory-anomaly moat; *reject* the anomalib codebase/substrate entirely for both CLI and cloud (vision-specific, torch-bound — we'd re-derive the recipe over our own feature space, not import it). The RFC is the §7 probe's output if the signal is real.

(No separate memory file written: this committed intake is the durable record, and `MEMORY.md` is already over its size budget — adding an index line would worsen that. Re-evaluate if recall proves it's needed.)

## Notes

- **Supply-chain side-finding (from reading the manifest, not the README).** anomalib pins *against* known-bad releases: `lightning>=2.6,!=2.6.2,!=2.6.3  # Malicious supply chain attack (Shai-Hulud)` and `torch>=2.6.0  # Critical CVE-2025-32434 (torch.load weights_only=True RCE)` (`pyproject.toml:39,111`). This is a real-world instance of exactly the two threat classes interlinked's supply-chain allowlist exists for — a compromised published version, and model-deserialization RCE. interlinked's OSV advisory screen at `allowlist add` (CLAUDE.md §supply-chain) is the *automated* form of these hand-maintained pins — a clean "we already ship the general capability" data point, not new work. A tiny possible lane-2 follow-up: confirm the allowlist supports **version-level** deny (not just per-name), since these are version-specific bans; if not, that's a low-FP add. (Verify against `package-allowlist.ts` before acting — don't take this note as fact.)
- **Why this find matters despite landing nowhere in the CLI.** It's the clearest external reference implementation of the methodology behind [[project_agent_era_checks]]'s "watch the agent, not the file" frontier, and the complement to [[reference_echo_free_supervision]]: ECHO *predicts* the environment's response to an action; anomaly detection *models the distribution* of normal actions and flags out-of-distribution ones. Same corpus ([[project_activity_log_storage_direction]]), opposite question. Sibling intake: `echo-rl.md`.
- Breadth confirms the determinism verdict: zero-shot/foundation-model entries (`winclip` via `open-clip-torch`, `anomalyvfm`, `anomaly_dino`, `vlm_ad` via `ollama`/`openai`/`transformers`) make later models *more* inference-bound, not less — there is no "classical" escape hatch in the model zoo.
