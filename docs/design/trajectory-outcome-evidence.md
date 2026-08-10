# Trajectory rules: outcome evidence, and where rules come from

Status: step 2 (join) LANDED 2026-08-10 — `src/harness/trajectory/outcomes.ts`,
14 labeled cases. Step 3 (promotion) is next. Steps 1 (corpus mining) and 4
(cross-session) are deferred on purpose; see *Why mining is not first*.

## The stance

**Reasoning proposes the gate. Data only proves it does not misfire.**

A trajectory rule says something about how agent work goes wrong — thrash,
blind edits, repair loops, unverified streaks. That claim comes from thinking
about the failure mode, not from mining logs. The logs here are one agent, on
one hardened, single-language, agent-written codebase: a biased sample in both
directions. CLAUDE.md already states the consequence — *fire rate measures the
AGENT, not the check* — so a rule that is quiet here has not been refuted.

What the data CAN do is narrow and negative: show that a proposed rule, when it
does fire on real work, is followed by real trouble often enough to be worth an
agent's attention. That is what this module measures.

## The asymmetry (why promotion only)

`joinRuleOutcomes` can return `promote`, `hold`, `insufficient`, or
`no_evidence`. It can never return `demote`, and no shipped rule loses its tier
because of a number here.

- `no_evidence` — the rule never fired. Silence is not evidence against it.
- `insufficient` — too few firings for precision to mean anything.
- `hold` — fired enough, but did not beat the base rate HERE. Still not a
  demotion: this repo may simply be a population the rule does not apply to.
- `promote` — cleared both bars, so the rule has earned a louder tier.

## The five labels (failure modes, not mined patterns)

| Label | Meaning | Why it is a failure |
|---|---|---|
| `blocked` | a later call was refused by a gate | the sequence led the agent somewhere it should not go |
| `errored` | a later call failed outright | the work did not hold |
| `reverted` | a file returned to a content hash it had ever held | thrash — the work was undone |
| `repair` | repeated edits to one file across a red verifier, never green | the loop is not closing |
| `none` | the horizon passed clean | — |

`reverted` seeds its hash history from BEFORE the window: an edit that undoes
the very change a rule fired on is the clearest thrash there is, and it is
invisible if history starts at the window boundary. (Caught by a failing test,
not by review.)

`repair` requires the absence of a green: red → fix → green is ordinary,
successful work, and labeling it a failure would punish the correct loop.

## Method

For a rule firing at step *k*, label the window of the next *H* calls. Then:

- `precision` = firings followed by trouble / firings
- `baseRate` = share of ALL windows that end badly
- `lift` = precision / baseRate

Lift is the number that matters. Precision alone is meaningless in a session
where most windows end badly anyway; lift asks whether the rule beat chance.
Defaults are conservative (`minFires` 10, `minLift` 1.5).

## Why mining is not first

Corpus mining (step 1) proposes rules FROM the data, which inherits every bias
the data has and dresses it as discovery. It is worth building for the
machinery, but its output should not be trusted until the corpus spans a second
codebase — the same N=2 gate everything else in this repo waits on. Ordering:
join (2) → promote (3) → maybe mine (1) → maybe cross-session (4).

## Next

Step 3 wires the join to real recorded sequences: replay `collection.jsonl` /
`activity.jsonl` through the shadow engine, collect firings per rule, and emit
a promotion report. Every rule keeps its current tier until a human reads that
report and decides — the report is evidence, not an actuator.
