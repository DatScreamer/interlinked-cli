# OPF Viterbi calibration presets

Each file contains exactly one operating point (`operating_points.default.biases`)
with the six `VITERBI_BIAS_KEYS` from `opf/_core/decoding.py`. OPF's schema
validator rejects unknown keys at the artifact root, so no comment fields are
allowed in the JSON itself.

| Preset | Posture | When to use |
|---|---|---|
| `default.json` | All biases zero | Baseline; matches OPF's behavior with no calibration |
| `high_precision.json` | `background_to_start: -3.0`, `background_stay: +2.0`, `inside_to_end: +1.0`, `end_to_background: +1.0`, `end_to_start: -1.5` | Demos and noisy environments where over-redaction breaks workflows. Penalizes span entry on weak evidence; lets through more PII in exchange for fewer false positives on file paths, identifier-like strings, etc. |

## How biases shape decoding

OPF emits per-token logits over 33 BIOES classes; the Viterbi decoder picks the
highest-scoring complete *path* through those logits. The 6 biases additively
nudge transition scores without touching the underlying logits:

- `background_stay` (`O→O`) — push up to reward staying out of PII
- `background_to_start` (`O→B-/S-`) — push down to discourage entering spans
- `inside_to_continue` (`B-/I-→I-` same label) — push up to extend spans
- `inside_to_end` (`B-/I-→E-` same label) — push up to terminate spans early
- `end_to_background` (`E-/S-→O`) — push up to favor returning to background
- `end_to_start` (`E-/S-→B-/S-` new label) — push down to discourage adjacent spans

To use a preset, set
`content_scanner.local.viterbi_calibration_path` in `.interlinked/guard-rules.local.json`
to the absolute path of the chosen file.
