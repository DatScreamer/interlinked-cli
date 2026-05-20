# Multiplayer Control Plane

**Status:** Design sketch / greenfield architecture.
**Scope:** A from-scratch Interlinked server architecture for multiplayer AI-assisted development, where each human can manage multiple agents and the system coordinates tasks, reservations, checks, reviews, handoffs, and audit state.
**Audience:** Engineering and product design. This document intentionally does not assume the current Interlinked MCP Server is the final server shape.

---

## TL;DR

Interlinked should be designed as a **multiplayer orchestration control plane**, not as "an MCP server with some coordination features."

MCP is one protocol adapter. The core product is the shared system that knows:

- which humans are participating
- which agents belong to each human
- what work each agent is assigned
- which files, symbols, routes, tasks, and capabilities are reserved
- which checks are pending or failed
- which risky actions were approved or bypassed
- where handoffs and conflicts exist
- what actually happened, in timestamped order

The greenfield shape:

```text
Humans + agents + local harnesses
        |
        v
Interlinked Multiplayer Control Plane
        |
        +-- team broker
        +-- local broker federation
        +-- task broker
        +-- reservation and binding manager
        +-- event log and projections
        +-- policy/check compiler
        +-- receipt/check orchestrator
        +-- handoff/message router
        +-- streaming policy distribution
        +-- live workspace dashboard
        |
        v
Protocol adapters:
  MCP tools
  CLI hooks
  web UI
  GitHub/CI
  cloud sandboxes
  future agent runtimes
```

The durable event log, reservations, tasks, receipts, and human-agent cohorts are the real system. MCP is an interface into that system.

The broker layer should use an **Open Service Broker-shaped protocol** for scope reservations and grants. OSB gives us a proven vocabulary for exactly the thing multiplayer agent work needs: catalog, provision, poll, bind, update, and deprovision. Interlinked does not need to copy Cloud Foundry or Kubernetes Service Catalog wholesale, but it should borrow the wire shape because it already models multi-tenant async resource grants.

---

## Background: What We Are Borrowing From Atlassian

Atlassian is the company behind Jira, Confluence, Bitbucket, Statuspage, and related cloud products. The source material described an internal Atlassian edge platform that let product teams expose services to the public internet without opening tickets for manual load-balancer work.

The platform was roughly:

```text
Developer service config
        |
        v
Open Service Broker API
        |
        | async provisioning task
        v
SQS -> worker
        |
        v
DynamoDB desired/current state
        |
        v
Sovereign Envoy control plane
        |
        | rendered dynamic Envoy config
        v
Envoy proxy fleet
        |
        v
Backend services
```

The important part is not Envoy, SQS, DynamoDB, CloudFormation, or AMIs. Those were Atlassian's implementation details.

The reusable pattern is:

```text
Declarative intent
        |
        v
Validated platform API
        |
        v
Asynchronous workflow
        |
        v
Durable desired/current state
        |
        v
Dynamic control plane
        |
        v
Long-lived data plane
        |
        v
Centralized shared capabilities
```

Atlassian exposed a small, validated developer-facing input surface, then generated powerful runtime behavior centrally. Developers did not write raw Envoy config. They submitted constrained parameters. The platform validated those parameters and rendered safe Envoy resources from templates and dynamic context.

That is the design lesson for Interlinked.

Interlinked should not let every agent, skill, plugin, or team invent its own coordination semantics. It should expose a small, explicit intent surface and compile that into:

- local harness decisions
- cloud policy evaluations
- async check workflows
- reviewer plans
- sandbox jobs
- reservations
- task assignments
- dashboard state
- audit records

The broker orchestration layer sharpens that lesson:

```text
Narrow request:
  "reserve this scope for this human's agent"

Validated broker workflow:
  catalog -> provision -> last_operation -> bind -> heartbeat -> release

Generated runtime authority:
  signed binding token, local harness cache, streaming policy updates,
  receipt requirements, and audit events
```

This is the same safety move Atlassian made with Envoy. Developers did not write raw proxy config; they requested a platform capability. Agents should not mutate shared workspaces by informal convention; they should request explicit scopes of work.

---

## Product Thesis

A human developer will increasingly manage a small team of agents, not one agent.

Example:

```text
Human A
  lead-agent
  implementation-agent
  test-agent
  review-agent
  research-agent

Human B
  bugfix-agent
  docs-agent
  security-agent
```

When multiple humans do this in the same workspace, coordination cannot live inside any single chat session. It needs a shared control plane.

The core product feel should be closer to a live operations board than a chat transcript:

```text
Workspace: interlinked-cli

Human A
  A1 implementation-agent    active     editing src/lib/auth.ts
  A2 test-agent              idle       waiting on A1
  A3 review-agent            blocked    waiting for rcpt_123

Human B
  B1 docs-agent              active     editing docs/architecture.md
  B2 security-agent          reviewing  task_789

Conflicts
  B1 requested handoff for src/lib/auth.ts

Pending checks
  rcpt_123 cloud review      running    41s
  rcpt_124 type impact       failed     1 finding
```

The server is the referee, scheduler, audit log, shared map, and policy distribution system.

---

## Core Architecture

```text
                         CONTROL PLANE
┌──────────────────────────────────────────────────────────────────┐
│ Interlinked Multiplayer Control Plane                            │
│                                                                  │
│  Workspace Coordinator                                           │
│    - authoritative event log                                     │
│    - current projections                                         │
│    - workspace policy                                            │
│                                                                  │
│  Human Cohort Coordinator                                        │
│    - one human's agent set                                       │
│    - roles, sessions, health, local leases                       │
│                                                                  │
│  Task Broker                                                     │
│    - task graph                                                  │
│    - assignments                                                 │
│    - dependencies                                                │
│    - handoffs                                                    │
│                                                                  │
│  Reservation Manager                                             │
│    - files, symbols, directories, routes, tasks, capabilities    │
│    - lease TTLs and heartbeats                                   │
│                                                                  │
│  Check Orchestrator                                              │
│    - receipts                                                    │
│    - cloud workflows                                             │
│    - sandbox jobs                                                │
│    - multi-agent reviews                                         │
│                                                                  │
│  Policy Compiler                                                 │
│    - AGENTS.md / skills / team policy                            │
│    - executable rules                                            │
│    - reviewer plans                                              │
│    - workflow plans                                              │
│                                                                  │
│  Realtime Gateway                                                │
│    - dashboard                                                   │
│    - harness sync                                                │
│    - agent state updates                                         │
└──────────────────────────────────────────────────────────────────┘
            ▲                         │
            │                         ▼
┌───────────────────────┐     ┌────────────────────────────────────┐
│ Local data planes      │     │ Cloud data planes                  │
│ - CLI hooks            │     │ - sandboxes                        │
│ - local harnesses      │     │ - CI jobs                          │
│ - local agents         │     │ - multi-agent reviewers            │
│ - git worktrees        │     │ - long-running checks              │
└───────────────────────┘     └────────────────────────────────────┘
```

The control plane decides ownership, policy, orchestration, and shared state. The data planes execute work.

The local harness remains fast and low-latency. It should not be the entire multiplayer brain. It should cache server state, enforce local policy quickly, and sync observations upward.

---

## Broker Model

The control plane should expose a broker abstraction for multiplayer scopes. A scope is any named thing an agent can request authority over:

```text
file:src/lib/auth.ts
symbol:resolveAuthTokenWithRefresh
directory:src/harness/checks
route:POST /api/hooks/activity/batch
task:receipt-plumbing
branch:feature/auth-refresh
capability:deploy-production
budget:tier2-llm
egress:api.github.com
```

The Open Service Broker API is a useful shape for this because it already separates the resource from the consumer grant:

| OSB concept | Interlinked meaning |
|---|---|
| Service | A scope kind, such as `file-write-exclusive`, `file-read-shared`, `exec-budget`, `network-egress` |
| Plan | A variant, such as 5-minute edit, 30-minute task, long-running review, no-preempt |
| Catalog | The scope kinds currently available to this human/cohort/workspace |
| Service instance | A concrete reservation over a scope |
| Last operation | Async status for a requested reservation or check |
| Binding | A signed grant token for a specific agent/session |
| Update | Extend, narrow, move, or change priority for a reservation |
| Deprovision | Release the reservation |

The useful OSB properties:

- client-chosen IDs and idempotent `PUT` make retries safe
- catalog discovery avoids hardcoded scope types
- `accepts_incomplete=true` models async grants without inventing a second protocol
- instance vs binding lets multiple agents share a resource under controlled modes
- org/workspace/user identity can ride in request context and originating-identity headers

The protocol flow for a write scope:

```text
1. Local broker asks team broker for catalog.
2. Agent requests file-write-exclusive for src/auth/**.
3. Team broker validates identity, policy, conflicts, priority, and task scope.
4. If uncontested, broker grants immediately.
5. If contested or high risk, broker returns async operation status.
6. Agent/local broker polls or subscribes for completion.
7. Agent creates a binding and receives a signed grant token.
8. Local harness verifies that token on every relevant tool call.
9. Binding heartbeats while active.
10. Binding and reservation are released or expire.
```

This gives Interlinked a single vocabulary for file reservations, capability grants, execution budgets, cloud-check authority, and future resource types.

---

## Nested Brokers

Multiplayer needs two broker layers, not one giant broker that talks to every agent directly.

```text
                         Org policy + cross-player coordination
                         ┌────────────────────────────────────┐
                         │          Team Broker               │
                         │  - global catalog                  │
                         │  - active reservations             │
                         │  - cross-player conflict policy    │
                         │  - binding token signer            │
                         │  - receipt/block state             │
                         └──────┬────────────────┬────────────┘
                                │                │
                                │ broker protocol│
                                │                │
              ┌─────────────────▼──┐          ┌──▼─────────────────┐
              │ Alice Local Broker │          │ Bob Local Broker   │
              │ - cohort state     │          │ - cohort state     │
              │ - sub-allocation   │          │ - sub-allocation   │
              │ - fast enforcement │          │ - fast enforcement │
              └──┬────┬────┬───────┘          └──┬────┬────────────┘
                 │    │    │                     │    │
                A1   A2   A3                    B1   B2
```

**Team broker.** The authoritative multiplayer service. It owns cross-human state: org policy, workspace catalog, active reservations, receipts, handoffs, global budgets, and audit.

**Local broker.** The per-human harness/cohort service. It owns local fast-path decisions: same-human sub-allocation, per-agent scope, cached grants, local heartbeats, local replay, and offline operation.

Why this split matters:

- **Latency:** Alice's agents can coordinate with each other locally without a network round trip.
- **Offline survival:** a local broker can keep operating inside pre-granted scopes and reconcile later.
- **Privacy:** the team broker may only need to know Alice holds `src/auth/**`; the per-agent split can remain local.
- **Scale:** one broker per human cohort is simpler than one hot service handling every agent connection.

This is the Atlassian control-plane/data-plane split adapted to agent work. The team broker is the aggregate control plane. Local brokers are programmable data-plane nodes with cached authority.

---

## Control Plane vs Data Plane

The split should be explicit:

| Layer | Role | Examples |
|---|---|---|
| Control plane | Decides desired state, policy, ownership, workflow, audit | task broker, reservations, receipts, policy compiler |
| Local data plane | Executes local agent actions and fast checks | file edits, shell commands, local harness decisions |
| Cloud data plane | Executes slow or shared jobs | deep review, sandbox test runs, mutation, SBOM, CI |
| Protocol adapters | Let clients talk to the control plane | MCP, CLI hook HTTP, browser UI, GitHub webhooks |

This is the main Atlassian transfer:

```text
Atlassian control plane: broker + Sovereign templates + state
Atlassian data plane: Envoy proxy fleet + sidecars

Interlinked control plane: tasks + reservations + policy/check compiler + receipts
Interlinked data plane: local harnesses + agents + cloud sandboxes + reviewers
```

---

## Core Domain Model

### Workspace

A workspace is the multiplayer boundary.

It owns:

- event log
- humans
- agents
- tasks
- reservations
- receipts
- messages
- handoffs
- approvals
- findings
- policies
- projections

### Human

A human is the owner of one or more agents.

Humans matter because conflict policy differs depending on whether two agents belong to the same human or different humans.

### Cohort

A cohort is one human's active agent set in a workspace.

```text
Cohort
  human_id
  workspace_id
  agents[]
  active_sessions[]
  local_harnesses[]
  current_tasks[]
```

Same-cohort conflicts are usually warnings or asks. Cross-cohort conflicts are usually blocks unless a handoff or shared lease exists.

### Agent

An agent has:

- `agent_id`
- `human_id`
- `cohort_id`
- `workspace_id`
- `session_id`
- `role`
- `active_task_id`
- `allowed_scope`
- `status`
- `last_seen_at`

Roles should be explicit:

| Role | Expected behavior |
|---|---|
| Lead | Owns plan, decomposition, integration, status |
| Worker | Edits scoped files for one task |
| Test | Writes/runs tests and verifies behavior |
| Review | Reviews diffs and findings |
| Research | Reads docs/code and summarizes, normally no writes |
| Release | Handles push/PR/deploy actions under stricter policy |

Role should affect policy. A research agent should not silently start writing production code. A worker agent assigned to tests should not edit core implementation without scope expansion.

### Identity Chain

Every broker request and binding token should carry the full chain:

```text
org -> workspace -> human/player -> cohort -> agent -> session
```

The binding token is the runtime proof that an agent may act on a scope.

```json
{
  "sub": "agent:agent_a1",
  "act": { "sub": "user:alice@example.com" },
  "org": "acme-corp",
  "workspace": "interlinked-cli",
  "cohort": "cohort_alice",
  "session": "session_123",
  "scope": {
    "resources": ["file:src/lib/auth.ts"],
    "ops": ["read", "write"]
  },
  "reservation_id": "res_123",
  "binding_id": "bind_456",
  "policy_version": "acme-policies-v3.2.0",
  "iss": "team-broker.acme.example",
  "iat": 1747670400,
  "exp": 1747672200
}
```

The `act` claim is the important vocabulary: the agent is acting on behalf of the human. The local broker verifies the token signature and scope on every relevant tool call. Agents cannot self-assign another human's authority because only the team broker signs binding tokens.

The chain enables:

- authorization by org, workspace, human, cohort, agent, and role
- audit that names both the agent and accountable human
- diminished delegation, where a local broker can grant only a subset of what the human/cohort already holds
- budget enforcement at both human and team levels
- privacy filtering by chain prefix

### Task

A task is a unit of intended work.

```typescript
interface Task {
    task_id: string;
    workspace_id: string;
    title: string;
    goal: string;
    owner_human_id: string;
    status: "open" | "claimed" | "in_progress" | "blocked" | "review" | "done" | "cancelled";
    allowed_resources: ResourceRef[];
    assigned_agents: AgentAssignment[];
    dependencies: string[];
    required_receipts: ReceiptRequirement[];
    created_at: string;
    updated_at: string;
}
```

Tasks are how the server knows why an agent is acting.

### Reservation

Reservations are the multiplayer locking system.

They should support resources beyond files:

```text
file:src/lib/auth.ts
symbol:resolveAuthTokenWithRefresh
directory:src/harness/checks
route:POST /api/hooks/activity/batch
task:receipt-plumbing
branch:feature/auth-refresh
capability:deploy-production
```

In broker terms, a reservation is the **service instance**. A binding is the **agent/session grant** that consumes that reservation.

Each reservation has:

- resource
- mode: `read`, `write`, `review`, `exclusive`
- owner human
- owner agent
- task
- TTL
- heartbeat
- reason
- conflict policy
- priority
- preemption policy
- policy version

Example:

```json
{
  "reservation_id": "res_123",
  "workspace_id": "ws_123",
  "human_id": "user_a",
  "agent_id": "agent_a1",
  "task_id": "task_456",
  "resource": "file:src/lib/auth.ts",
  "mode": "write",
  "priority": "normal",
  "ttl_ms": 300000,
  "reason": "Implement token refresh retry fix",
  "policy_version": "acme-policies-v3.2.0",
  "created_at": "2026-05-19T14:30:00Z",
  "expires_at": "2026-05-19T14:35:00Z"
}
```

Bindings should heartbeat independently. If Alice's machine dies, the team broker should release only the bindings that stopped heartbeating, not every reservation associated with Alice. A reservation may remain valid while individual bindings come and go.

Priority and preemption are explicit policy decisions. A release-agent handling a production rollback may be allowed to preempt a normal implementation-agent's write scope. That preemption should emit a visible transition such as `evicted_by_priority`, not silently revoke the local token.

### Receipt

A receipt is durable check/review state.

Receipts turn checks into shared multiplayer coordination signals.

```typescript
interface Receipt {
    receipt_id: string;
    workspace_id: string;
    task_id?: string;
    triggered_by: {
        human_id: string;
        agent_id: string;
        session_id: string;
    };
    scope: ResourceRef[];
    kind: "local-check" | "cloud-review" | "sandbox-test" | "mutation" | "sbom" | "policy";
    status: "pending" | "running" | "complete" | "failed" | "cancelled" | "superseded";
    findings: Finding[];
    blocks: BlockTarget[];
    created_at: string;
    updated_at: string;
}
```

If an agent tries to push while a required receipt is pending or failed, the server can block or ask. If another agent starts related work, the server can warn that a relevant receipt is still pending.

### Event

Every meaningful fact should be an append-only event.

```json
{
  "event_id": "evt_123",
  "type": "file.reserved",
  "workspace_id": "ws_123",
  "human_id": "user_a",
  "agent_id": "agent_a1",
  "task_id": "task_456",
  "resource": "file:src/lib/auth.ts",
  "mode": "write",
  "ts": "2026-05-19T14:30:00Z"
}
```

The server maintains projections from events:

- current reservations
- active tasks
- active agents
- conflicts
- pending checks
- unresolved findings
- workspace timeline
- per-human dashboard state

Event sourcing is useful here because multiplayer systems need history, replay, audit, and late-arriving clients.

---

## Unified Transition Machine

Reservations, cloud verdicts, receipt updates, evictions, and policy changes should use one transition model.

A concrete implementation can start from the existing reservation transition machine and generalize from `ReservationTxn` to a broader `HarnessTxn` / `WorkspaceTxn` model.

Example transition families:

```text
reservation_requested
reservation_granted_local
reservation_confirmed_remote
reservation_rejected_remote
binding_created
binding_heartbeat
binding_expired
released_by_owner
evicted_by_priority
evicted_by_player

receipt_created
receipt_running
receipt_completed
receipt_failed
receipt_superseded

tier2_allow
tier2_reject
tier2_advisory
tier3_block
tier3_warn

policy_snapshot_applied
policy_snapshot_nacked
policy_version_rolled_back
```

The invariant:

```text
live_state == replay(all_events)
```

That matters because multiplayer failures are often reconciliation failures. If live state and replay state diverge, the system cannot answer who owns a file, which check blocked a push, or whether a bypass was legitimate.

The same transition log should power:

- local harness state
- team broker projections
- audit export
- recurrence aggregation
- rollback after negative cloud verdicts
- dashboard timeline

This also makes optimistic cloud checks tractable. If a tool call was allowed locally and a later cloud verdict rejects it, rollback is just another transition with an explicit reason and receipt link.

---

## Multiplayer Conflict Policy

The most important default:

```text
Same human's agents conflict -> warn / coordinate
Different humans' agents conflict -> block / require handoff
```

Suggested matrix:

| Situation | Default decision |
|---|---|
| Same human, same task, same file | Warn |
| Same human, same task, different files | Allow |
| Same human, different task, same file | Ask or warn |
| Different human, same file | Block unless handoff/shared lease exists |
| Different human, same symbol | Block or ask depending on risk |
| Different human, read vs write | Allow read, warn if stale |
| Release/deploy capability already reserved | Block unless explicit approval |

This gives one human freedom to orchestrate a small agent team while still protecting other humans from hidden collisions.

Multiplayer adds failure modes that single-player does not have:

| Problem | Design response |
|---|---|
| Waiting on another player | subscribe to reservation/operation updates instead of polling forever |
| Catalog differs by role | filter catalog by originating identity and policy bundle |
| Urgent work needs a held scope | priority/preemption fields plus visible eviction transitions |
| Delegation expands accidentally | local broker enforces non-expanding binding chains |
| Machine dies mid-reservation | per-binding heartbeat and TTL cleanup |
| One human runs many agents | per-human budget locally, org-wide budget at team broker |
| Private work leaks through audit | access control by identity-chain prefix |

---

## Task Broker

The task broker turns vague work into assignable, scoped units.

Example:

```text
Task: Implement receipt plumbing
Owner: Human A

Allowed resources:
  - src/harness/types/**
  - src/commands/checks.ts
  - src/harness/receipt-store.ts
  - src/**/*.test.ts

Agents:
  - A1 implementation-agent
  - A2 test-agent
  - A3 review-agent

Required receipts:
  - typecheck
  - test
  - local verify
  - cloud review for receipt schema changes
```

Agents interact through explicit commands/tools:

```text
agent.wait_for_work()
agent.claim_subtask()
agent.reserve_resource()
agent.request_scope_expansion()
agent.handoff()
agent.mark_blocked()
agent.attach_receipt()
agent.complete()
```

The point is not bureaucracy. The point is to give the system enough structure to coordinate multiple agents without relying on chat memory.

---

## Handoffs

Handoffs should be first-class, not just messages.

```typescript
interface Handoff {
    handoff_id: string;
    workspace_id: string;
    from_human_id: string;
    from_agent_id: string;
    to_human_id?: string;
    to_agent_id?: string;
    task_id?: string;
    resources: ResourceRef[];
    reason: string;
    status: "requested" | "accepted" | "rejected" | "cancelled" | "expired";
    created_at: string;
    expires_at?: string;
}
```

Flow:

```text
Agent B1 wants file:src/lib/auth.ts
Server sees Human A / Agent A1 owns the write lease
Server blocks B1 and offers a handoff request
B1 sends handoff request
A1 or Human A accepts, rejects, or narrows scope
Reservation transfers or a shared lease is created
```

This avoids silent overwrites and turns conflicts into visible collaboration.

---

## Phase 2/3: Remote and Cloud Checks

The Atlassian provisioning loop maps directly onto remote/cloud checks.

Atlassian:

```text
Client request
  -> broker validates
  -> queue task
  -> worker performs side effects
  -> durable status
  -> control plane observes status
```

Interlinked:

```text
Tool/check intent
  -> control plane validates
  -> receipt_id minted
  -> workflow/sandbox/reviewer job starts
  -> durable receipt updated
  -> harness/dashboard/agents observe status
```

Cloud checks should never be loose background jobs. They should be receipt-backed state machines.

Minimum state machine:

```text
pending -> running -> complete
pending -> running -> failed
pending -> cancelled
running -> timeout
running -> superseded
failed -> rerun_requested -> running
complete -> superseded
```

Receipts should be:

- idempotent
- queryable
- replayable when possible
- linked to task, human, agent, session, and resources
- visible in dashboard
- available to local harness cache
- included in audit logs

The user experience:

```text
PreToolUse:
  create receipt rcpt_123
  run fast deterministic checks
  start cloud workflow if needed
  return quickly

PostToolUse:
  reconcile actual result with receipt rcpt_123
  surface completed findings if ready
  otherwise mark pending

Next turn / dashboard:
  completed receipt becomes visible
  related agents see status
```

This is the right home for:

- similar-past-diff lookup
- multi-agent review
- sandboxed dry-run
- mutation testing
- SBOM/license/CVE checks
- deeper prompt-injection scan
- cross-session recurrence mining
- compliance evidence

---

## Phase 4/5: Multi-Agent and Multiplayer Orchestration

The Atlassian sidecar model is the closest analogy.

Atlassian had Envoy as the central programmable proxy and sidecars for complex concerns:

- authentication sidecar
- authorization sidecar
- rate limiting sidecar
- native Envoy access logging
- CloudFront DDoS protection

Interlinked should use specialist agents and cloud jobs the same way.

The coordinator should not be one giant reviewer. It should dispatch to specialists with clear contracts:

| Specialist | Responsibility |
|---|---|
| Security reviewer | auth, secrets, injection, dangerous flows |
| Code-quality reviewer | maintainability, types, coupling, error handling |
| Test reviewer | test adequacy, regression coverage, disabled tests |
| Docs reviewer | docs drift, command reference drift, generated docs |
| Release reviewer | migration/deploy/push risk |
| Compliance reviewer | auditability, evidence, policy adherence |
| Performance reviewer | hot paths, resource usage, caching |

Each specialist receives the same normalized context and emits the same verdict schema.

The coordinator merges verdicts conservatively:

```text
Any hard block -> block
Any missing required reviewer -> degraded review
Warnings dedupe by file/line/category
Most severe finding wins
Bypass requires reason and is audited
```

This fits both:

- one human orchestrating several agents
- several humans, each orchestrating several agents

---

## Policy Compiler

Raw policy is too loose for multiplayer enforcement.

Inputs:

- `AGENTS.md`
- skills
- team policy
- per-task constraints
- role constraints
- workspace conventions
- historical recurrence data

Outputs:

- deterministic local harness rules
- cloud policy checks
- Cedar or equivalent decision policies
- reviewer prompts
- sandbox workflow plans
- required receipts
- task templates
- role scopes

This mirrors the Atlassian template/context model:

```text
Developer-facing parameters
  -> validation
  -> template/context rendering
  -> safe runtime config
```

Interlinked equivalent:

```text
Human/team policy and task intent
  -> validation
  -> policy/check compilation
  -> safe runtime coordination
```

Important boundary:

- deterministic, zero-FP checks can block in the hot path
- heuristic or taste checks should warn, run in verify, or require calibration
- LLM review belongs in cloud tiers where receipts, evals, monitoring, and bypass audit exist

---

## Streaming Policy Distribution

Local file polling is not enough for multiplayer.

An org security lead may need a policy update to reach every active harness in seconds. A team broker may need to push an eviction notice when a contested scope is preempted. A cloud verdict may need to update every related agent in a cohort.

Borrow the xDS properties from Atlassian's Envoy control plane:

- **State-of-the-world snapshot** on cold start.
- **Delta updates** during steady state.
- **Aggregated stream** so one connection carries policies, reservations, receipts, handoffs, and notices.
- **ACK/NACK** so the team broker knows which local brokers successfully applied a version.

The practical transport can be Server-Sent Events over HTTP/2. It is browser-friendly, proxy-friendly, and easier to operate than gRPC while still giving the push semantics we need.

The distribution loop is separate from the broker/provisioning loop:

```text
Provisioning loop:
  local broker -> team broker -> reservation/receipt state

Distribution loop:
  team broker -> local brokers -> ACK/NACK applied snapshots and deltas
```

That separation is the key Atlassian lesson. Provisioning and config distribution scale and fail independently.

### Atomic Policy Snapshots

Policy must be applied as an ordered, coherent tuple:

```text
(cedar_files, distilled_rules, check_config, catalog, overrides)
```

A harness either applies the whole snapshot or none of it. Partial application is forbidden.

The ordering matters. A distilled rule that references a Cedar predicate must not be installed before the Cedar file that defines it. The last-known-good snapshot should always be a coherent tuple so rollback is safe.

### Signed Policy Bundles

For enterprise rollout, policy should be distributed as a signed bundle:

```text
acme-policies-v3.2.0.tar.gz
  distilled-rules.json
  policies/
    disk-forensics.policy.md
    disk-forensics.cedar
    disk-forensics.interlinked.cedar
  check-config.json
  catalog.json
  manifest.json
```

Properties:

- signed by the org policy admin or deployment key
- versioned and channel-pinned, such as `stable` or `canary`
- applied atomically
- secrets excluded from the bundle
- catalog derived from the bundle so all players on the same version see the same scope menu

This is the Interlinked analog of Atlassian's golden AMI: immutable, signed, versioned runtime policy, with secrets and user credentials injected separately.

---

## Safe Path Only Path

One of the strongest Atlassian lessons was making public exposure explicit. Services could no longer become public by accident through the old basic load balancer. They had to go through the centralized platform.

Interlinked should apply the same rule to high-risk agent actions.

Risky actions should require explicit paths:

| Action | Safe path |
|---|---|
| edit reserved file | reservation or handoff |
| push branch | required receipts resolved |
| merge PR | review receipts resolved |
| deploy | capability reservation + approval |
| edit secrets/config | explicit scope and policy allowance |
| destructive shell command | deterministic guard or audited bypass |
| change shared policy | policy review task |

Bypass should exist, but it should be loud:

- reason required
- human identity attached
- agent/session attached
- task attached if available
- visible in dashboard
- included in audit export
- rate tracked

For individual developer use, fail-open remains reasonable. For enterprise multiplayer deployments, fail-closed should be a policy-bundle setting:

```json
{
  "harness_unreachable": "fail_closed",
  "untrusted_policy_snapshot": "fail_closed",
  "missing_required_binding": "fail_closed"
}
```

That makes the deployment mode drive behavior. A solo developer can keep local continuity. A regulated team can require every agent action to pass through the signed policy and broker layer.

---

## Operational Concerns

The Atlassian transcript emphasized that building the first version is easier than maintaining it.

Interlinked should design for these failure modes early:

| Failure mode | Required design response |
|---|---|
| Local harness offline | fail open for non-critical checks, preserve local activity |
| Server unavailable | local cache + local-only mode, later reconciliation |
| Cloud workflow delayed | pending receipt is first-class |
| Cloud workflow fails | receipt records failure, rerun available |
| Reviewer returns malformed output | degraded review, not silent approval |
| Wrong block | bypass with audit, later mark false positive |
| Noisy warning | recurrence/fix-rate telemetry, demotion path |
| Agent edits outside task | scope warning/block based on role and owner |
| Two humans edit same file | reservation conflict and handoff |
| Valid check config causes harm | canary/shadow mode before enforcement |
| Stale policy | policy versioning and docs/check drift reports |

Operational primitives:

- runbooks
- receipt inspection
- event replay
- projection rebuild
- stuck lease cleanup
- check rerun
- reviewer rerun
- bypass audit
- false-positive marking
- dashboard timeline
- per-agent health

---

## Valid-But-Harmful Decisions

The hardest Atlassian failure mode was not malformed config. It was config that was syntactically valid, passed checks, and still broke live traffic.

Interlinked has the same risk:

- a policy snapshot is valid but blocks legitimate work across the org
- an LLM judge returns well-formed but wrong verdicts
- a reviewer prompt upgrade increases false blocks
- a reservation policy is logically valid but creates deadlocks
- a generated task scope is valid but too broad

Mitigations:

1. **Canary policy and model rollout.** Route a small percentage of verdicts or cohorts through the new policy/model first. Compare divergence before promotion.
2. **Shadow before enforcement.** New heuristic or LLM-backed checks should run advisory before blocking.
3. **Two-of-three for high-blast-radius blocks.** For destructive shell, broad writes, force pushes, deploys, and production capability grants, require deterministic policy plus one or more independent checks before hard enforcement.
4. **Behavioral observability.** Track task completion rate, retry rate, bypass rate, reservation-conflict rate, and time blocked. A policy that looks correct per event can still damage system behavior.
5. **Fast rollback.** The last-known-good policy snapshot must be atomically restorable.

This is where the event log matters. The system needs to answer not only "was this decision formatted correctly?" but "did this decision pattern make the team worse at shipping safely?"

---

## Cloud Sidecar

The cloud client should be a separate sidecar process from the main local harness daemon.

Atlassian put auth, authorization, and rate limiting in sidecars next to Envoy when the logic needed independent ownership, release cadence, and crash isolation. Interlinked should do the same for Tier 2/Tier 3 cloud calls.

Benefits:

- independent crash domain from the harness
- provider SDK churn does not destabilize local enforcement
- long-lived connections preserve prompt-cache and HTTP connection reuse
- provider A/B tests can ship as sidecar version changes
- latency-sensitive code can eventually move to Rust without rewriting the TypeScript harness

The local harness becomes the policy-enforcing broker. The cloud sidecar becomes the managed egress/client for LLM policy, deep review, sandbox orchestration, and remote verdict retrieval.

---

## Proposed Cloudflare Mapping

This is an implementation sketch, not a requirement.

| Component | Cloudflare primitive |
|---|---|
| Workspace Coordinator | Durable Object with SQLite |
| Human Cohort Coordinator | Durable Object or Facet per human/workspace |
| Event log | SQLite append table + R2 export |
| Projections | SQLite tables rebuilt from events |
| Realtime Gateway | Durable Object WebSockets / hibernation |
| Long-running checks | Workflows |
| Sandbox review/test jobs | Cloudflare Sandboxes |
| Code artifacts | Artifacts / R2 / git mirror |
| Reports | R2 |
| Policy/search memory | Vectorize / D1 / R2 as needed |
| Audit export | Logpush / R2 / customer SIEM |

The important part is preserving the architectural split. Do not let implementation convenience collapse the control plane into ad hoc handler code.

---

## Protocol Surfaces

### Broker API

The broker API is the canonical scope-management surface.

Minimum OSB-shaped endpoints:

```text
GET    /v2/catalog
PUT    /v2/service_instances/{id}
PATCH  /v2/service_instances/{id}
DELETE /v2/service_instances/{id}
GET    /v2/service_instances/{id}/last_operation
PUT    /v2/service_instances/{id}/service_bindings/{binding_id}
DELETE /v2/service_instances/{id}/service_bindings/{binding_id}
```

Interlinked-specific extensions:

- originating identity carries org/workspace/human/agent/session
- `parameters.priority` and `parameters.preempt` request urgent scope
- binding response returns signed capability token
- SSE stream carries grant, eviction, receipt, and policy-version deltas
- catalog is filtered by identity and policy bundle version

### MCP Adapter

MCP exposes agent-facing tools:

```text
wait_for_work
claim_task
reserve_resource
release_resource
request_handoff
send_message
attach_receipt
report_blocked
complete_task
query_activity
query_workspace_state
```

MCP should be an adapter, not the internal domain model.

### CLI Hook Adapter

The local harness sends:

- tool events
- proposed edits
- command summaries
- local decisions
- local findings
- local reservations
- receipt correlations
- session health

The server returns:

- cached reservation state
- policy version
- role/task scope
- pending receipt status
- conflict decisions
- handoff messages

### Web UI

The dashboard should show:

- humans and cohorts
- active agents
- task board
- resource map
- conflicts
- pending receipts
- findings
- event timeline
- bypasses
- approvals

### GitHub/CI Adapter

GitHub and CI integrations should attach:

- PRs
- commits
- status checks
- review comments
- CI failures
- release/deploy state

These become events and receipts in the same workspace model.

---

## Example End-to-End Flow

### One human, multiple agents

```text
1. Human A creates task: "Implement receipt plumbing."
2. Server assigns:
   - A1 implementation-agent
   - A2 test-agent
   - A3 review-agent
3. A1 reserves src/harness/receipt-store.ts.
4. A2 reserves src/harness/receipt-store.test.ts.
5. A1 edits implementation.
6. Local harness runs fast checks and syncs activity.
7. A2 writes tests after seeing A1's file changed.
8. A3 waits for required receipts.
9. Receipt rcpt_123 fails type impact.
10. Server marks task blocked and notifies A1.
11. A1 fixes issue.
12. Receipts pass.
13. A3 reviews diff and marks task ready.
```

### Multiple humans

```text
1. Human A / Agent A1 reserves file:src/lib/auth.ts for task_1.
2. Human B / Agent B1 attempts to edit the same file for task_2.
3. B1's local harness checks cache and sees no local lease.
4. Harness asks server or uses fresh server projection.
5. Server returns conflict: A1 owns write lease.
6. B1 is blocked with a handoff option.
7. B1 requests handoff.
8. A1 accepts after finishing current patch.
9. Reservation transfers or a shared lease is created.
10. Both timelines show the handoff.
```

### Cloud receipt as coordination

```text
1. Agent A1 changes auth-sensitive code.
2. PreToolUse creates rcpt_456 for cloud security review.
3. Tool executes locally.
4. PostToolUse sees rcpt_456 still pending and surfaces that state.
5. Agent B2 attempts related edit.
6. Server warns B2: overlapping security review pending.
7. rcpt_456 completes with high finding.
8. Task becomes blocked.
9. Push is blocked until finding is resolved or bypassed.
```

---

## Churn As A Coordination Signal

Atlassian's maintenance lesson was that churn predicts coupling. The files and modules that keep changing are where complexity accumulates, even when no individual edit looks dangerous.

In multiplayer Interlinked, churn should influence orchestration:

- do not assign two agents to a hotspot module concurrently by default
- escalate PRs touching hotspot modules to deeper review
- warn when a task touches files that historically change together
- suggest broader scope when the same coupled files repeatedly appear in one session
- raise priority for docs/runbooks around high-churn areas

Useful deterministic aggregates:

```text
per-file edit frequency
distinct agents touching a file
distinct humans touching a file
co-edit correlation between files
receipt failures per file
bypass rate per file or module
reservation conflicts per file or module
```

This should start as a counting query over the event log, not an LLM judge. It can feed the task broker, review tiering, and dashboard.

---

## Related Design Threads

- `docs/design/multiplayer-broker-orchestration.md` — OSB-shaped reservation brokerage, nested team/local brokers, identity-chain binding tokens, xDS-style streaming, signed policy bundles.
- `docs/design/pre-post-pipelined-cloud-checks-and-failure-recovery.md` — receipt IDs, async cloud reconciliation, pending receipt UX.
- `docs/design/multi-agent-pre-push-review.md` — multi-reviewer fanout, unanimous-allow aggregation, sandbox execution.
- `docs/design/tier-2-llm-policy-gate.md` — synchronous cloud policy gate and trajectory-aware LLM verdicts.
- `docs/design/tier-3-async-deep-review.md` — slower wide-scope review of commits and session behavior.

---

## Design Principles

1. **MCP is an adapter, not the architecture.**
   The core system is the multiplayer coordination model.

2. **Human ownership is first-class.**
   Every agent action is attributable to a human.

3. **Cohorts are first-class.**
   A human's agents are a team, not unrelated sessions.

4. **Intent beats observation alone.**
   The system should know what task an agent is trying to complete.

5. **Brokered scopes are the multiplayer safety primitive.**
   Files are only the first resource type. The general mechanism is catalog, provision, bind, heartbeat, and release.

6. **Bindings carry runtime authority.**
   Local enforcement should verify signed, scoped, expiring grants rather than trusting agent self-report.

7. **Receipts are the cloud-check primitive.**
   Slow work must be durable, queryable, replayable, and auditable.

8. **Small validated inputs, powerful generated behavior.**
   Borrow the Atlassian template/context pattern.

9. **Separate provisioning from distribution.**
   Broker requests change desired state; streaming snapshots and deltas distribute applied state.

10. **Safe path only path for high-risk actions.**
   Risky actions go through explicit gates or loud bypasses.

11. **Local is fast, cloud is authoritative for shared state.**
   The harness makes low-latency decisions from cache and syncs upward.

12. **Maintenance is part of the product.**
    Runbooks, replay, false-positive marking, and audit trails are not add-ons.

---

## Open Questions

1. What is the minimum useful resource model beyond files: symbols, routes, directories, or capabilities?
2. Should same-human multi-agent conflicts ever hard-block by default?
3. How much task structure should be required before an agent can edit?
4. What is the right lease TTL for fast local edits vs long-running task ownership?
5. Should reservations be optimistic by default, pessimistic for sensitive paths, or policy-controlled?
6. How are false positives marked and fed back into policy compilation?
7. How much of the event log should be visible to all humans in a workspace?
8. What is the first paid multiplayer feature: shared reservations, cloud receipts, multi-agent review, or dashboard?
9. Can policy compilation remain deterministic for hot-path checks while still using LLMs for cloud review?
10. What is the migration path from today's CLI/harness into this greenfield server model?
11. Do we implement OSB exactly for scope brokerage, or an OSB-shaped internal API with MCP/CLI adapters on top?
12. Should binding tokens be JWTs with OAuth `act` claims, or should we use a more constrained signed capability format?
13. What streaming transport ships first: SSE, WebSocket, or gRPC?
14. Do old bindings survive policy-bundle upgrades until expiry, or can the team broker revoke them immediately?
15. What is the default preemption policy for urgent work, and how should agents be notified mid-task?
16. How do per-human cloud budgets and org-wide cloud budgets interact when one human runs many agents?

---

## First Build Slice

A pragmatic first slice:

1. Event log and projections for workspace activity.
2. Human/cohort/agent identity model.
3. File reservations with TTL, heartbeat, and explicit binding records.
4. A local broker API that wraps reservations in catalog/provision/bind/release semantics.
5. Task ownership and agent assignment.
6. Handoff requests.
7. Receipt object model with local-only receipts first.
8. Dashboard showing humans, agents, reservations, bindings, tasks, and receipts.
9. MCP adapter exposing `wait_for_work`, `reserve_resource`, `request_handoff`, and `complete_task`.
10. CLI hook adapter syncing local harness events and reading reservation projection.
11. Team broker stub with catalog, provision, and signed binding tokens.
12. One cloud workflow stub that updates a receipt from `pending` to `complete`.
13. SSE stream for reservation conflict and policy-version notifications.

That slice proves the multiplayer kernel before adding expensive review or deep cloud checks.

The follow-on slice:

1. Generalize reservation transitions into a unified workspace transition log.
2. Add signed policy bundles and atomic snapshot application.
3. Add fail-closed enterprise mode.
4. Extract the cloud client into a sidecar process.
5. Add canary/shadow rollout for cloud verdict changes.
6. Add churn hotspot aggregation over the event log.
