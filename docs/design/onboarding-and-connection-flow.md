# Onboarding & connection-detection flow (decision-locked 2026-05-28)

**Status:** Designed, decisions locked, not yet built. Successor to the v0 cloud
governor (`cloud-governor-architecture.md`). This doc specifies the new-user
onboarding flow and the bidirectional CLI ↔ cloud connection detection.

**Companions:**

- `cloud-governor-architecture.md` — the as-built v0 (Channel B + Supervisor DO)
- `project_supervisor_pattern` memory — Supervisor/Facet as three scales of one shape
- `project_vision_multiagent` memory — CLI/Server independence; local-only must stay viable

## Locked decisions

1. **Unify into interlinked-cloud.** The Worker we deployed
   (`interlinked-cloud.quentincody.workers.dev`) becomes the single remote: it
   gains an MCP endpoint (`/mcp`) alongside the governor (`/governor/evaluate`)
   and CLI-API (`/admin/*`, `/sync`) surfaces. `mcp-agent-chat` is retired as a
   runtime dependency (kept only as reference for OAuth/MCP/presence code).
2. **Codebase sync = file manifest.** v0 pushes `path → content-hash + size`
   per file, not content. Content/Artifacts is a later tier.
3. **Connection detection waits for the real `/mcp` endpoint.** The `mcp`
   indicator reflects a true live MCP session (connect/disconnect tracked in the
   Supervisor DO), never a "registered in config" guess. So `/mcp` is on the
   critical path for the detection feature.

## The three channels, one rendezvous

"MCP Server connected" was conflating three independent channels. Separating
them is what makes the Supervisor DO's role obvious and removes Facets from the
onboarding story.

```text
   AGENT RUNNER (Claude Code / Cursor / …)
     ├── MCP client ───────── Channel A (voluntary) ───────────┐
     └── fires hooks ──┐                                        │
                       ▼ hooks (involuntary)                    │
   CLI HARNESS DAEMON (local, .sock)                            │
     ├── → Channel B (governor)  ───────────────────────────────┤
     ├── → Channel C (CLI API: status / sync) ──────────────────┤
     └── statusline ◄─ reads connection state from snapshot     │
                                                                 ▼
   interlinked-cloud WORKER
     /mcp (A)     /governor/evaluate (B)     /admin/*, /sync (C)
                  ┌──────────────────────────────────────────┐
                  │  SUPERVISOR DO (one per workspace)        │ ← rendezvous
                  │    • events log              [built]      │
                  │    • presence: last-seen per channel      │
                  │    • codebase manifest                    │
                  └──────────────────────────────────────────┘
                  (execution plane — facets / sandboxes — is
                   spawned BY the Supervisor on demand; it is
                   NOT part of onboarding. See "Two planes".)
```

| Channel | Driver | Transport | Built? |
|---|---|---|---|
| A — MCP | agent (voluntary) | JSON-RPC over `/mcp` | no |
| B — Governor | daemon (involuntary) | hook events → `/governor/evaluate` | yes |
| C — CLI API | CLI | HTTP `/admin/*`, `/sync` | partial (`/admin/recent`) |

**Presence is derived, not a separate protocol.** Every channel writes a
timestamped trace to the Supervisor DO. "Connected" = "the DO heard from this
party within the freshness window." No heartbeat protocol needed beyond the
traffic that already flows.

## Two planes: control vs execution

The cleanest way to hold the whole system. The onboarding flow is entirely
**control plane**; the new Cloudflare execution primitives are a separate,
later **execution plane** that the Supervisor orchestrates.

```text
   CONTROL PLANE  (built — the "brain", always-on, hibernates to $0)
     SUPERVISOR DO (one per workspace)
       presence · events · membership-gated state · codebase manifest
       own SQLite — per-project/session data lives in TABLES here
       orchestrates ↓ (spawns work only when work needs running)
   EXECUTION PLANE  (future — the "muscle")
       sub-agent Facet   → cloud-side review / specialist agent
       Dynamic Worker    → run per-workspace policy / check code (JS)
       Sandbox/Container → npm test · build · MUTATION testing (parallel)
       Browser Run       → web automation
       reads code from:  Workspace (shell: SQLite+R2) / Artifacts (git)
```

**Supervisor DO = the workspace's cloud brain. One per workspace. The entire
onboarding story.** Rendezvous for A/B/C, presence, manifest, event log.

**A Facet is an isolated unit of *execution*, not a data partition.** (This
corrects an earlier framing.) Canonically a facet runs either dynamic/untrusted
code (via Worker Loader) or a static sub-agent DO class (via `this.ctx.exports`,
zero-latency typed RPC) — its isolated SQLite is a *property*, not the purpose.
Per-project / per-session **data** is just tables in the Supervisor's own DB.
So facets enter only when the cloud needs to *run something* in isolation
(cloud-side review agent, sandbox-lite). The v0 `cloud/src/dos/facet.ts` stub
modelled "facet = per-session data" — a mis-application — and was removed
(migration `v2 deleted_classes: ["Facet"]`). A real facet returns later as a
sub-agent execution unit, in its own migration.

### The execution ladder (where the new products land)

Project Think arranges them as additive tiers; each maps to a concrete role:

| Tier | Primitive | Stateful | Role in interlinked |
|---|---|---|---|
| 0 | Workspace (`@cloudflare/shell`) + Artifacts/ArtifactFS | yes | synced codebase cloud-side; manifest is the v0 sliver, Artifacts the full-content layer |
| 1 | Dynamic Worker (Worker Loader + codemode) | no | run per-workspace / AI-generated policy + check code, sandboxed JS |
| 2 | + worker-bundler | no | runtime npm for that code |
| 3 | Browser Run / sub-agent Facet | yes | web automation; cloud-side review agent (own SQLite, zero-latency RPC) |
| 4 | Sandbox / Container | yes | full OS: `npm test`, build, **per-tool-call mutation testing fanned out in parallel** |

Dynamic Workflows (`@cloudflare/dynamic-workflows`) = the multi-tenant form of
Tier 1: each workspace ships its own durable multi-step governance pipeline.

## Multi-tenancy: addressing & isolation

The Supervisor DO is keyed by `workspace_id` (`SUPERVISOR.idFromName(...)`).
Today that key is hardcoded `"default"` — the single-tenant placeholder.

- **Not per-user — per-workspace.** A solo user gets a workspace of one; a team
  *shares* one `workspace_id` → one Supervisor DO → the shared rendezvous. That
  sharing is what enables multiplayer.
- **Grain:** user (OAuth subject) → member of → workspace (= one Supervisor DO)
  → contains projects (tables inside) → sessions/machines (rows).
- **DO addressing is by name, so the Worker must authorize before it routes.**
  `idFromName("ws_x")` opens that DO for anyone who knows the string;
  isolation lives at the Worker, not the DO. Multi-tenant therefore needs:
  (1) identity (OAuth subject, from the same `workers-oauth-provider` as `/mcp`),
  (2) a membership registry (`user ↔ workspaces` — D1 or a Registry DO),
  (3) per-request authz: token → user → ∈ workspace? else 403.
- Until that lands, `workspace_id: "default"` + one shared secret is the correct
  single-tenant posture. **Do not ship real `workspace_id`s without the authz
  gate** or any user could read any workspace's events. This makes identity +
  membership a prerequisite that converges with the `/mcp` OAuth work (T2.1).

## Onboarding flow (each step independently shippable)

**Step 1 — Install (free, zero auth, local-only).**
`npm i -g interlinked && interlinked enable`. Hooks + statusline install;
`sync_mode: local`; full local governor works (rules, blocks, checks). No
server, no OAuth. Statusline: `◆ interlinked · local-only · N rules`. This is
the free tier and must always remain viable (CLI/Server independence
principle).

**Step 2 — Connect the cloud (the one OAuth step).**
`interlinked login` → PKCE against interlinked-cloud → token saved →
`sync_mode → realtime`. Daemon begins forwarding (Channel B). The same command
registers `/mcp` in the runner's MCP config (Channel A becomes available).

**Step 3 — Bidirectional detection in the statusline.**
Reuses the existing daemon → `statusline.snapshot` → statusline-script
pipeline. Daemon writes `cloud_synced` and `mcp_connected` into the snapshot;
statusline renders `◆ interlinked · ⬤ cloud · ⬤ mcp` (or `○ mcp` when the MCP
session is down). Server-side "vice versa": the Supervisor DO already sees
Channel-B traffic, so a `workspace_state` MCP tool answers "harness:
connected, last edit 3s ago" to the agent / any dashboard.

**Step 4 — Codebase manifest sync.**
Daemon pushes a manifest (`path → hash + size`) to the Supervisor DO on login
and session-start, incremental on edits (harness tracks `files_written`).
Statusline: `⬤ synced (N files)`.

Everything except Step 1's UI is daemon-driven (Channels B/C). Channel A exists
for when the agent wants tools, but governance/detection/sync never depend on
the LLM choosing to call anything.

## Build order

Two tracks. Track 2 is the critical path for the detection feature (decision 3);
Track 1 has no `/mcp` dependency and can land in parallel.

**Track 1 — no `/mcp` dependency:**

- T1.1 Local-first onboarding: make `interlinked enable` / first-run default to
  local-only with zero auth prompts; cloud connect is an explicit Step 2.
- T1.2 Manifest sync: daemon builds a manifest, `POST /sync/manifest` to the
  Supervisor DO; new `manifest` table; incremental update on `files_written`.

**Track 2 — the `/mcp` critical path:**

- T2.1 `/mcp` endpoint: McpAgent on the Worker + OAuth (lean toward
  `@cloudflare/workers-oauth-provider` — DCR + PKCE + token issuance, the
  standard remote-MCP path; see the `cloudflare:build-mcp` skill). At least one
  tool (`workspace_state`) so the session is useful.
- T2.2 Session tracking: McpAgent connect/close → write last-seen to the
  Supervisor DO presence record.
- T2.3 Presence model + `GET /admin/connection-status`: derive per-channel
  last-seen (harness via Channel-B events; mcp via T2.2). Freshness window
  (e.g. 30s) → online/offline.
- T2.4 Statusline detection: daemon polls connection-status (or piggybacks on
  the governor response), writes `mcp_connected` / `cloud_synced` into the
  snapshot; statusline renders the segment.
- T2.5 `interlinked login` registers `/mcp` in the runner config (closes
  Step 2's loop).

## Open sub-decisions (for when Track 2 starts)

1. **OAuth approach for `/mcp`:** `@cloudflare/workers-oauth-provider` (self-
   issued tokens, DCR) vs Cloudflare Access (human-SSO in front). Leaning the
   former — it's the canonical remote-MCP path and supports agent DCR.
2. **MCP tool surface for v0:** start with read-only `workspace_state` (returns
   harness presence + recent verdicts). Resist adding agent-callable mutation
   tools until there's a reason — keep the governor the authority.
3. **Presence freshness window + statusline cadence:** 30s window, 5s
   statusline refresh (current) — tune after observing real traffic.
4. **One token or two?** Channel B currently uses a bearer secret; Channel A
   will use OAuth. Decide whether the daemon's Channel-B auth migrates to the
   same OAuth token or stays a separate workspace secret.
