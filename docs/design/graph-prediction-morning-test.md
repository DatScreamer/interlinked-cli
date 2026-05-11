# Morning end-to-end test — graph-prediction protocol

A single prompt you can paste into a fresh Claude Code session to verify
everything the May 10–11 session built. The agent should walk through
each step, observe the harness's behavior, and report a verdict.

If anything doesn't match the expected behavior, the system is broken
and we need to debug — don't paper over a failure.

## Paste this into a new Claude Code session

```
I want you to verify the Interlinked graph-prediction protocol end-to-end.
Walk through every step below, run the actual commands, and tell me whether
the actual output matches the EXPECTED output. If anything diverges, stop
and report — do not try to fix it.

Step 1 — verify the harness daemon is up.
  Run: node dist/index.js harness status
  EXPECTED: shows a running daemon with a PID, uptime, and rule count.
  If the daemon is down: node dist/index.js harness start

Step 2 — run all five regression probes.
  Run each in turn:
    node .interlinked/e2e-protocol-probe.mjs
    node .interlinked/e2e-protocol-suite.mjs
    node .interlinked/e2e-hook-script.mjs
    node .interlinked/e2e-cold-fallback.mjs
    node .interlinked/e2e-stability.mjs    (this one takes ~30s)
  EXPECTED for each: prints "ALL ... ASSERTIONS PASSED" (or "TOTAL: 16/16
  passed" for the suite, "ALL STABILITY ASSERTIONS PASSED" for stability).
  Each probe is independent; if one fails, continue and report which.

Step 3 — exercise the live protocol with a real Edit.
  This file has a colocated fresh `.graph.ts` shard, so the protocol gates
  on it. Try this Edit (it's safe — change is reverted by the harness):
    Tool: Edit
    file_path: /Users/quentincody/interlinked-cli/src/harness/break-glass.ts
    old_string: BREAK_GLASS_VERSION = 1
    new_string: BREAK_GLASS_VERSION = 2
  EXPECTED on the first call: BLOCK with a message that names the sentinel
  path `.interlinked/predictions/incoming/<session_id>/break-glass.yaml`
  and asks you to write a YAML prediction there.

Step 4 — write the prediction.
  Use the Write tool to land bare YAML at the sentinel path the block
  message named. Format:
    graph_prediction:
      file: /Users/quentincody/interlinked-cli/src/harness/break-glass.ts
      deps:
        imports:
          - node:fs
        imported_by:
          - some/caller.ts
      impact:
        risk: medium
        direct: 1
        domains:
          - X
  EXPECTED: Write succeeds, harness returns a "prediction accepted" message.

Step 5 — retry the Edit from Step 3.
  EXPECTED: Edit ALLOWED, and the response includes
  `hookSpecificOutput.additionalContext` containing
  "[interlinked:graph-pred] Comparison for ..." with per-section scores.
  The agent sees this; the human can also see it by checking activity
  immediately after via `node dist/index.js activity --short`.

Step 6 — inspect the data substrate.
  Run: node .interlinked/graph-stats.mjs
  EXPECTED: prints "total events", "avg weighted_avg" (~0.9+ healthy),
  severity distribution, top files, and a "Learning curve" section for
  files with ≥3 events.

Step 7 — verify the cold-fallback gate.
  Stop the daemon: node dist/index.js harness stop
  Try the same Edit from Step 3.
  EXPECTED: BLOCK with message "[interlinked:graph-pred][harness-offline]
  Cannot evaluate the graph-prediction protocol because the harness daemon
  is unreachable, but ... Edits to E-fresh files MUST go through the
  predict/reveal/reconcile loop. Start the harness with: interlinked
  harness start".

Step 8 — restart and confirm.
  Run: node dist/index.js harness start
  Wait 2s, then: node dist/index.js harness status
  EXPECTED: new PID, rules loaded.

Report at the end: which steps matched expected behavior, which (if any)
diverged, and what you observed. Do not commit anything.
```

## What you should expect to see

If the protocol is working, every step matches. The most telling steps:

- **Step 3** proves the happy-path block fires (protocol is enforced).
- **Step 5** proves the reconciliation lands and the comparison reaches
  the model via `additionalContext` (the model-visible reveal).
- **Step 7** proves the cold-fallback gate engages even when the daemon
  is dead — the protection holds during outages.

## If something diverges

- Step 3 doesn't block: `cat .interlinked/config.json` and confirm
  `harness.graph_prediction.mode` is `soft_gate` or `enforced` (not
  `shadow`).
- Step 7 doesn't block: confirm `dist/hook-entry.js` is fresh
  (`ls -la dist/hook-entry.js src/hook-entry.ts` — dist should be newer).
  If not: `npm run build`.
- Stability probe fails the OOM check: `grep "FATAL ERROR"
  .interlinked/logs/daemon.log | tail -5` and check whether new
  crashes appeared. The default heap is now 4 GB.
