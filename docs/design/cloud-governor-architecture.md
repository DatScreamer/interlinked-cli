# Cloud governor — architecture at a glance

**Purpose:** visual reference for what was built in the 2026-05-28 cloud-governor v0 land (commit `e8743c6` + follow-ups through `425d624`). Read top to bottom; each section is one diagram + a paragraph of read-me.

**Audience:** future-you (or any agent) asking "where does X live? what calls what? what is and isn't running?"

**Companions:**
- `harness-system-diagrams.md` — the local-kernel diagrams the cloud sits ON TOP of (not behind)
- `tier-2-llm-policy-gate.md` / `tier-3-async-deep-review.md` — the next layers, designed but not built
- The cloud governor v0 source: `cloud/` (Worker + DOs) + `src/lib/cloud-governor.ts` + `src/harness/cloud-forward.ts` + the one-liner in `src/harness/server.ts`
- Memory: `project_cloud_governor_v0_landed.md`

**One-line summary:** the local harness daemon forwards every PreToolUse hook event to a Cloudflare Worker, which evaluates its own rule set, persists the event + verdict in a Durable Object, and returns a runner-compatible verdict that the daemon merges (locally-authoritative) into what the hook returns to the runner.

**It is NOT an MCP server.** The agent never calls anything cloud-side as a tool. The agent is observed by the hook layer; the cloud is on the *other side* of that hook layer, not in front of the agent.

---

## 1. The big picture — top-to-bottom stack

```
   ┌──────────────────────────────────────────────────────────────┐
   │                       AGENT (the model)                       │
   │  decides "run `cf dns records delete --id rec-abc`"           │
   └──────────────────────────────────────────────────────────────┘
                                 │
                                 ▼ tool_use submitted to runner
   ┌──────────────────────────────────────────────────────────────┐
   │  RUNNER (Claude Code / Cursor / Codex / Gemini / Copilot)     │
   │  fires PreToolUse hook before executing the tool              │
   └──────────────────────────────────────────────────────────────┘
                                 │
                                 ▼ exec hook script with event on stdin
   ┌──────────────────────────────────────────────────────────────┐
   │  HOOK SCRIPT (.interlinked/hooks/interlinked-activity.mjs OR  │
   │              dist/hook-entry.js)                              │
   │  connects to local harness via Unix socket (500ms timeout)    │
   └──────────────────────────────────────────────────────────────┘
                                 │
                                 ▼ AF_UNIX framed/raw event
   ┌══════════════════════════════════════════════════════════════┐
   │  LOCAL HARNESS DAEMON  (Node.js process — PID seen via         │
   │  `interlinked harness status`)                                 │
   │  socket: .interlinked/harness.sock                             │
   │  ┌────────────────────────────────────────────────────────┐   │
   │  │ 1. runPreToolPipeline  — local rules + checks          │   │
   │  │    → produces HarnessDecision (allow/block/ask + warns)│   │
   │  └────────────────────────────────────────────────────────┘   │
   │  ┌────────────────────────────────────────────────────────┐   │
   │  │ 2. forwardCloudPreToolUse — IF cloud_governor.enabled  │   │
   │  │    HTTPS POST to cloud (2s timeout, fail-open)         │   │
   │  └────────────────────────────────────────────────────────┘   │
   │  ┌────────────────────────────────────────────────────────┐   │
   │  │ 3. mergeCloudVerdict — local authority:                │   │
   │  │    block/ask preserved · allow + cloud-block → block   │   │
   │  │    allow + cloud-warns → union (cloud prefix [cloud])  │   │
   │  └────────────────────────────────────────────────────────┘   │
   └══════════════════════════════════════════════════════════════┘
                                 │                  ▲
                                 │ HTTPS POST       │ JSON verdict
                                 │ Bearer token     │ (≤ 1ms typical
                                 ▼                  │   on wrangler dev)
   ┌──────────────────────────────────────────────────────────────┐
   │  CLOUDFLARE WORKER  (`cloud/` — `interlinked-cloud` script)   │
   │  routes:                                                      │
   │    GET  /health                                               │
   │    POST /governor/evaluate   (bearer-authed)                  │
   │    GET  /admin/recent        (bearer-authed)                  │
   │  ┌────────────────────────────────────────────────────────┐  │
   │  │ authenticateRequest  (v0: env-bearer; v1: Access JWKS) │  │
   │  └────────────────────────────────────────────────────────┘  │
   │  ┌────────────────────────────────────────────────────────┐  │
   │  │ evaluate(event) — Tier 1 deterministic rules           │  │
   │  │   one ported rule: cloud-builtin-cf-dns-record-delete  │  │
   │  └────────────────────────────────────────────────────────┘  │
   │  ┌────────────────────────────────────────────────────────┐  │
   │  │ ctx.waitUntil(persistAsync) — async write, never       │  │
   │  │   blocks the response                                  │  │
   │  └────────────────────────────────────────────────────────┘  │
   └──────────────────────────────────────────────────────────────┘
                                 │
                                 ▼ DurableObjectStub.recordEvent(...)
   ┌──────────────────────────────────────────────────────────────┐
   │  SUPERVISOR DurableObject   (one per workspace_id)            │
   │  SQLite tables:                                               │
   │    events  ┃ id · workspace_id · session_id · agent_source ·  │
   │            ┃ hook_event · tool_name · payload_json ·          │
   │            ┃ decision · rule_id · created_at                  │
   │    (verdicts table — reserved for v0.1)                       │
   │  methods (RPC):                                               │
   │    recordEvent(workspace_id, event, verdict)  →  void         │
   │    recentEvents(limit) → Array<{id, session_id, …}>           │
   └──────────────────────────────────────────────────────────────┘
                                 │
                                 ▼ (future, not exercised in v0)
   ┌──────────────────────────────────────────────────────────────┐
   │  FACET DurableObject   (one per session_id — scaffold only)  │
   │  table: trajectory  (per-session tool-call detail)            │
   └──────────────────────────────────────────────────────────────┘
```

The boxes drawn `═` are processes that run continuously (the daemon and the Worker). Everything else fires per tool call.

## 2. Single-tool-call sequence — what happens in ~5ms

```
 Agent       Runner        Hook          Daemon         Worker         DO
   │           │            │              │              │             │
   │  tool_use │            │              │              │             │
   ├──────────►│            │              │              │             │
   │           │ exec hook  │              │              │             │
   │           ├───────────►│              │              │             │
   │           │ + event    │ AF_UNIX      │              │             │
   │           │            ├─────────────►│              │             │
   │           │            │              │ local eval   │             │
   │           │            │              ├──┐           │             │
   │           │            │              │  │ rules+    │             │
   │           │            │              │◄─┘ checks    │             │
   │           │            │              │              │             │
   │           │            │              │ if enabled:  │             │
   │           │            │              │ HTTPS POST   │             │
   │           │            │              ├─────────────►│             │
   │           │            │              │              │ auth +      │
   │           │            │              │              │ evaluate    │
   │           │            │              │              ├──┐          │
   │           │            │              │              │  │          │
   │           │            │              │              │◄─┘          │
   │           │            │              │              │ ctx.waitUntil(persistAsync)
   │           │            │              │              ├────────────►│
   │           │            │              │   verdict    │             │ INSERT
   │           │            │              │◄─────────────┤             │
   │           │            │              │              │             │
   │           │            │              │ merge        │             │
   │           │            │              ├──┐           │             │
   │           │            │              │  │           │             │
   │           │            │              │◄─┘           │             │
   │           │            │ merged       │              │             │
   │           │            │◄─────────────┤              │             │
   │           │   stdout   │              │              │             │
   │           │   stderr   │              │              │             │
   │           │◄───────────┤              │              │             │
   │           │            │              │              │             │
   │ warnings  │            │              │              │             │
   │ shown +   │            │              │              │             │
   │ tool runs │            │              │              │             │
   │◄──────────┤            │              │              │             │
```

Time budget (typical on wrangler dev, localhost):
- Hook → daemon (Unix socket): ~0.1ms
- Daemon local eval: ~1-5ms
- Daemon → Worker HTTPS round-trip: ~1ms (local) / ~50-200ms (production)
- Worker eval + persist queue: ~0.3ms
- DO write (`ctx.waitUntil` — does not block the response): async, doesn't count
- Daemon merge + return: ~0.1ms
- **Total visible to the agent: ~5-10ms local / 60-250ms production**

The "cloud doesn't block on DO write" property is what `ctx.waitUntil` gives us — the verdict goes back immediately while the SQLite write happens in the background.

## 3. Where things live — file map

```
interlinked-cli/                         (the repo you're in)
├── src/
│   ├── lib/
│   │   ├── cloud-governor.ts            ← evaluateRemote: fetch wrapper, fail-open
│   │   └── __tests__/
│   │       └── cloud-governor.test.ts   ← 12 cases
│   ├── harness/
│   │   ├── server.ts                    ← daemon entry; ONE LINE forwards (line ~670)
│   │   ├── cloud-forward.ts             ← config loader + mergeCloudVerdict
│   │   ├── __tests__/cloud-forward.test.ts  ← 13 cases (7 merge + 6 meta-test)
│   │   └── evaluator/pre-tool.ts        ← meta-test wrapper skip lives here too
│   └── ...rest of the CLI...
│
└── cloud/                               (the Cloudflare Worker)
    ├── wrangler.jsonc                   ← bindings: Supervisor + Facet DOs
    ├── package.json                     ← own deps; npm workspace not used
    ├── tsconfig.json                    ← targets Workers, no Node types
    ├── vitest.config.ts                 ← own test runner
    ├── .dev.vars                        ← BEARER_TOKEN for wrangler dev (gitignored)
    └── src/
        ├── worker.ts                    ← fetch handler; routes
        ├── auth.ts                      ← bearer validator + JWKS stub
        ├── types.ts                     ← HookEvent, Verdict, Env
        ├── governor/
        │   ├── evaluate.ts              ← Tier 1 deterministic rules
        │   └── evaluate.test.ts         ← 6 cases
        ├── dos/
        │   ├── supervisor.ts            ← per-workspace DO with SQLite
        │   └── facet.ts                 ← per-session DO scaffold
        └── auth.test.ts                 ← 5 cases

.interlinked/                            (per-repo state)
├── config.local.json                    ← cloud_governor block lives here (gitignored)
└── harness.sock                         ← Unix socket the daemon listens on
```

## 4. Two POVs — admin vs end-user

The admin and end-user touch the system at completely different points. Side-by-side:

```
ADMIN POV                                  END-USER POV
─────────                                  ────────────

curl /admin/recent                         "run Claude Code normally"
        │                                          │
        ▼                                          │
{                                                  │
  "events": [                                      │  (agent decides to run
    {                                              │   `cf dns records delete`)
      "id": 287,                                   │          │
      "tool_name": "Bash",                         │          ▼
      "decision": "allow",                         │  ╔═════════════════╗
      "rule_id":                                   │  ║ PreToolUse warns ║
      "cloud-builtin-cf-dns-record-delete",        │  ╚═════════════════╝
      "created_at": 1779991638099                  │          │
    },                                             │          ▼
    ...                                            │  stderr (visible to agent):
  ]                                                │
}                                                  │  [interlinked] DNS record
                                                   │   deletion has wide blast
admin sees:                                        │   radius...
  • which rules fired                              │  [cloud] DNS record
  • which session_id triggered each event          │   deletion has wide blast
  • when (created_at, epoch ms)                    │   radius...
  • verdict (allow/block)                          │
                                                   │  agent sees: "okay, two
admin can:                                         │  warnings — proceeding
  • observe traffic in real time                   │  carefully" (or refuses,
  • detect noisy rules (high fire rate)            │  depending on its policy)
  • verify a specific session's behavior           │
                                                   │  end-user sees:
admin cannot (yet, in v0):                         │  • whatever Claude Code
  • filter by session_id (would need               │    surfaces from the hook
    /admin/recent?session_id=X)                    │  • the merged warning text
  • see payload_json (omitted from the JSON to     │    BUT they don't know it's
    keep the response small — could add a          │    cloud vs local without
    /admin/event/:id endpoint)                     │    reading the [cloud]
  • see Worker logs (use `wrangler tail` for       │    prefix
    the live tail; only the admin has the          │
    Cloudflare credentials for that)               │
                                                   │
                                                   │  end-user cannot:
                                                   │  • see what other events
                                                   │    are happening
                                                   │  • opt into / out of
                                                   │    specific cloud rules
                                                   │    (yet — would need a
                                                   │    config block)
```

The asymmetry is intentional: the cloud governor is a *governance* layer, not a *collaborative* one. End-users are subject to it; admins inspect and tune it.

## 5. What's running RIGHT NOW vs what's just designed

```
        WHAT'S RUNNING                                   WHAT'S DESIGNED
        (binary + tests pass + observed working)         (memo only)
   ┌────────────────────────────────────┐         ┌────────────────────────────┐
   │ • Local daemon at                   │         │ Tier 2 — LLM policy gate    │
   │   .interlinked/harness.sock         │         │ • Workers AI binding        │
   │ • cloud_governor forward            │         │ • gpt-oss-safeguard on Groq │
   │ • cloud/ Worker on wrangler dev     │         │ • Trajectory-aware verdicts │
   │   (localhost:8787, NOT prod)        │         │ • Memo:                     │
   │ • Supervisor DO + SQLite events     │         │   tier-2-llm-policy-gate.md │
   │ • POST /governor/evaluate           │         ├────────────────────────────┤
   │ • GET /admin/recent                 │         │ Tier 3 — deep review        │
   │ • One ported rule (cf-dns-delete)   │         │ • Anthropic binding (Sonnet)│
   │ • Local-floor CF destructive rules  │         │ • Pre-push hook trigger     │
   │ • mergeCloudVerdict semantics       │         │ • Wide-scope review         │
   │ • Bearer auth (dev mode)            │         │ • Memo:                     │
   │ • Meta-test wrapper skip            │         │   tier-3-async-deep-review  │
   │ • Worker handler / DO FP fixes      │         ├────────────────────────────┤
   │   (fetch handler, this.ctx, hybrid) │         │ Artifacts integration       │
   │ • Tests: 80+ cloud, 100+ harness    │         │ • Project state snapshots   │
   └────────────────────────────────────┘         │ • Mirror-check substrate    │
                                                   ├────────────────────────────┤
                                                   │ Cloudflare Access OAuth     │
                                                   │ • Multi-tenant auth         │
                                                   │ • JWKS validation impl      │
                                                   │   (interface already stub)  │
                                                   ├────────────────────────────┤
                                                   │ Real Facet DO usage         │
                                                   │ • Per-session trajectory    │
                                                   │ • Already bound, not called │
                                                   ├────────────────────────────┤
                                                   │ Production deployment       │
                                                   │ • wrangler deploy from cloud│
                                                   │ • workers.dev URL           │
                                                   │ • Real BEARER_TOKEN secret  │
                                                   └────────────────────────────┘
```

The line between these two columns is the boundary between "today this is verifiably working" and "next sprint."

## 6. Pivots that shaped the architecture

Key design choices, with the conversation turn that locked them in:

1. **NOT an MCP server.** The cloud watches via forwarded hook events; the agent never calls cloud-side tools. Reason: agent compliance is unreliable; involuntary observation > voluntary tool-calling.

2. **DO as source of truth, not a cache of CLI state.** The Supervisor DO holds the events table; the CLI is one client among (eventually) many. Reason: enables standalone-of-CLI mode later.

3. **Auth not derived from CLI tokens.** Bearer-token validator is the interface; v1 swaps to JWKS-against-Access. Reason: same.

4. **Append-only event log + projections.** Never mutate or delete events; future tools read from the log. Reason: future tables (verdicts cache, mirror results, reviews) are derived from the same write path.

5. **Runner-compatible verdict shape.** Cloud returns the same `{decision, reason, warnings, rule_id}` shape the runner already understands. Reason: same merge logic works at every layer; no adapter code needed.

6. **Local-floor authority.** Local block/ask preserved as-is; cloud is advisory. Cloud block can escalate a local allow, cloud allow cannot downgrade a local block. Reason: cloud failure must not weaken safety.

7. **Module-cached config loader.** `cloud-forward.ts` reads `cloud_governor` from `config.local.json` once, caches. Restart daemon to pick up changes. Reason: simplicity over hot-reload for v0.

8. **Fail-open everywhere.** Cloud timeout → null verdict → local-only result. Reason: the harness must never deadlock the agent on a network issue.

Each of these costs almost nothing to honor today and is expensive to retrofit later.
