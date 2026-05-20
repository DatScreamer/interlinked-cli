# Multiplayer broker orchestration

*Protocol and mechanism layer for the [[multiplayer-control-plane]].
Picks the wire format, identity model, distribution channel, and
failure-handling primitives that the control plane runs on.*

## Relationship to [[multiplayer-control-plane]]

`[[multiplayer-control-plane]]` defines **what** the system is: a
multiplayer orchestration control plane with humans, cohorts, agents,
tasks, reservations, receipts, handoffs, an event log, projections, a
policy compiler, and a set of protocol adapters (MCP, CLI hooks, web,
GitHub/CI).

This doc defines **how** that system talks on the wire:

- The wire protocol between agents, local harnesses, and the team
  broker.
- The identity chain that makes every action attributable.
- The distribution channel that pushes policy and contention events to
  fleets of harnesses in seconds.
- The failure model — especially the "valid but harmful" verdict class
  that deterministic validation cannot catch.
- The unification of file scopes, cloud verdicts, and handoffs under
  one transition machine.
- The specific Atlassian patterns whose lessons apply, and how to wire
  them in.

If `[[multiplayer-control-plane]]` is the architectural blueprint, this
is the protocol spec and mechanism kit. Read that one first.

---

## TL;DR

- **Adopt the Open Service Broker (OSB) API as the internal wire
  format** between agents, local harnesses, and the team broker.
  OSB already encodes the multi-tenant identity fields, async-with-
  polling semantics, idempotent provisioning, and instances-vs-bindings
  separation that the control plane needs. MCP tools stay; they become
  the agent-facing adapter that translates into OSB underneath.
- **Build the orchestrator as two nested OSB brokers** — a team broker
  on the server (the Workspace + Cohort Coordinators in
  `[[multiplayer-control-plane]]`) and a local broker on each player's
  machine (the existing harness daemon). Same protocol at both layers.
- **Carry identity as a signed JWT chain** (`org → workspace →
  player → agent`) using OAuth's `act` claim for delegation. The team
  broker signs; every harness verifies.
- **Extend the existing reservation transition machine** in
  `src/harness/reservations.ts` into a `HarnessTxn` discriminated union
  that covers file scopes, Tier 2 verdicts, handoffs, evictions, and
  policy-version bumps. One state machine, one audit log.
- **Distribute policy and contention via an xDS-style streaming
  channel** (Server-Sent Events on HTTP/2), not per-harness polling.
- **Default fail-closed for enterprise distributions**; keep fail-open
  as the individual-developer default.
- **Treat "valid but harmful" cloud verdicts as the primary Tier 2
  risk** and mitigate with canary, two-of-three voting for high-blast-
  radius operations, and behavioral observability over verdict
  correctness.

Everything here builds on existing Interlinked code. No greenfield
required; the local broker is the existing harness with a different
label and a few new endpoints.

---

## 1. Why pick a wire protocol at all

`[[multiplayer-control-plane]]` enumerates protocol adapters (MCP,
CLI hooks, web UI, GitHub/CI) but leaves open how the **internal**
protocol between local harnesses, agents, and the server is shaped.
Specifically, three places in that doc need a concrete wire format:

1. The local-harness ↔ server sync: how does a harness request a
   reservation from the team broker, poll for its status, and receive
   a signed grant?
2. The agent ↔ local-harness call: how does an agent request a scope,
   wait for it, and present a credential on subsequent tool calls?
3. The harness ↔ harness contention notification: how does Alice's
   harness learn that Bob just released the scope she's waiting on?

These are not three different problems. They're one protocol question
asked at three layers. Picking a single shape for all three keeps the
mental model small.

---

## 2. The Open Service Broker API as the wire shape

OSB is a ~30-page REST specification that originated in Cloud Foundry
(circa 2014), was adopted by Kubernetes' Service Catalog, and has been
deployed at scale by Atlassian, IBM, SAP, and Pivotal. It moves slowly
on purpose: the wire format has been stable for years.

Seven endpoints, OpenAPI'd, conformance test suite published:

| Verb     | Path                                                              | Purpose                                  |
|----------|-------------------------------------------------------------------|------------------------------------------|
| `GET`    | `/v2/catalog`                                                     | What kinds of resources are available?   |
| `PUT`    | `/v2/service_instances/{id}`                                      | Provision a new instance                 |
| `PATCH`  | `/v2/service_instances/{id}`                                      | Update plan or parameters                |
| `DELETE` | `/v2/service_instances/{id}`                                      | Deprovision                              |
| `GET`    | `/v2/service_instances/{id}/last_operation`                       | Poll async status                        |
| `PUT`    | `/v2/service_instances/{id}/service_bindings/{binding_id}`        | Create grant for a consumer              |
| `DELETE` | `/v2/service_instances/{id}/service_bindings/{binding_id}`        | Revoke grant                             |

Five properties of OSB make it carry weight as our wire shape:

1. **Client-chosen UUIDs + idempotent PUT.** Network retries can't
   double-provision. No transaction log needed at the client.
2. **Catalog-driven discovery.** The set of available scope kinds
   is queried, not hardcoded. Brokers can extend without coordinating
   with clients.
3. **Async is opt-in via `accepts_incomplete=true`.** Same wire format
   for synchronous and asynchronous brokers. Aligns directly with the
   pending-receipt UX in
   `[[pre-post-pipelined-cloud-checks-and-failure-recovery]]`.
4. **Instances vs bindings.** The *instance* is the resource (the
   reservation, the receipt, the handoff). A *binding* is a specific
   consumer's grant of access. One instance can have many bindings —
   directly enabling shared read leases.
5. **Multi-tenancy primitives in the spec.** Provision requests carry
   `organization_guid`, `space_guid`, and a `context` block. The
   `X-Broker-API-Originating-Identity` header forwards the end user's
   identity. These exist because Cloud Foundry was multi-tenant from
   day one, and they map cleanly to workspace / cohort / human / agent.

We aren't using OSB because it's fashionable. We're using it because
the protocol shape we'd otherwise design from scratch already exists,
has been deployed at scale, and has off-the-shelf clients in every
major language.

---

## 3. Mapping the control-plane domain model to OSB

The domain model in `[[multiplayer-control-plane]]` (Task, Reservation,
Receipt, Handoff, Event, Cohort) does not need to change. OSB is the
transport; the domain model rides on top.

| Domain concept | OSB representation | Notes |
|---|---|---|
| Resource kind (file/symbol/directory/route/task/branch/capability) | OSB **service** | One service per kind. Catalog enumerates what's available to this player. |
| Mode variant (read / write / review / exclusive) + TTL | OSB **plan** | A `(service, plan)` pair fully specifies the kind of grant. |
| Reservation | OSB **service instance** | Created via `PUT /v2/service_instances/{id}` with `parameters.resource` and `parameters.reason`. |
| Grant to a specific agent | OSB **binding** | `PUT .../service_bindings/{id}` returns the signed JWT the agent presents on tool calls. |
| Receipt | OSB **service instance** of kind `receipt:*` | Bindings on the receipt represent agents subscribing to its outcome. Status transitions emit events. |
| Handoff | OSB **service instance** of kind `handoff:*` | Bindings represent participation (from-agent, to-agent). Acceptance is a transition. |
| Event log | The transition stream over all instances and bindings | Already aligned with the existing reservation event log. |
| Workspace | OSB `space_guid` | Maps 1:1. |
| Cohort | Derived from `Originating-Identity.player_id` + `space_guid` | Not a first-class OSB field; computed by the team broker. |
| Org | OSB `organization_guid` | Maps 1:1. |
| Task | OSB `parameters.task_id` on the instance | Same task can show up across many instances; the broker indexes by it. |
| Role (Lead/Worker/Test/...) | OSB `parameters.role` on bindings | Affects authorization policy; doesn't change wire shape. |

The taxonomy from `[[multiplayer-control-plane]]` survives intact.
Every Task, Reservation, Receipt, and Handoff has a stable OSB
identifier and a stable life cycle. The protocol does not invent a new
domain model; it gives the existing one a wire format.

A worked example — agent A1 reserves `src/lib/auth.ts` for a refactor:

```
PUT /v2/service_instances/<uuid-A>?accepts_incomplete=true
{
  "service_id":        "file-write-exclusive",
  "plan_id":           "30-min-default",
  "organization_guid": "acme-corp",
  "space_guid":        "ws_interlinked-cli",
  "context": {
    "platform":      "interlinked",
    "user_id":       "alice@acme.com",
    "instance_name": "A1-auth-refactor"
  },
  "parameters": {
    "resource":   "file:src/lib/auth.ts",
    "task_id":    "task_456",
    "role":       "implementation-agent",
    "reason":     "Token refresh retry fix (AUTH-123)"
  }
}
→ 202 Accepted { "operation": "op-789" }

GET /v2/service_instances/<uuid-A>/last_operation
→ { "state": "succeeded" }

PUT /v2/service_instances/<uuid-A>/service_bindings/<binding-A1>
→ 201 Created
  { "credentials": { "token": "<signed JWT>", "expires_at": "...",
                     "scope": { "resource": "file:src/lib/auth.ts",
                                "mode": "write" } } }

[Agent edits files; harness verifies token on every Edit call.]

DELETE /v2/service_instances/<uuid-A>/service_bindings/<binding-A1>
DELETE /v2/service_instances/<uuid-A>
```

The MCP tools (`reserve_resource`, `request_handoff`, etc.) defined in
`[[multiplayer-control-plane]]` are the agent-facing adapter for this.
Behind each MCP tool call sits an OSB call against the local broker.

---

## 4. The resource taxonomy as OSB services

`[[multiplayer-control-plane]]` proposes a resource namespace beyond
files: `file:`, `symbol:`, `directory:`, `route:`, `task:`, `branch:`,
`capability:`. Each maps to a service in the OSB catalog:

```json
GET /v2/catalog
{
  "services": [
    {
      "id":   "file-write-exclusive",
      "name": "file.write.exclusive",
      "description": "Exclusive write lease on file paths",
      "bindable": true,
      "plans": [
        { "id": "short-default",     "name": "5-min",  "free": true },
        { "id": "default",           "name": "30-min", "free": true },
        { "id": "long-running",      "name": "2-hour", "free": false }
      ]
    },
    {
      "id":   "file-read-shared",
      "name": "file.read.shared",
      "description": "Shared read lease (multiple bindings allowed)",
      "bindable": true,
      "plans": [...]
    },
    { "id": "symbol-write-exclusive",   "name": "symbol.write.exclusive",   ... },
    { "id": "route-write-exclusive",    "name": "route.write.exclusive",    ... },
    { "id": "branch-push",              "name": "branch.push",              ... },
    { "id": "capability-deploy-prod",   "name": "capability.deploy.prod",   ... },
    { "id": "task-claim",               "name": "task.claim",               ... },
    { "id": "receipt-cloud-review",     "name": "receipt.cloud.review",     ... },
    { "id": "handoff-request",          "name": "handoff.request",          ... }
  ]
}
```

The catalog is filtered per identity — Alice (security team) sees
`capability-deploy-prod`; Bob (intern) doesn't. The OSB spec allows
this: the broker is free to vary its response based on
`X-Broker-API-Originating-Identity`.

This is the *small validated input surface* Atlassian preached. Agents
don't ask for arbitrary capabilities; they pick from a per-identity
menu. The menu is generated by the policy compiler from
`AGENTS.md`/team policy/role constraints, exactly as
`[[multiplayer-control-plane]]` §"Policy Compiler" describes.

---

## 5. The identity chain

Every OSB request and every binding token carries the full identity
chain. Tokens are JWTs signed by the team broker; the harness verifies
signatures on every tool call.

```
binding_token (JWT, signed by team broker) = {
  "sub":        "agent:A1",
  "act":        { "sub": "user:alice@acme.com" },
  "org":        "acme-corp",
  "workspace":  "ws_interlinked-cli",
  "cohort":     "cohort:alice@acme.com:ws_interlinked-cli",
  "role":       "implementation-agent",
  "task_id":    "task_456",
  "scope": {
    "resource": "file:src/lib/auth.ts",
    "mode":     "write"
  },
  "instance_id":  "i-uuid",
  "binding_id":   "b-uuid",
  "iss":          "team-broker.acme.example",
  "iat":          1747670400,
  "exp":          1747672200
}
```

OAuth's `act` claim ("acting on behalf of") is the right vocabulary
for delegation. This token was issued to agent A1, acting on behalf of
Alice. The harness mechanically enforces three rules:

1. **Signature.** The token must verify against the team broker's
   public key (pinned trust anchor from the signed policy bundle, §13).
2. **Scope match.** The current tool call's resource and mode must lie
   within the token's `scope`. A write token on `src/lib/auth.ts` does
   not authorize an edit to `src/lib/config.ts`.
3. **Diminished delegation.** Alice can grant her agents at most the
   scope she herself holds. The local broker's binding-issuing logic
   verifies this against Alice's own active bindings.

Three concrete capabilities flow from the chain:

- **Authorization by chain prefix.** Cedar policies adjudicate on
  `principal.org`, `principal.workspace`, `principal.cohort`,
  `principal.role`, `principal.agent` — different rules for different
  levels.
- **Audit by chain.** When a problematic edit lands, the audit log
  shows the agent, the player it acted for, the workspace it scoped to,
  the role it claimed, the task it cited, and the policy version
  active at the time.
- **Forgery resistance.** Agents cannot impersonate other agents or
  escalate to other players, because they cannot mint a token signed by
  the team broker.

---

## 6. Same-cohort vs cross-cohort policy enforcement

The conflict matrix in `[[multiplayer-control-plane]]`
§"Multiplayer Conflict Policy" is the authoritative source. The OSB
layer enforces it at provision time.

When a new instance is requested, the team broker:

1. Resolves the requester's cohort from
   `X-Broker-API-Originating-Identity`.
2. Queries existing instances for the same resource (via the projection
   table maintained from the event log).
3. Applies the matrix:

| Situation (requester vs current holder) | OSB response | Event emitted |
|---|---|---|
| Same cohort, same task | 201 (with warning in `metadata`) | `same_task_warning` |
| Same cohort, different task | 202 + `last_operation` returns `in progress: ask` | `same_cohort_ask` |
| Different cohort, write-vs-write | 409 Conflict, body offers handoff endpoint | `cross_cohort_block` |
| Different cohort, write-vs-read | 201 (write allowed, read becomes `stale-pending`) | `cross_cohort_stale` |
| Capability + already reserved | 409 unless `parameters.approval_token` valid | `capability_block` |

The 409 response body offers structured continuation:

```json
{
  "error": "ConcurrencyError",
  "description": "Resource held by cohort:bob@acme.com:ws_interlinked-cli",
  "handoff_endpoint": "/v2/service_instances/handoff-h-uuid",
  "current_holder": {
    "cohort": "cohort:bob@acme.com:ws_interlinked-cli",
    "binding_id": "b-current",
    "expires_at": "2026-05-19T15:00:00Z"
  }
}
```

The agent's MCP tool turns that into a `request_handoff` flow without
the agent needing to know OSB.

---

## 7. Handoffs as OSB instances

`[[multiplayer-control-plane]]` makes handoffs first-class objects.
They map to OSB service instances of kind `handoff:*`, with bindings
representing the participating agents.

```
PUT /v2/service_instances/<handoff-uuid>?accepts_incomplete=true
{
  "service_id": "handoff-request",
  "plan_id":    "default",
  "context":    { ... B1's identity ... },
  "parameters": {
    "target_instance":  "<uuid-A>",     // A1's existing reservation
    "target_cohort":    "cohort:alice@acme.com:ws_interlinked-cli",
    "reason":           "Need src/lib/auth.ts for AUTH-200",
    "expires_at":       "2026-05-19T15:30:00Z"
  }
}
→ 202 Accepted

[Team broker notifies A1's cohort via the streaming channel (§9).]
[A1 or Alice accepts via:]

PATCH /v2/service_instances/<handoff-uuid>
{ "parameters": { "decision": "accept", "transfer": true } }

[Team broker:
   - emits `binding_transferred` transition on <uuid-A>
   - revokes A1's binding
   - issues B1 a new binding on <uuid-A>
   - emits `handoff_completed` on <handoff-uuid>]
```

The state machine on `<handoff-uuid>` is exactly the
`requested → accepted | rejected | cancelled | expired` flow from
`[[multiplayer-control-plane]]`. The instance is durable; the event
stream is replayable; the dashboard shows it as a live entity.

---

## 8. Receipts as OSB instances; specialist reviewers as bindings

Receipts in `[[multiplayer-control-plane]]` are the durable
check/review state. They map to OSB instances of kind `receipt:*`:

```
PUT /v2/service_instances/<rcpt-uuid>?accepts_incomplete=true
{
  "service_id": "receipt-cloud-review",
  "plan_id":    "multi-specialist",
  "context":    { ... triggering agent's identity ... },
  "parameters": {
    "scope":       ["file:src/lib/auth.ts"],
    "task_id":     "task_456",
    "specialists": ["security", "code-quality", "test"]
  }
}
→ 202 Accepted
```

Each specialist (Security, Code-quality, Test, Docs, Release,
Compliance, Performance — the taxonomy from
`[[multiplayer-control-plane]]` §"Phase 4/5") is dispatched as a
sub-job. Its verdict becomes a binding on the receipt:

```
PUT /v2/service_instances/<rcpt-uuid>/service_bindings/security-verdict
{
  "service_id": "receipt-cloud-review",
  "plan_id":    "multi-specialist",
  "parameters": {
    "specialist": "security",
    "verdict":    "block",
    "findings":   [ { "severity": "high", "file": "src/lib/auth.ts",
                      "line": 42, "category": "secret-handling",
                      "message": "..." } ]
  }
}
```

The receipt's overall state aggregates the bindings using the merge
rule from `[[multiplayer-control-plane]]`:

```
Any hard block          → receipt status: blocked
Any missing required    → receipt status: degraded
Warnings dedupe by file/line/category
Most severe finding wins
```

`last_operation` on the receipt reports the aggregate. Agents see the
aggregate; the dashboard sees the individual specialist bindings.

This unifies receipts with the existing reservation infrastructure —
the same projection table, the same event log, the same transition
machine, the same OSB endpoints. No parallel "receipts API" exists.
Just instances of a different kind.

---

## 9. Latency calibration

A frequent claim in the Tier 2 design is that 3–6s is "too slow to
block" on every tool call. That framing is overstated. The honest
version:

- A single 5s wait is not intrinsically painful. It's roughly the
  thinking time of a human reviewer on a non-trivial decision.
- **Cumulative cost matters.** A typical coding session is 100–500
  tool calls. A blanket 5s gate adds 8–40 minutes of pure wall-clock
  blocking per session. That turns the agent from collaborator into
  forms-submission process.
- **The distribution is bimodal.** Probably 90%+ of tool calls are
  obviously safe (reading a file the agent already touched, listing a
  directory, running `npm test`). The remaining ~5–10% — writes to
  sensitive paths, destructive commands, network egress — are the
  calls where 5s of consultation is actually useful.

Architectural conclusion is two-pronged:

1. **Don't pay the cloud-gate cost on calls that don't need it.**
   Tier 1 (local, deterministic, sub-10ms) decides which calls warrant
   consultation. The vast majority skip the gate.
2. **For calls that do warrant cloud consultation, don't make the wait
   blocking by default.** Allow optimistically (binding issued), run
   the cloud review against the receipt in the background, roll back
   if the verdict comes back negative. The agent's wall-clock cost
   approaches zero; the consultation happens in parallel.

For some operations — destructive commands, push, deploy, edits to
secrets — synchronous blocking on a small set of high-risk calls is
the *desired* behavior. The protocol must support both shapes; the
async path is the default; configuration forces synchronous blocking
on a designated subset.

This is the same architectural choice Atlassian made for provisioning:
slow operations are async, fast operations are sync, both speak the
same OSB wire format.

---

## 10. The two-loop control split

Atlassian deliberately split the provisioning loop (developer → broker
→ worker → state) from the config-distribution loop (Sovereign polls
state → renders templates → serves xDS to proxies). The two loops scale
and fail independently.

Mapped to Interlinked:

- **Provisioning loop:** agent → MCP tool → local broker → team
  broker → durable state (reservation / receipt / handoff instance).
  Same wire format throughout: OSB.
- **Distribution loop:** team broker → streaming channel → local
  brokers → agents. Pushes policy updates, contention notifications,
  and projection deltas.

The two loops share the same event log but are otherwise decoupled. The
distribution loop can be down (degraded notifications) while the
provisioning loop continues. The provisioning loop can be slow on a
busy backend while the distribution loop keeps streaming
last-known-good state.

The Realtime Gateway in `[[multiplayer-control-plane]]` is the
distribution-loop endpoint. The Task Broker, Reservation Manager, and
Check Orchestrator are the provisioning-loop backends.

---

## 11. The transition machine as the unifying primitive

The existing `src/harness/reservations.ts` already implements the
right pattern for OSB-style optimistic-with-rollback:

- Optimistic local grant.
- Async server confirm.
- Rollback on server reject, with an explicit `conflict` event
  carrying `conflict_reason`.
- `replayTransitions(events)` for replay/live parity.
- Property tests in `src/harness/__tests__/reservations.test.ts` using
  `fast-check` to assert replay==live, no double-grant, idempotent
  release.

What's missing is that it only handles file-scope reservations.
Proposal: generalize the discriminated `ReservationTxn` union into a
broader `HarnessTxn` covering:

- File / symbol / directory / route / branch / capability grants
  (today, extended).
- Receipt transitions (pending → running → complete / failed /
  superseded).
- Tier 2 verdicts (`tier2_allow`, `tier2_reject`, `tier2_advisory`).
- Tier 3 verdicts (`tier3_block`, `tier3_warn`, `tier3_advisory`).
- Handoff transitions (requested → accepted / rejected / expired,
  binding_transferred).
- Cross-cohort eviction (`evicted_remote` exists; extend with
  `evicted_by_priority`, `evicted_by_player`).
- Policy version transitions (`policy_version_bumped`).

One state machine, one `applyTransition(state, txn)` function, one
audit log (`reservation-events.jsonl` → `harness-events.jsonl`). Live
execution and replay both flow through the same dispatch. The
recurrence aggregator at `src/harness/recurrence.ts` already consumes
that log; it gets cross-tier visibility for free.

This is the load-bearing unification: when a cloud verdict comes back
negative on an optimistically-allowed tool call, the rollback uses the
same transition machinery, the same event format, and the same
`conflict_reason` field that file-scope rejections already emit.

---

## 12. xDS-style streaming for the distribution loop

The Realtime Gateway in `[[multiplayer-control-plane]]` is sketched at
"Durable Object WebSockets / hibernation." The protocol design borrows
from Envoy's xDS, which Atlassian ran at 2,000-proxy × 13-region scale:

- **State-of-the-world stream** for cold start. A booting harness pulls
  the full materialized snapshot.
- **Delta stream** for steady state. Only changed resources are pushed.
- **Aggregated discovery (ADS)** — a single connection carries all
  resource types in a defined order.
- **ACK / NACK semantics** so the team broker knows which version each
  harness has applied successfully. NACKs surface in operations.

Transport choice — Server-Sent Events over HTTP/2:

- Browser-friendly (the web dashboard subscribes to the same stream).
- Corporate-proxy-friendly (gRPC tends to break through enterprise
  proxies).
- One-directional from server to client matches the use case; the
  client sends ACKs on the back-channel REST API.
- Cloudflare Workers' WebSocket hibernation handles the at-rest case
  cheaply.

This becomes the load-bearing fleet primitive: a `policy_version` that
every harness knows it has, and a way for the team broker to bump it
across the fleet in seconds rather than hours.

---

## 13. Order of operations — Cedar before the rules that cite it

Atlassian's xDS protocol has a subtle invariant: clusters arrive before
routes that reference them, or a route points at a nonexistent cluster
and traffic dies. The same problem exists for Interlinked: a
`distilled-rules.json` entry that references a Cedar predicate must not
be installed before the Cedar file it depends on, or the predicate
evaluates as "unknown" and the rule misfires.

**Binding.** The distribution-loop snapshot is an ordered tuple
**(cedar_files, distilled_rules, overrides, catalog)** applied
transactionally. A harness either applies the whole snapshot or none
of it. Partial application is forbidden.

The same applies to the policy compiler outputs in
`[[multiplayer-control-plane]]`: when the compiler emits a new bundle
of (executable rules, Cedar policies, reviewer prompts, sandbox
workflow plans, required receipts), that bundle is the atomic unit.
Either it deploys whole or it stays at the previous version.

This is also what makes rollback safe: the last-known-good snapshot is
always a coherent tuple, never a half-applied state.

---

## 14. The valid-but-harmful failure mode

The hardest production lesson from the Atlassian talk: their worst
incidents weren't malformed config. They were config that was
syntactically valid, passed every validation check, and silently
broke live traffic.

Translated to Tier 2: the LLM safety judge can return a confident,
well-formed verdict that is semantically wrong. You cannot unit-test
your way out of this — the verdict is well-formed by construction.

`[[multiplayer-control-plane]]` lists "Valid check config causes harm
→ canary/shadow mode before enforcement" in its failure-mode table.
This section expands that into a concrete mitigation kit.

Three mitigations, all borrowed from Atlassian's playbook:

1. **Canary rollout.** When upgrading the safeguard model, the
   prompt, or the prefix-cache key derivation, route only N% of
   verdicts to the new pipeline. Compare against the previous pipeline
   on the same inputs. Promote only after divergence stays under a
   threshold for a calibration window. This is the same `shadow →
   enforce` cadence in `[[tier-2-llm-policy-gate]]`, made explicit at
   pipeline-version boundaries.
2. **Two-of-three voting for high-blast-radius operations.** For
   PreToolUse blocks on destructive Bash, force pushes, broad write
   scopes, deploy capabilities — require deterministic Cedar +
   classifier-A + classifier-B (different model or different prompt)
   to agree before enforcing. Single Tier 2 verdict is allowed for
   advisory feedback but not for blocks.
3. **Behavioral observability over verdict correctness.** Track
   agent-side metrics — task completion rate, retry rate,
   reservation-conflict rate, bypass rate — with Tier 2 enforce *on*
   vs *off*. A drop in completion rate when enforce is on is the
   "verdicts are silently wrong" signal, even if each individual
   verdict looks reasonable.

The third one matters most. Atlassian couldn't unit-test "valid config
destroys traffic" — they had to watch production *behavior* of the
proxy fleet. The analog here is watching the *behavior* of the agent
population, not the individual verdict text.

---

## 15. The sidecar pattern for the cloud client

Atlassian's authentication, authorization, and rate-limiting sidecars
ran as separate local processes alongside Envoy on the same host,
talking to Envoy through `ext_authz` and `ext_proc`. The benefits:

- Independent crash domain.
- Independent language choice (Atlassian's authn sidecar was Rust).
- Independent release cadence.
- Connection pooling — long-lived HTTP/2 connections live in the
  sidecar, amortized across many tool calls.

Proposal: the code that calls Tier 2 / Tier 3 cloud providers is a
**separate process** from the harness daemon, talking over the existing
daemon protocol. The daemon-client split at
`src/harness/daemon-protocol.ts` already has half of this pattern; the
"cloud sidecar" is a third process the harness daemon proxies to.

Concrete benefits:

- **Prompt-cache stickiness.** A single long-lived TCP connection to
  the safeguard provider preserves prefix-cache hits across tool calls
  within a session. Cold connections lose this.
- **Provider swap without harness change.** A/B between safeguard
  providers by deploying a new sidecar version.
- **Predictable latency.** Rust on the hot path, no GC pauses.
- **Isolation from SDK churn.** Anthropic / OpenAI / OSS SDK updates
  don't touch the harness daemon's dependency surface.

This is what the Check Orchestrator in `[[multiplayer-control-plane]]`
talks to. The orchestrator decides *what* to dispatch; the sidecar
handles the *how* of network I/O.

---

## 16. Signed policy bundles for enterprise rollout

`[[multiplayer-control-plane]]` §"Policy Compiler" describes the
compiler outputs (executable rules, Cedar policies, reviewer prompts,
sandbox workflow plans, required receipts, task templates, role
scopes). This section pins down *how those outputs are distributed*.

Atlassian shipped Envoy as a "golden AMI" — sealed, versioned, signed,
with secrets injected separately at boot via CloudFormation parameters.
The Interlinked analog is a **signed policy bundle**:

```
acme-policies-v3.2.0.tar.gz
  ├── distilled-rules.json
  ├── policies/
  │   ├── disk-forensics.policy.md
  │   ├── disk-forensics.cedar
  │   └── disk-forensics.interlinked.cedar
  ├── check-config.json
  ├── catalog.json           # OSB services this org offers
  ├── reviewer-prompts/      # specialist prompts (from policy compiler)
  ├── sandbox-workflows/     # workflow plans for cloud receipts
  ├── role-scopes.json       # what each role is allowed
  ├── task-templates/
  └── manifest.json          # version, signature, signing key id
```

Properties:

- Signed by the org's policy admin's key. Each harness has a pinned
  trust anchor; verification happens on download.
- Versioned; harnesses pin to a channel (`acme-corp/stable`,
  `acme-corp/canary`) and roll forward atomically.
- **Secrets are not in the bundle.** Org API tokens are fetched
  separately at harness startup via OAuth (`lib/auth.ts`).
- Distributable via the team broker's catalog endpoint or via a CDN.
  CDN caching matters: cold-start harness pulls a fresh bundle in 50ms
  on a regional cache hit, not seconds.
- The team broker's served catalog is *derived* from the bundle. Two
  players in the same org on the same bundle version see the same
  catalog. Different orgs on different bundles see different catalogs.

---

## 17. Make the safe path the only path — and the bypass loud

`[[multiplayer-control-plane]]` §"Safe Path Only Path" already takes
the right position: risky actions go through explicit gates, bypass is
loud and audited. This section adds the wire-level enforcement.

Today the harness fails *open* when the daemon is unreachable. That's
right for an individual developer experimenting on a laptop. It's
wrong for an enterprise where the admin needs to know that every agent
action passed through the rule set.

The mechanism already exists — `e2e-cold-fallback.mjs` verifies that
fail-closed works. The cultural move is making fail-closed the
*default* for enterprise distributions:

- The signed policy bundle has a `harness_unreachable: "fail_closed"`
  flag.
- Hooks installed under that bundle refuse to proceed when the daemon
  is unreachable.
- Bypass is gated by the OSB layer too: a bypass attempt is itself an
  OSB provision request (`capability:bypass` service), the team broker
  decides, the binding is signed, the bypass event lands in the audit
  log with reason + identity chain + scope.

This must be a configuration choice per deployment, not a one-way
ratchet. Individual developers keep fail-open. Enterprise distributions
default to fail-closed. The *deployment mode*, not the global default,
drives the behavior.

---

## 18. Connection to existing Interlinked code

The architecture is largely a relabeling and extension of code that
already exists. Best-effort accuracy map against the current tree:

| Existing                                  | Becomes                                                  |
|-------------------------------------------|----------------------------------------------------------|
| `src/harness/reservations.ts`             | Local broker's instance/binding store + transition log   |
| `src/harness/cohort.ts`                   | Local broker's per-cohort sub-allocation logic           |
| `src/harness/server.ts` (Unix socket)     | Local broker's REST endpoint surface (add OSB endpoints) |
| `src/harness/server-bridge.ts`            | Local broker → team broker delegation client             |
| `src/harness/rules-loader.ts`             | Subscriber to the xDS distribution stream                |
| `src/harness/recurrence.ts`               | Cross-cohort churn / coupling aggregation                |
| `src/commands/checks.ts` (receipt-aware)  | Receipt service kind on the team broker                  |
| `lib/auth.ts` (OAuth)                     | Player identity → Originating-Identity header            |
| `.interlinked/config.local.json`          | Player + org binding, active-server selection            |
| `e2e-cold-fallback.mjs`                   | Fail-closed enforcement (already passes)                 |
| (new on server)                           | Workspace + Cohort Coordinators (`[[multiplayer-control-plane]]`) |
| (new on server)                           | OSB endpoint surface on the team broker                  |
| (new on server)                           | Streaming distribution channel (SSE/HTTP2)               |
| (new local process)                       | Cloud sidecar (Tier 2/3 client)                          |
| (new build pipeline)                      | Policy bundle signer (consumes policy compiler outputs)  |

Three independently-shippable units:

1. Generalize the transition machine + add OSB endpoints to the local
   broker. Pure local work; ships single-player first.
2. Build the team broker on the MCP server. Catalog, provisioning,
   binding signing, contention resolution. Goes live for multi-player.
3. Add the cloud sidecar and the streaming distribution channel.
   Independent of 1 and 2; pure performance / fleet-scaling wins.

---

## 19. What this is NOT

- **Not a replacement for `[[multiplayer-control-plane]]`.** That doc
  defines the architecture and domain model; this one defines the
  wire format and mechanisms.
- **Not a replacement for MCP.** MCP remains the agent-facing protocol
  adapter. OSB is the wire shape *behind* MCP tools, between local
  brokers and the team broker, and between harnesses for contention
  notifications. Agents speak MCP; the system speaks OSB underneath.
- **Not a replacement for Cedar.** Cedar adjudicates; OSB transports.
  They compose.
- **Not forcing multi-player on every Interlinked deployment.**
  Single-player is the local broker running standalone with the team
  broker endpoint set to itself. Same wire format, smaller graph.
- **Not a new RPC framework.** OSB is REST over HTTP/HTTPS; the
  streaming channel is SSE over HTTP/2. Both traverse corporate
  proxies.
- **Not a custom token format.** Binding tokens are JWTs signed by the
  team broker using OAuth's `act` claim. No invention.
- **Not removing fail-open mode.** Fail-open remains the default for
  individual developers. The *enterprise distribution mode* defaults
  to fail-closed.

---

## 20. Open questions

(Trimmed; `[[multiplayer-control-plane]]` has its own open-questions
section that this complements rather than duplicates.)

1. **Streaming transport.** SSE-over-HTTP/2 vs WebSockets. SSE is the
   safest for corporate-proxy traversal; WebSockets fit Cloudflare's
   hibernation model better. Probably ship SSE first.
2. **Binding token TTL.** Default 30 minutes, with renewal via PATCH
   on the instance. How do agents renew before expiry without
   round-tripping the team broker on every renewal?
3. **In-flight bindings on policy bump.** When the bundle version bumps
   mid-session, are in-flight bindings issued under the old catalog
   honored until expiry, or invalidated immediately? Atlassian's
   answer: in-flight is honored. Same default proposed here.
4. **Preemption signal.** When a binding is preempted by a higher-
   priority handoff or by org policy, what signal does the harness
   give the agent? Synchronous error on the next tool call, or
   out-of-band cancellation? Probably both, with metadata.
5. **Cross-broker federation.** A contractor working across two orgs:
   federated team brokers, single super-broker, or out of scope?
   Out of scope for v1.
6. **Heartbeat granularity.** Per-binding heartbeat at what frequency?
   Default 30s with 2-minute TTL.
7. **Where the JWT signing key lives.** HSM-backed KMS for enterprise,
   software keys for self-hosted. Rotation cadence.

---

## 21. Implementation order

Aligned with the "First Build Slice" in `[[multiplayer-control-plane]]`
(steps 1–10 there), this is the protocol/mechanism side that pairs
with it.

A. **Generalize the reservation transition machine.** Extend
   `ReservationTxn` to `HarnessTxn`, add receipt / Tier 2 verdict /
   handoff / eviction / policy-version transitions. Pure local
   refactor. Property tests extend. *Pairs with steps 1, 3 of the
   First Build Slice.*

B. **Add OSB endpoint surface to the harness daemon.** Wrap the
   existing reservation store in a REST API matching OSB shape.
   Single-player still works; the daemon is now its own local broker.
   *Pairs with steps 8, 9.*

C. **Stand up the team broker on the MCP server.** Catalog endpoint,
   provisioning endpoint, binding signing, contention resolution
   using the conflict matrix. *Pairs with steps 2, 4.*

D. **Wire identity through.** OAuth player identity flows into
   `Originating-Identity` header; binding tokens carry the chain.
   *Pairs with step 2.*

E. **Receipt service kind on the team broker.** Local-only receipts
   first, then one cloud-workflow specialist. *Pairs with steps 6, 10.*

F. **Handoff service kind on the team broker.** Plus the dashboard
   surface for accepting handoffs. *Pairs with steps 5, 7.*

G. **Cloud sidecar process.** Extract Tier 2/3 client from the harness
   daemon. Connection pooling, prompt-cache stickiness, independent
   crash domain.

H. **SSE streaming distribution channel.** Push policy updates and
   contention notifications to local brokers in seconds.

I. **Signed policy bundle pipeline.** Build, sign, distribute. Trust
   anchor configuration on the harness.

J. **Canary + two-of-three voting + behavioral observability for
   Tier 2.** The valid-but-harmful mitigation kit.

K. **Cross-cohort churn aggregation in `recurrence.ts`.**

A–B unblock everything else without server-side change. C–F require
server-side build but compose cleanly. G–K are smaller independent
improvements that can land in any order.

---

## Sources

- Vasilios Syrakis, *"I was laid off by Atlassian"* (whiteboard talk,
  2026-05-10) — extraction at
  `/Users/quentincody/local-model-development/docs/atlassian-edge-platform-video-extraction.md`
  and architecture summary at
  `/Users/quentincody/local-model-development/docs/atlassian-envoy-architecture.md`
- Open Service Broker API spec — `github.com/openservicebrokerapi/servicebroker`
- Envoy xDS protocol — `www.envoyproxy.io/docs/envoy/latest/api-docs/xds_protocol`
- Cedar policy engine — `www.cedarpolicy.com`
- OAuth `act` claim (delegation) — RFC 8693

## Related Interlinked design docs

- `[[multiplayer-control-plane]]` — the architectural blueprint this
  doc provides the protocol layer for. **Read first.**
- `[[tier-2-llm-policy-gate]]` — the cloud-LLM safety gate whose
  verdicts this protocol carries as receipt transitions
- `[[three-tier-architecture-v2]]` — Tier 1/2/3 detection/decision
  separation
- `[[tier-3-async-deep-review]]` — supermodel review at pre-push,
  served as a receipt instance
- `[[multi-agent-pre-push-review]]` — Cloud-Sandbox-based multi-
  specialist reviewer pattern this routes through receipts
- `[[pre-post-pipelined-cloud-checks-and-failure-recovery]]` — the
  receipt-ID and async-reconciliation primitives this generalizes
- `[[multi-edit-atomic-coordinated-edits]]` — multi-site atomic edit
  primitive that becomes a same-cohort coordination case
- `[[cf-sandbox-egress-proxy-pattern]]` — egress proxy for cloud-side
  specialist reviewers
