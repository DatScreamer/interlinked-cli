// ===========================================
// Guard Evaluator — root module (re-exports)
// ===========================================
//
// This file is intentionally small. It re-exports the public harness
// evaluator surface from the `./evaluator/` sub-directory so that
// existing callers (server.ts, tests, supply-chain-defense.test.ts,
// command-guard-parity.test.ts) continue to import from `./evaluator.js`
// without any churn.
//
// Layout:
//   evaluator/pre-tool.ts             — PreToolUse orchestrator
//   evaluator/post-tool.ts            — PostToolUse orchestrator
//   evaluator/write-content-guards.ts — Write/Edit content checks
//   evaluator/taint-guards.ts         — taint tracking + step budget
//   evaluator/filesystem-guards.ts    — protected files + repo confinement
//   evaluator/rule-matching.ts        — guard-rule pattern matching
//   evaluator/tool-classifiers.ts     — isBash / isFileWrite / globMatch
//   evaluator/permission-patterns.ts  — learn-a-permission logic
//   evaluator/tool-miss.ts            — BSD/GNU + "not found" hints

export { extractPermissionPattern } from "./evaluator/permission-patterns.js";
export { evaluatePostToolUse } from "./evaluator/post-tool.js";
export { evaluatePreToolUse } from "./evaluator/pre-tool.js";
