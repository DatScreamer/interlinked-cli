# Interlinked Structure V1 — Cross-Codebase Validation Prompt

Validate that the Generic Artifact Structure V1 system works correctly on any codebase with the Interlinked CLI installed. Run every step in order. Report any failure with the step number, exact error, and codebase details.

## Prerequisites

- Interlinked CLI is installed and built (`interlinked --help` works)
- You are in the root of the target codebase
- No `interlinked/` directory exists yet (remove it if leftover from a previous run)
- Note the codebase language/framework, OS, and Node.js version for the report

## Phase 1: CLI and Extraction (no manifests)

### Step 1: CLI available

```bash
interlinked --help | grep "structure"
```

PASS if output contains: `structure   Generic artifact structure management (manifests, catalogs, adoption)`

### Step 2: Scan without manifests

```bash
interlinked structure scan --full --json
```

PASS if: valid JSON, `"config_mode": "minimal"`, `"nodes"` > 0, no errors. Note the node count.

### Step 3: Status without manifests

```bash
interlinked structure status
```

PASS if: shows `Mode: minimal (implicit, no structure.json)`, cache fresh, adoption percentages listed.

## Phase 2: Manifest Setup

### Step 4: Initialize

```bash
interlinked structure init --mode standard --with public_api,env,tests,docs --write
```

PASS if: creates `interlinked/structure.json` and files under `interlinked/artifacts/`.

### Step 5: Verify files exist

```bash
cat interlinked/structure.json
ls interlinked/artifacts/
```

PASS if: `"version": 1, "mode": "standard"` in structure.json. Artifact files: `public-api.json`, `env.json`, `tests.json`, `docs.json`.

### Step 6: Rescan after init

Init invalidates the cache. Always rescan before doctor.

```bash
interlinked structure scan --full
```

PASS if: shows node count, edge count, config mode `standard`. Note the timing.

### Step 7: Doctor on clean scaffolds

```bash
interlinked structure doctor
```

PASS if: `Structure doctor: no issues found.`

### Step 8: Accept extracted env keys

```bash
interlinked structure accept
```

PASS if: reports accepted env keys (count depends on codebase). Note the count.

### Step 9: Rescan after accept

Accept modifies manifests. Rescan so adoption reflects the new declarations.

```bash
interlinked structure scan --full
```

PASS if: scan completes. Adoption for `env` should now be higher (check in next step).

## Phase 3: Verification

### Step 10: Verify --structure-only

```bash
interlinked verify --structure-only
```

PASS if: shows mode `standard`, findings counts, adoption percentages. `env` adoption should be > 0%.

### Step 11: Verify --structure-only --json

```bash
interlinked verify --structure-only --json
```

PASS if: valid JSON with `"structure"` key containing `mode`, `findings`, `adoption`, `details`, `catalog_fresh`.

### Step 12: Adoption gate (should fail)

```bash
interlinked verify --structure-only --adoption-gate; echo "exit: $?"
```

PASS if: exit code 1, messages showing categories below thresholds (e.g., config, glossary, layers, packages).

### Step 13: Invalid manifest detection — doctor

```bash
cp interlinked/structure.json interlinked/structure.json.bak
echo '{"version":2,"mode":"standard"}' > interlinked/structure.json
interlinked structure doctor; echo "exit: $?"
cp interlinked/structure.json.bak interlinked/structure.json && rm interlinked/structure.json.bak
```

PASS if: doctor reports `$.version: Must be 1`, exit code 1.

### Step 14: Invalid manifest detection — verify

```bash
cp interlinked/structure.json interlinked/structure.json.bak
echo '{"version":2,"mode":"standard"}' > interlinked/structure.json
interlinked verify --structure-only; echo "exit: $?"
cp interlinked/structure.json.bak interlinked/structure.json && rm interlinked/structure.json.bak
```

PASS if: exit code 2 (invalid structure configuration).

### Step 15: Baseline management

```bash
interlinked structure baseline save
interlinked structure baseline status
interlinked structure baseline clear
```

PASS if: save completes (0 findings is OK for fresh setup), status reports count or "No baseline saved", clear confirms deletion.

## Phase 4: Live PostToolUse Hook Integration

This phase requires the harness to be running. Skip if it's not available.

### Step 16: Check harness

```bash
interlinked harness status
```

PASS if: shows running with a PID and socket path. If not running, try `interlinked harness start` or skip to Phase 5.

### Step 17: Declare a public symbol with a companion

Find any exported function in the codebase. Replace `<source-file>`, `<module-id>`, and `<function-name>` with real values.

Write to `interlinked/artifacts/public-api.json`:
```json
{
  "version": 1,
  "modules": [
    {
      "id": "<module-id>",
      "file": "<source-file>",
      "symbols": [
        {
          "name": "<function-name>",
          "kind": "function",
          "stability": "public",
          "docs": ["doc-main"],
          "tests": [],
          "examples": []
        }
      ]
    }
  ]
}
```

Write to `interlinked/artifacts/docs.json`:
```json
{
  "version": 1,
  "docs": [
    {
      "id": "doc-main",
      "file": "README.md",
      "kind": "readme",
      "covers": [
        { "artifact_kind": "public_symbol", "artifact_id": "<module-id>#<function-name>" }
      ]
    }
  ]
}
```

### Step 18: Restart harness to pick up declarations

```bash
interlinked harness restart
```

Wait for it to report running, then verify:

```bash
interlinked harness status
```

PASS if: new PID, socket active.

### Step 19: Trigger companion finding

Edit the declared source file (add a comment). Do NOT edit README.md.

PASS if the PostToolUse hook output shows:
```
[interlinked:structure] public_symbol_companion_untouched
  file: <source-file>
  artifact: public_symbol <module-id>#<function-name>
  determinism: fully_deterministic
  provenance: declared
  required follow-ups:
    - README.md (doc)
```

If the first edit times out on a large repo, try a second edit — the graph is cached after the first call and subsequent edits should be fast.

### Step 20: Verify companion finding disappears when companion is touched

Now edit both the source file AND README.md in the same session.

PASS if: the structure companion finding does NOT appear (both files were touched).

## Phase 5: Enable Integration

### Step 21: Enable --structure dry run

```bash
interlinked enable --structure standard --dry-run
```

PASS if: output mentions structure scaffolding alongside hook configuration.

## Cleanup

Remove the test artifacts:

```bash
rm -rf interlinked/
```

## Report Template

```
Codebase: [language/framework, e.g., "Node.js/TypeScript monorepo"]
OS: [e.g., "macOS Darwin 25.3.0"]
Node: [e.g., "v22.22.0"]
Repo size: [node count from Step 2]
Scan time: [ms from Step 6]

Results:
- Phase 1 (Steps 1-3): PASS / FAIL [details]
- Phase 2 (Steps 4-9): PASS / FAIL [details]
- Phase 3 (Steps 10-15): PASS / FAIL [details]
- Phase 4 (Steps 16-20): PASS / FAIL / SKIPPED [details]
- Phase 5 (Step 21): PASS / FAIL [details]

Issues found: [list any failures with step number and error]
```
