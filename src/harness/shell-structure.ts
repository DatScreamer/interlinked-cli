// ===========================================
// Shell structure — the blessed command tokenizer contract
// ===========================================
// Every harness component that CLASSIFIES a Bash command (coverage discharge,
// package-install detection, commit detection, …) must consume these
// quote-aware primitives instead of regex-testing the raw command string.
// Raw-string matching sees inside quotes: `touch coverage/lcov.info && echo
// 'pytest --cov'` matched a runner regex and was classified as a green
// coverage run that discharged obligations without executing a single test
// (finding 2026-06, round 6) — the command-string twin of the literal-masking
// FP class the file-content detectors fixed with stripAllLiterals.
//
// Contract:
//   - `splitSegments(command)` → top-level segments split on `;`, `&&`, `||`,
//     and pipes, quote-aware (a separator inside a quoted argument is data).
//   - `shellSplit(segment)` → argv-like tokens; quoted text stays ONE token,
//     so `echo 'pytest --cov'` yields ["echo", "pytest --cov"] and a token
//     equality check can never mistake the argument for a runner invocation.
//   - `stripLeadingPrefix(tokens)` → drops `sudo` / `env VAR=…` / `VAR=…` so
//     the real head command is tokens[0].
// Classify per segment, by argv POSITION (head + arguments), never by
// substring presence.
//
// The implementations are currently homed in `evaluator/commit-parse.ts`
// (their original, heavily pinned birthplace); this module is the import
// surface the adversarial command-classifier corpus
// (`shell-structure.test.ts`) holds every consumer to. Residual limit, by
// design: segment-level exit codes are not observable from one compound exit
// status — `pytest --cov; true` reports the `true`.

export { shellSplit, splitSegments, stripLeadingPrefix } from "./evaluator/commit-parse.js";
