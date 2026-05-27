# Trajectory Integrity (cryptographic future work)

**Status:** Far-future design memo (2026-05-27). Not in the build queue. Pinned here so the future-engineer who picks this up has the threat-model framing already settled, doesn't waste a cycle on blockchain, and doesn't ship signing-key code paths without a concrete win condition.

**Audience:** Whoever sits down to build cross-agent / cross-player trust attestation in the multi-player era. Companion to [`trajectories-as-primitive.md`](trajectories-as-primitive.md) §4.4 and [`multiplayer-control-plane.md`](multiplayer-control-plane.md).

**Memory:** [[feedback_safety_continuity]] (fail-open > fail-closed on integrity).

---

## 1. The problem this would solve

Once multiple players operate fleets of agents on a shared workspace, "what did agent X do?" becomes a question of trust between parties. Today's `activity.jsonl` is plaintext append-only — any party with read access can rewrite it and the harness wouldn't notice.

That's acceptable for the single-player local-only model. It isn't when:

- Player A reviews Player B's agents' work and needs to verify what those agents claim to have done.
- An incident review needs to attest "agent X really did issue that command at T, and the log hasn't been edited" — for forensics, for compliance, for a customer trust story.
- An enterprise or regulated environment requires tamper-evident audit trails as a procurement gate.

## 2. What we want from an integrity layer

1. **Tamper-evidence.** Any rewrite of past events leaves a detectable signature mismatch. We don't need to prevent tampering — we need to make tampering visible.
2. **Per-agent attestation.** Each event is signed by the agent that produced it, with a fingerprint pinned to a registered identity.
3. **Cross-party verifiability.** Player A's tools can verify Player B's agents' logs without trusting Player B.
4. **Low overhead.** Signing must add < 1ms per event; the harness's hot path is sacred ([[feedback_hook_latency_budget]]).
5. **Failure-tolerant.** If the signing key is unavailable or signing fails, the harness still records events (per [[feedback_safety_continuity]] — fail-open > fail-closed on safety continuity). An unsigned event is recoverable; a missing event is not.

## 3. Why NOT a blockchain

The user explicitly raised "blockchain or checksum" as the candidate. Honest assessment: blockchain is the wrong shape for this problem. The pattern that fits is closer to **git, Certificate Transparency, or signed syslog** — Merkle / hash chain with per-agent signing keys.

### 3.1 Trust anchor

Blockchain solves the no-trusted-third-party problem: how do mutually-distrustful parties agree on a transaction order without a central authority? **We don't have that problem.** The Interlinked MCP Server is the system of record. All parties (players, agents, reviewers) already trust it — it holds their account, their workspace data, their reservations. A trust anchor is in scope; distributing the trust is solving the wrong problem.

### 3.2 Consensus is absurd here

We're not adjudicating "which transaction came first" across mutually-distrustful nodes. We're recording events from agents that **have already happened**. There's no global ordering question. Per-agent monotonic seq + server-mediated wall-clock is sufficient.

### 3.3 Latency

Block intervals would be too slow (multi-second per block) or pointless (sub-second consensus is just a trusted server pretending to be distributed). Both are worse than the simple hash-chain alternative.

### 3.4 Storage cost

Replicating every event across every player's node is wasteful when the server already stores the canonical copy. Multi-player workflows would scale the per-player storage linearly with the number of participants for no security benefit.

### 3.5 PoW / PoS

Energy-burning consensus or stake-locking incentive engineering has zero alignment with the actual threat model. The threat is post-hoc log tampering by a party with read+write access to a log file. PoW does not address that threat.

### 3.6 What does fit

**Append-only signed log with a Merkle / hash chain.** The same primitives Certificate Transparency, git's commit DAG, and signed syslog use. Tamper-evident, signed, low-overhead, server-anchored, and well-understood. The rest of this doc designs that.

## 4. Proposed mechanism (sketch, v1)

### 4.1 Per-agent identity

At `SessionStart`, the agent's local harness generates an Ed25519 keypair via Node's `crypto.generateKeyPairSync("ed25519")`. The public key fingerprint is registered with the Interlinked MCP server alongside `(workspace_id, session_id, agent_name, agent_source)`. The **private key stays local** — it never leaves the machine.

Key custody:
- Stored in `.interlinked/keys/<session_id>.private.pem` with `chmod 600`. Already inside `.interlinked/`, which is gitignored.
- Generated fresh per session. No persistence across restarts; the next session generates a new keypair and registers a new fingerprint.
- Old fingerprints stay valid for verifying old events; signing capability dies when the private key is dropped.

Revocation: a player can revoke a fingerprint via the server. Subsequent events signed with that key are stamped "revoked at T" in the chain — visible to verifiers without invalidating *prior* events (which were validly signed before revocation). This is the model Certificate Transparency uses.

### 4.2 Hash-chain construction

Parallel to `activity.jsonl`, a new file `.interlinked/sessions/<id>.chain.jsonl` carries the chain. One entry per event:

```jsonc
{
    "seq": 47,
    "event_ref": { "log": "activity.jsonl", "byte_offset": 123456, "len": 287 },
    "event_hash": "sha256(canonicalized event JSON)",
    "prev_chain_hash": "sha256-of-prev-chain-entry",
    "chain_hash": "sha256(event_hash || prev_chain_hash || seq)",
    "signature": "ed25519(chain_hash, agent_session_key)",
    "key_fingerprint": "abc123...",
    "signed_at": "2026-05-27T14:32:18.471Z"
}
```

Why a parallel file, not embedding the chain into `activity.jsonl`:
- `activity.jsonl` is plain-text JSONL today; consumers (the recurrence aggregator, the activity feed, the sync uploader) parse it line-by-line. Adding cryptographic fields inline would break those consumers.
- The chain file is opt-in. Builds without the integrity feature compile a no-op `appendChainEntry()`; the parallel file stays empty.
- Per-session-scoped chain files map cleanly onto per-session keys (one chain, one keypair).

Canonicalization for hashing:
- JSON object keys sorted lexicographically
- No insignificant whitespace
- Numbers in shortest round-trippable form
- Strings UTF-8, no escape variations
- Maps serialized as sorted key/value arrays (matches the trajectory-signature §5 contract)

This must be deterministic — re-canonicalizing the same logical event on a different machine must produce the same bytes.

### 4.3 Verification

A verifier (Player A's review tool, an audit script, the server's nightly job):

1. Read `activity.jsonl` and `.chain.jsonl` together.
2. For each entry, look up the event at `event_ref.byte_offset`, re-canonicalize, re-compute `event_hash`.
3. Re-compute `chain_hash = sha256(event_hash || prev_chain_hash || seq)`.
4. Verify `signature` against the public key registered under `key_fingerprint` (pulled from the server's fingerprint registry, or the locally-cached one).
5. First mismatch = first tamper point.

Tampering with any past event invalidates that event's `event_hash`, which cascades through every subsequent `chain_hash`. The signature on the last entry won't validate unless the attacker has the agent's private key.

### 4.4 Cross-agent consistency checkpoints

Periodically (every N events or every M minutes; both bounded), the agent publishes its current `chain_hash @ seq=N` to the server:

```jsonc
POST /api/integrity/checkpoint
{
    "workspace_id": "...",
    "session_id": "...",
    "agent_id": "...",
    "seq": 100,
    "chain_hash": "...",
    "signed_at": "...",
    "signature": "ed25519(chain_hash || seq || workspace_id, agent_session_key)"
}
```

The server stores `(workspace_id, session_id, agent_id, seq, chain_hash, published_at, signature)`. This is its own append-only log on the server side.

**Conflict detection.** If an agent later claims `chain_hash @ seq=100 = H_x` but the server's stored `chain_hash @ seq=50 = H_y` doesn't extend to `H_x` (via re-derivation of seqs 50→100), that's tampering between the published checkpoint and the rewritten chain. Visible to any party with read access to the workspace.

This is the same shape Certificate Transparency uses for log consistency proofs.

### 4.5 Multi-agent / multi-player merge

In a multi-player workspace, each agent maintains its own chain. The workspace's merged trajectory is the ordered union by `(published_at, agent_id, seq)`. Within each chain, integrity is local. Across chains, the server's ordering of checkpoint publishes is canonical.

When Player A reviews Player B's agent's chain:

1. Pull Player B's `chain.jsonl` from the server (or B's local share via a federated read).
2. Pull Player B's published checkpoints from the server.
3. Verify: does B's locally-claimed chain extend each published checkpoint? If yes, the chain is internally consistent — A trusts it as much as A trusts the server's fingerprint registry.
4. If a checkpoint mismatch is detected, surface to A as "Player B's agent's chain is inconsistent with what was published at T=X".

This is enough for **forensic-grade attestation** without requiring distributed consensus.

## 5. What this is NOT

- **NOT a trust replacement.** A compromised agent (key stolen, agent runtime suborned, host machine compromised) can sign whatever it wants. The chain proves *consistency*, not *benevolence*. We're catching the dishonest log-rewriter, not the dishonest agent.
- **NOT a blockchain.** See §3.
- **NOT a substitute for the deterministic-only stance at local-tier checks.** This is forensic/audit infrastructure, not a check that fires at agent-decision time.
- **NOT a replacement for cross-session memory.** Memory is what the next agent reads to inform its work. Integrity is what an auditor reads to verify what already happened. Different audiences, different timelines.
- **NOT load-bearing for the local-only single-player free-CLI tier.** Single-player workflows don't need cross-party attestation. Integrity becomes load-bearing at the multi-player tier ([[multiplayer-control-plane]]).

## 6. Today's posture

This is design only. The shipping action items would be:

1. **Reserve `chain_seq?: number` on `HarnessEvent`.** Per-session monotonic seq is the input to future chain construction. Cheap one-line add to `types/events.ts` whenever it becomes useful; can be derived from `activity.jsonl` ordering retroactively if absent. *Defer until concrete need.*
2. **Document the threat model and key custody story.** This doc.
3. **Don't ship any signing-key code paths today.** Signing keys are a liability without a clear win condition — they're another piece of state that can leak, get wedged, or block fail-open recovery. Wait until a concrete multi-player attestation need exists.

**Why the deferral.** Per [[feedback_safety_continuity]], adding a code path that *can* fail-closed (signing-key missing → can't record event) is anti-extensibility for the safety story we're committed to. Build it when there's a customer asking; reserve the design now so we don't have to re-think it under pressure.

## 7. Open questions to settle before implementation

1. **Key custody UX.** Per-session keys are simple but mean no cross-session identity. Per-agent (across sessions) keys give richer attestation but introduce a key-rotation problem. Initial proposal: per-session, escalate to per-agent only if a use case demands it.

2. **Server-side fingerprint registry.** Does the server store fingerprints in plaintext or hash them? Plaintext is simpler and there's no secret to leak (public keys are public by design). Lean plaintext.

3. **Checkpoint publish frequency.** Every N events vs every M minutes vs both. Balance: more frequent = tighter consistency proofs but more server load. Initial proposal: every 50 events OR every 5 minutes, whichever fires first.

4. **Recovery from key loss.** If the local private key is destroyed mid-session (crash, disk failure), the chain stops at the last signed entry. Subsequent events are unsigned. The server's last-checkpoint marker is the last verifiable point. Initial proposal: surface as a `[interlinked:integrity]` warning on next session start; don't block.

5. **Cloud-side replay.** Should the server reconstruct chain validity from its checkpoint log alone, or pull the chain file on demand? The latter is more storage on the server but enables full re-verification.

6. **Cross-tool integrity.** If the agent uses a tool the harness can't observe (a direct kernel syscall via a custom binary), that operation isn't in the chain. This is a known limitation; the chain attests to *observable* trajectory only.

7. **Federated chains.** Two players cooperating on the same workspace each have their own chains. The "workspace canonical trajectory" is the merge — but if the players don't trust each other to publish checkpoints honestly, they can collude with the server. Does this require a third-party witness? Probably overkill for v1.

8. **Provenance attestation in the chain.** Should the chain entry also commit to the trajectory-state-at-time-of-event — `sensitivity_level`, active `taint_sources` (with provenance), `declared_plan` if any — at the moment of action? Forensically essential: an auditor needs to verify not just "agent acted" but "agent acted under what trajectory context." Without it, an investigation into "did the agent exfiltrate after reading attacker content" can confirm the actions but not the context that made them adversarial. Trade-off: bigger per-event payload, and the per-event size grows with the trajectory.

   **Initial proposal:** the chain entry commits to a hash of the canonical `TrajectorySignature` (per [`trajectories-as-primitive.md`](trajectories-as-primitive.md) §5) computed at the moment of the event. The signature itself is stored in a parallel `.interlinked/sessions/<id>.signatures.jsonl` keyed by `seq`. An auditor can rebuild the signature from the event log + derived state, hash it, and verify it matches the chain's commitment. Cheap per-event hash (O(1) once the signature is computed); expensive part is the signature computation itself, which we can amortize by emitting signatures every K events rather than every event — and only requiring chain-commitment to the signatures we actually emit. Open: how granular should signature emission be — every event, every N events, every Stop?

   **Why this matters for injection forensics specifically:** when reviewing an incident, you need to know not just "the agent issued curl X" but "the agent issued curl X while session sensitivity was Confidential and taint included a fetched-external source from issue-body-Y." Provenance attestation is what makes the integrity layer load-bearing for the trajectory-as-primitive design rather than just an audit signature on raw events.

## 8. Naming

If/when we ship this, the namespace is `trajectory-chain` / `chain.jsonl` / `chain_hash` / `key_fingerprint`. NOT "blockchain", NOT "ledger" (overloaded with crypto and accounting connotations), NOT "audit log" (too generic). The pattern is a **signed hash chain** — that's the right name and the right precedent (git uses it, CT uses it, syslog uses it).

---

## TL;DR

Future work: signed hash chain over the per-session event log + periodic checkpoint publishes to the Interlinked MCP server, for tamper-evident multi-agent / multi-player attestation. Per-session Ed25519 keys, local-only private keys, public fingerprint registry on the server. NOT a blockchain — distributed ledger solves the wrong problem here. Don't build any of it today; the only reservation worth making is `chain_seq?: number` on `HarnessEvent`, and even that can wait. Ship when a concrete multi-player attestation need exists; this doc means the design isn't blocking that PR.
