# Proof of Enforcement (cost-shifted, refereed, multiplayer-extensible)

**Status:** Design memo (2026-06-04). The near-term shippable target is **R1 /
cost-shifted OSS-PR enforcement** (§8–9). **R2 / multiplayer Byzantine** (§12)
is far-future and is here only so R0/R1 get built with the right seams (§13).
Companion to [`trajectory-integrity.md`](trajectory-integrity.md) (this memo
*is* the concrete answer to that doc's §7-Q7 federation question) and
[`maximal-local-enforcement-roadmap.md`](maximal-local-enforcement-roadmap.md).

**Audience:** whoever builds the enforcement-attestation layer. Read §4 (the one
hard truth) and §14 (what this is NOT) before writing any signing-key code.

**Memory:** [[project_proof_of_enforcement_bft_extensibility]] (the pinned
directive), [[feedback_harness_deterministic_only]] (determinism is the enabler,
not just a philosophy), [[feedback_safety_continuity]] (fail-open > fail-closed —
the attestation layer is additive, never a gate on the agent's ability to work),
[[feedback_hook_latency_budget]] / [[feedback_deliberate_prepost_latency]] (local
signing <1ms on the hot path; the referee runs in the already-deliberate cloud
window), [[project_supervisor_pattern]], [[project_vision_multiagent]].

---

## 1. What this proves (and what it does not)

The claim is **proof of enforcement**, not proof of work:

> Every action in this trajectory was evaluated by interlinked ruleset `H` before
> the next action was allowed, and the full suite `T` — checks, tests, mutations —
> ran against the exact git tree `A` being shipped. Here is the tamper-evident,
> signed record, and you can reproduce it by re-running `T` against `A`.

This is strictly stronger than a post-hoc "the diff is clean" receipt, because it
attests that governance was **inline and live** — the agent was *subject to* the
harness while writing, not audited afterward.

**Scope:** the *observable tool-use loop only*. NOT the model's forward pass, NOT
reasoning traces, NOT agent-internal messages. We prove "the tool-loop was
governed," not "the model's thinking was governed." Actions taken through tools
the harness cannot observe (a custom binary issuing a raw syscall) are outside the
attestation by construction (cf. [`trajectory-integrity.md`](trajectory-integrity.md)
§8-Q6).

## 2. Origin: why this replaces proof-of-work

The idea began as "opportunistic PoW bound to the trajectory — an anti-spam
seriousness meter." That instinct was correct about the *goal* (impose asymmetric
cost to deter spam) and wrong about the *primitive*. Three problems with literal
PoW here, each of which the design below resolves:

1. **It has no home in this runtime.** Not the local hook (burning CPU on the hot
   path violates [[feedback_hook_latency_budget]]); not Workers (CPU is metered
   per-ms and the isolate suspends on I/O wait — no free background thread); not
   competing with `verify` (that's the actual product).
2. **It's wasted.** PoW burns compute to prove compute was burned. We already run
   expensive *useful* work (tsc, biome, cargo, mutation testing) — make *that* the
   proof.
3. **It's a flat tax.** PoW costs honest contributors and spammers equally. The
   required governed suite is **asymmetric in the right direction** (§9).

The enabler that lets useful work substitute for PoW is **determinism**
([[feedback_harness_deterministic_only]]): a deterministic check can be
*re-executed* by a referee and produce a bit-identical verdict. That single
property turns "prove you did the work" into "we'll cheaply re-check a random slice
of it," which is the whole design.

## 3. The four sub-claims

"Enforcement happened" decomposes into four claims that need different mechanisms
and have very different difficulty. Conflating them is the main design error to
avoid.

| Sub-claim | Proves | Mechanism | Difficulty | In code today |
|---|---|---|---|---|
| **Policy** | *which* harness governed | `ruleset_hash` = hash(guard rules + config + check-registry + distilled-rules + pinned tool versions) committed into every decision | trivial | ❌ only `manifest_hash` in `structure/cache-manager.ts`, for cache staleness |
| **Binding** | evaluated code == shipped code | commit git tree hash `A` into the chain *and* the receipt; compare to PR head | trivial | ❌ |
| **Inline ordering** | the gate fired *before* the next action | seq-chained signed entries, harness decision interleaved before next event; gap-evident seq | medium | ⚠️ hook is inline (live); `graph-prediction-flow.ts` already force-commits a prediction before reveal |
| **Verdict authenticity** | the checks/tests/mutations actually ran → `R` | referee re-executes an unpredictable sample + signs | medium→hard | ⚠️ `cloud-escalation.ts` / `cloud-forward.ts` return a `CloudVerdict`; not signed, not tree-bound |

Policy + Binding are a weekend and have single-player value immediately — they make
any `verify` result portable and pinned to an exact policy + tree.

## 4. The one hard truth

You cannot prove the hard sub-claims **from the submitter's own machine alone.** A
motivated faker who controls the box can run a fake harness that always says
"allow," sign with a self-generated key, and replay a self-consistent chain. The
chain proves *consistency, not benevolence* ([`trajectory-integrity.md`](trajectory-integrity.md)
§5).

The only thing that breaks the loop is **a key the faker doesn't hold and a path
they can't route around.** In this architecture that is **interlinked Cloud** (or,
in the OSS case, the maintainer's CI). Therefore:

> The strength of "proof of enforcement" against an *untrusted* party equals the
> fraction of enforcement that ran refereed by infrastructure that party does not
> control.

This is not a limitation — it is the moat. It is also why a trusted anchor exists,
which is why this is never a consensus / blockchain problem (§11).

## 5. The verifiability ladder

Each rung strengthens monotonically and **degrades fail-open** — if the Cloud is
unreachable, drop to the rung below, never block the agent ([[feedback_safety_continuity]]).

- **R0 — free CLI alone.** Deterministic receipt: `ruleset_hash` + git-tree hash +
  per-check findings (each carrying its `[proven]`/`[heuristic]` determinism tag).
  Honest claim = **reproducible** ("re-run it yourself"). No keys, no cloud, no
  trust transfer. This is the correct free-tier boundary.
- **R1 — free CLI + Cloud referee.** Adds a Cloud-issued challenge, streamed
  checkpoints (the Cloud witnesses the trajectory over real wall-clock), an
  **unpredictable random sample** that the Cloud re-executes, the expensive tier
  (mutation/integration) run *somewhere trusted* (see §8 for where), and a signed,
  tree-bound attestation logged to a transparency log. Claim = **refereed**.
- **R2 — multiplayer permissioned BFT** (far-future, §12). Cross-org temporary
  collaboration with no mutually-trusted arbiter ⇒ genuinely Byzantine. Threshold
  voting over a deterministic predicate, *not* a blockchain.

## 6. The refereed-delegation protocol (R1)

```
SESSION START
  local → cloud:  begin(session S, repo R, base commit C)
  cloud → local:  challenge χ (fresh, unpredictable) + accepted ruleset_hashes + id
                  cloud logs (S,R,C,χ,t0) append-only          ← anti-precompute / anti-replay

PER GATE  (the inline hook — already live)
  harness evaluates event E under ruleset H → decision D, findings F (determinism-tagged)
  local appends chain entry:
     chain_hash = sha256( event_hash(E) ‖ tree_hash(A_seq) ‖ ruleset_hash(H) ‖ D ‖ prev ‖ χ )
  agent is gated on D before proceeding                        ← already happens

CHECKPOINT  (every N events / M minutes — tiny, just hashes)
  local → cloud:  (S, seq, chain_hash, tree_hash)
  cloud logs arrival time                                      ← witnesses growth over real time

REFEREE  (async, inside the already-deliberate pre/post cloud window)
  cloud picks k random seqs (unknown to local in advance)
  cloud checks the supplied content hashes to the ALREADY-WITNESSED commitment   ← can't doctor after the fact
  cloud re-executes H on each → asserts D' == claimed D                          ← determinism ⇒ bit-equal
  cloud signs:  attest( S,R,C,χ, ruleset_hash, tree A, sampled=match, expensive-tier result, t-range )

VERIFY  (third party, anytime)
  pull attestation (signer's well-known key) + local chain + the artifact
  check: sig valid · tree==artifact · χ real · checkpoints span real wall-clock · (optional) re-run T vs A
```

The sample is sound **only because of the prior commitment**: the submitter
committed `tree_hash`/`event_hash` in a checkpoint the Cloud witnessed *before*
learning which seq would be audited, so they cannot supply doctored content later
without breaking the witnessed `chain_hash`. This is exactly the
commit-before-reveal pattern already shipped in `graph-prediction-flow.ts`
(force-predict → reveal oracle → reconcile), generalized from graph predictions to
every decision.

This also disposes of "did real time pass?" cheaply: the Cloud is an **honest
clock** (checkpoint arrival spread), so no verifiable-delay-function is needed in a
refereed setting.

## 7. The killer property

> Because the checks are deterministic and the referee's audit sample is
> unpredictable, the **only** way to produce a record that survives the spot-check
> is to have actually run the suite and passed it. **Forging a passing receipt
> costs the same as honestly running the harness.**

This is proof-of-work's economic structure (expensive to produce, cheap to verify,
spam-deterring) with the expense being the *real, required* tests/mutations instead
of wasted hashing. It is the load-bearing property behind both verifiability (§6)
and cost-shift (§8–9).

## 8. Lead customer: cost-shifted OSS-PR enforcement (R1)

**The problem.** OSS repos are under a slop-PR DoS: it is cheap to generate
thousands of lines and fire a PR; it is expensive for the maintainer to run CI
(GitHub Actions minutes, possibly a large test/mutation suite) and to review. The
cost is asymmetric in the wrong direction.

**The flip (the core design decision).** The expensive suite runs on the
**submitter's** side, at authoring time ("the work that should have run at
inference time, by the writer of the code"). The referee re-runs only a **small
unpredictable sample** — *not* the whole tier. The maintainer verifies a signature.

Three-party cost ledger:

| Party | Pays | Why |
|---|---|---|
| **Submitter** | O(N) — full suite compute + wall-clock + small refereeing fee | the deterrent; the cost that *should* have been incurred |
| **Referee** (interlinked Cloud) | O(k) — unpredictable sample | covered by the submitter's fee |
| **Maintainer** | ~O(1) — signature + tree-hash check | trusts the referee's signature, not the submitter |

The slot-cannon dies because each spam PR now costs a full governed-suite run up
front (§7: no cheaper way to pass), and a no-receipt PR is an O(1) reject — the
maintainer never spins up CI to *discover* a PR is junk.

**Trust topology — this is R1 (anchored), NOT R2 (Byzantine).** The maintainer IS
the arbiter (their repo, rules, CI) and can always fall back to a full re-run. The
submitter is untrusted by construction; the receipt is trustworthy because of who
*refereed* it, not who *produced* it. No consensus, no agent identity, no stake.

**What it shifts, and what it doesn't (do not oversell).**
- ✅ Shifts the **mechanical / CI cost** — the Actions minutes, the test/mutation
  compute, the discover-it's-junk tax. Exactly the cost maintainers pay today.
- ❌ Does NOT shift the **human-judgment cost.** A PR can pass every governed check
  and still be subtly wrong or malicious (consistency-not-benevolence, §4). So this
  is a **triage filter / prioritization mechanism**, not review elimination: the
  PRs that reach a human's eyes already cost real, refereed effort.

**Honest boundary vs. existing tooling.** Basic "checks ran on this PR" is already
solved by GitHub branch protection + required status checks. Do not lead there. The
genuine wedge is (a) the cost-shift / admission control above, (b) portable,
transparency-logged enforcement **provenance** (SLSA/in-toto, but for the
*authoring* step rather than the build step), verifiable by downstream consumers.

**Lighter receipt suffices.** Cost-shift needs only the artifact-level claim
("submitter ran H's full suite against tree A, passed, refereed"), NOT the heavy
inline trajectory chain of §6. The chain is for forensics (R2, multi-party); the
cost-shift customer ships first on the lighter artifact.

## 9. Economics & threat model (why not just PoW)

**"Slow down" and "raise cost" are the same lever for the adversary who matters.**
Both PoW and the useful suite are **parallelizable**:
- A **casual sprayer** (one laptop, one agent loop) can't parallelize → the suite
  hits them with *both* levers: real wall-clock latency (the agent waits) and
  compute cost. This is the dominant willy-nilly case; the suite wins cleanly.
- A **funded/industrial spammer** buys cores → latency vanishes, only **cost**
  remains — and PoW behaves identically. Neither "slows" a funded adversary; both
  tax them. The only primitive that imposes unparallelizable wall-clock is a **VDF**,
  and you don't want it (it taxes honest *fast* contributors too, for no useful
  output).

**Useful work is the uniquely right-asymmetric deterrent.** PoW is a flat tax on
everyone. The required suite is ~free to a careful contributor (they wanted the
tests to pass anyway) and costly only to someone spraying code they never
validated. That is the ideal deterrent shape, and PoW structurally cannot achieve
it.

**The deterrence stack** (ordered; artificial PoW is dominated on every axis and is
retired):
1. **Required governed suite** — cost + latency, asymmetric, useful output. Primary.
2. **Per-identity rate limits** (via GitHub OIDC) — the actual parallelization-proof
   "slow down" knob; an adversary can buy cores but not credible identities at will.
3. **Reputation graduation** — established contributors face less friction; new /
   anonymous face more. Feeds the reputation substrate (`recurrence`, accepted-PR
   history).
4. **Refundable submission bond** — cleanest *monetary* deterrent (forfeit on
   spam-reject, refunded on merge), waste-free, asymmetric. BUT posting cash to
   contribute is brutal OSS friction → a commercial/enterprise lever, not an
   open-OSS one.

**Tension to hold:** any submission cost also deters legitimate first-time
contributors (OSS lifeblood). The resolution is asymmetry — *free if you meant it*
(suite), *refunded if good-faith* (bond), *lighter as trust grows* (reputation). A
flat PoW cost gets this exactly backwards.

**Attack surfaces:**
- **Variant-amortization** — run the suite once on a base, fire many micro-diff
  variants that re-pass cheaply. Strongest deterrent when the suite is expensive
  *relative to the diff*; weak against adversarial micro-diffs (which are also cheap
  for the maintainer to review, so the ratio is roughly preserved).
- **Adoption friction** — submitters must run interlinked; mandating "receipt
  required" trades spam-reduction for some legit-contributor friction. GTM gate.
- **Refereeing-fee tuning** — the master economic dial; too high deters legit
  contributors, too low doesn't deter spam.

## 10. Identity model

Identity is **user-level OIDC (e.g. GitHub login), not agent-level.** Agents are
unkeyed instruments the human is accountable for; the human is the principal. There
is **no agent key.**

Lean on **Sigstore-keyless** rather than a bespoke key hierarchy: an OIDC token →
Fulcio issues a ~10-minute ephemeral cert binding the signature to the human's
identity → the signature lands in the Rekor transparency log → the key is
discarded. This is the off-the-shelf machinery for "bind an attestation to a human
identity without long-lived keys," and it assumes exactly the user-not-agent shape.

In the OSS case the submitter needs no trusted key at all — the **trust root is the
referee's signature**, and the submitter's identity is metadata (bind it via
Sigstore-keyless only if attribution is wanted).

## 11. Why not blockchain / where Byzantine consensus does and does not apply

**The routing rule.** Byzantine consensus solves exactly one problem: *N
mutually-distrustful parties must agree with no party they all trust to arbitrate.*
The precondition is **no trusted coordinator.** The moment a common anchor exists,
consensus is solving a problem you don't have.

- **R0 / R1:** a trusted anchor exists (Cloud, maintainer). → refereed delegation,
  no consensus. The substrate itself is anchor-shaped: a Durable Object is what you
  use *instead of* consensus (one authoritative serialization point so you don't run
  Raft).
- **Tamper-evidence / "audit the referee":** a **Merkle transparency log + gossip**
  (Certificate Transparency / Sigstore-Rekor / in-toto / SLSA) — NOT a blockchain,
  NOT consensus. These are the closest production systems to proof-of-enforcement
  and every one of them deliberately rejected consensus. Git is a Merkle DAG with no
  consensus.
- **R2 multiplayer (the only genuine Byzantine niche):** even here it is
  **permissioned, not permissionless** — players have registered identities. That
  routes to the **PBFT / Tendermint / HotStuff** lineage, NOT PoW/Nakamoto (PoW
  exists solely for Sybil resistance *without* identity). And **determinism
  collapses consensus into voting**: honest nodes re-running a deterministic
  predicate are bit-identical, so disagreement is dispositive and you threshold
  signatures (k-of-N) rather than run multi-round consensus.

**The "trusting the referee" sub-ladder:**
- **R0:** single trusted referee signs.
- **R1:** referee's attestations go into a CT-style transparency log → the referee
  itself becomes publicly auditable; a false or contradictory attestation is
  catchable by anyone who re-runs the deterministic checks. Still no consensus.
- **R2:** M independent verifiers re-execute deterministically + k-of-N threshold
  signatures → tolerate `f` malicious verifiers. Byzantine *voting*, not a chain.

**The answer to "is there any blockchain use case here?"** No — not in any version
of *this* product (free CLI + trusted Cloud + real identities). Blockchain is the
technology of *trustlessness* (permissionless, anonymous, no operator); this
architecture is built on a *trust anchor* and identities. Those are opposites. Every
job people reach for a chain to do, an unbundled primitive does better here
*because* the anchor exists. The single asterisk: the far-future R2 substrate
(permissioned-BFT-replicated git DAG) is technically DLT-family and could be
*marketed* as a "permissioned ledger," but that is vocabulary — it uses the
Merkle-log + threshold-voting pieces (built anyway) and none of the
blockchain-defining machinery (PoW, token, permissionless consensus). A blockchain
becomes correct only if you deliberately *remove* the trust anchor and go
permissionless+anonymous — which is a different product, and a worse business.

## 12. R2 — multiplayer (reserved design; resolves trajectory-integrity §7-Q7)

Scenario: multiple players, each with multiple agents, partial information,
temporary collaboration, no mutually-trusted arbiter, "good as long as enough are
honest." This is genuinely Byzantine; "enough honest" is the BFT threshold (>2/3
honest *weight* for async permissioned BFT). Tolerating agents that are malicious OR
accidentally destructive OR buggy, uniformly, is exactly what "Byzantine" means.

The real object is **a policy-gated, BFT-admitted git DAG**, not a token-chain:
- **Admissibility** = a *deterministic* harness predicate (all honest nodes compute
  bit-identical) → cheap threshold voting, no negotiation.
- **Finality** = an honest-weight threshold certificate.
- **Concurrent edits** inherit git's DAG/merge; a merge is just another change that
  gets validated.

**Sybil landmine:** vote weight attaches to the **user (human) identity / bond,
NEVER to agent count** — else one bad user owns the majority by spawning agents.
"Enough honest" means enough *user-weight*, not enough agents.

**Membership → mechanism:** closed membership = pure identity + threshold;
open/temporary membership = identities get cheap → a **bond** is the legitimate
Sybil-resistance + accountability primitive (the honest PoS echo: accountable
deposits + slashing on *provable* equivocation, not mining).

**Honest-majority buys agreement + validity + accountability, NOT wisdom** — a 2/3
honest-but-mistaken majority can admit a bad-but-rule-passing change. The
deterministic harness carries *safety*; the quorum carries *admission/finality*
(the detection/decision split, [[project_supervisor_pattern]]).

Prior art: Kleppmann, *"Making CRDTs Byzantine Fault Tolerant"* (PaPoC 2022) —
collaborative editing with malicious participants over a hash-DAG of operations
(git-shaped); PBFT / Tendermint / HotStuff for permissioned BFT.

## 13. Forward-compatible seams (build R0/R1 so R2 is a config change, not a rewrite)

1. **Identity = user OIDC, no agent key** (§10). Sigstore-keyless, not a bespoke
   hierarchy.
2. **Vote weight / accountability attaches to the user, never agent count** (§12 —
   the #1 correctness landmine).
3. **Attestation = a portable, reproducible, content-addressed claim** (in-toto/SLSA
   envelope) — one participant's receipt is already a well-formed "vote" others can
   independently co-sign.
4. **Separate admissibility (deterministic) from finality (signer set).** Signer set
   = {Cloud / maintainer} today, {k-of-N users} later.
5. **The attestation log is an append-only Merkle DAG** (bind to git object hashes),
   not a single-writer linear chain.
6. **Quorum size is a config value** = 1 today, ⌈2N/3⌉+1 later — the codepath always
   asks "do we have a finalizing quorum?"
7. **The R1 transparency log is R2's evidence substrate** — build it so "user B
   signed two contradictory verdicts for tree A" is already a provable, slashable
   offense, not just "audit the Cloud."

## 14. What this is NOT

- **NOT proof-of-work.** §2, §9. Retired in favor of refereed useful work.
- **NOT a blockchain.** §11. Trust anchor in scope; permissioned even at R2.
- **NOT a trust replacement.** The chain/receipt proves *consistency, not
  benevolence* — a suborned agent signs whatever it wants; a rule-passing PR can
  still be malicious. §4, §8.
- **NOT review elimination.** It shifts mechanical/CI cost and *triages*; the human
  judgment cost remains. §8.
- **NOT governance of the model's forward pass.** Observable tool-loop only. §1.
- **NOT load-bearing for the single-player free-CLI tier.** R0 is "reproducible";
  attestation matters at the cross-party boundary.
- **NOT a fail-closed dependency.** If signing / the referee is unavailable, degrade
  to the rung below; never block the agent. [[feedback_safety_continuity]].

## 15. What exists today / build order

Already generating the evidence (≈ half-built):
- Inline gate (the hook decides before the tool runs).
- Commit-before-reveal: `src/harness/graph-prediction-flow.ts`.
- Cloud verdict socket: `src/harness/cloud-escalation.ts`, `cloud-forward.ts`
  (`CloudVerdict`, `mergeCloudVerdict`) — returns decisions; needs signing +
  tree-binding + a sampling driver.
- Determinism ledger: `classifyDeterminism` /
  `quality-checks/instructions.ts::PROVEN_TOOL_CHECKS` (`[proven]` vs `[heuristic]`).
- Deterministic re-execution: the whole check engine + the deterministic-only
  mandate ([[feedback_harness_deterministic_only]]) — the enabler.
- Append-only logs: `.interlinked/verify-runs.jsonl`, `activity.jsonl`,
  `graph-reconciliations.jsonl`; `replayTransitions` in `reservations.ts`.
- Cloud mutation fan-out: designed in `maximal-local-enforcement-roadmap.md`.

Net-new: `ruleset_hash` + tree hashing (only `manifest_hash` exists, in
`structure/cache-manager.ts`); the signing / sampling driver; the transparency log.

**Build order:**

- **Step 0 — de-risk the foundation (determinism-replay conformance harness).** The
  whole edifice rests on bit-stable replay. *Same-process: shipped 2026-06-04* —
  `src/harness/determinism-conformance.ts` and its test drive the pure inline pipeline
  (`buildAgentSafetyChecks`), canonicalize findings (codepoint sort, deliberately not
  `localeCompare`), run N times, and categorize any divergence (count / timestamp /
  cwd-leak / text). Result over the full detector-source corpus — 73 inputs, 728
  findings, 21 distinct checks, 8 runs each: **73/73 bit-stable, 0 unstable, 0
  cwd-leaks.** A source-hygiene guard (`scanDeterminismHazards` + the
  `@determinism-critical` opt-in marker) bans locale-/FS-order-dependent idioms in
  substrate files. *Fresh-process: shipped 2026-06-04* —
  `determinism-replay-driver.ts` runs the pipeline in a child process under a
  perturbed timezone + locale (`TZ=Asia/Kolkata`, `de_DE`); output is byte-identical
  to the in-process run, so no check leaks process-start state. *Remaining:*
  cloud-Sandbox replay (the real cross-machine test; pin tool versions into
  `ruleset_hash` so a version skew is a *different policy*, not a *failed audit*) —
  the same driver is its entry point. Only when Sandbox replay passes is the referee
  model (§6) proven sound.
- **Step 1 (R0) — keyless, fail-open:** `ruleset_hash` + git-tree-hash committed into
  the decision path / `verify-runs.jsonl`. Single-player value immediately.
- **Step 2 (R1) — referee:** Cloud challenge + checkpoint + unpredictable sample +
  sign + transparency log. Ship the **cost-shifted OSS-PR** customer (§8) on the
  lighter artifact-level receipt.
- **Step 3 (R2, far):** harness/user co-signature, gap-evident chain, threshold voting
  — only when a concrete cross-org / multiplayer customer exists. Hold behind that
  trigger ([[feedback_safety_continuity]]).

## 16. Open questions

1. **Refereeing-fee model** (§9) — the master economic dial; needs a real pricing
   experiment, not a guess.
2. **Where the expensive tier physically runs** — submitter's own hardware (cost
   unmetered but enforced by §7) vs. metered interlinked-Cloud compute (literal
   invoice as proof-of-cost, but forces submitters onto paid infra). Default to the
   former; offer the latter for "I want a dollar-denominated cost receipt."
3. **Sample size `k` vs. assurance** — how large a random sample gives acceptable
   false-pass probability for a given suite size, and whether `k` should scale with
   the submitter's reputation.
4. **Variant-amortization mitigation** (§9) — is diff-relative suite cost enough, or
   do we need per-identity rate limits to carry the load against micro-diff floods?
5. **Maintainer onboarding** — what is the lowest-friction "require an interlinked
   receipt" GitHub Action that a maintainer can adopt in one commit?

---

## TL;DR

Prove the **tool-use loop was governed** (checks/tests/mutations ran against the
shipped git tree) via **refereed delegation**: the submitter runs the deterministic
suite; a trusted referee (Cloud, or the maintainer's CI) re-executes an
**unpredictable random sample** and signs a tree-bound attestation. Determinism
makes the sample sound, so **forging a passing receipt costs the same as honestly
running the harness** — proof-of-work's economics with *useful* work. Lead customer:
**cost-shifted OSS-PR enforcement** — push the expensive suite onto the submitter,
let the maintainer verify a signature in ~O(1), defeating the AI-slop-PR DoS as a
*triage filter* (not review elimination). Identity is **user OIDC, not agent**
(Sigstore-keyless). **No blockchain** in any version of this product — the trust
anchor and real identities are the opposite of what a chain assumes; the only
genuine Byzantine case (far-future multiplayer) is *permissioned threshold voting
over a git DAG*, not a ledger. Build R0/R1 with the §13 seams so R2 is a
config/scale change, not a rewrite.
