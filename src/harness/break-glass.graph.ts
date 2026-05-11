// @generated supermodel-sidecar — do not edit
// @ts-nocheck
// [deps]
// imports     node:fs
// imports     node:path
// imports     ../lib/json-types.ts
// imported-by src/harness/break-glass.test.ts
// [calls]
// detectBreakGlass ← extractReason    src/harness/break-glass.ts:35
// extractReason ← detectBreakGlass    src/harness/break-glass.ts:39
// logBreakGlass → ensureDir    src/harness/break-glass.ts:73
// logBreakGlass → appendFileSync    src/harness/break-glass.ts:78
// readBreakGlassLog → tryParseEntry    src/harness/break-glass.ts:90
// summarizeBreakGlass → readBreakGlassLog    src/harness/break-glass.ts:148
// [impact]
// risk        MEDIUM
// domains     Harness · Governance
// direct      1
// transitive  2
// affects     src/harness/break-glass.test.ts
