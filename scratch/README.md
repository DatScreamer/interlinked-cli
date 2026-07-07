# scratch/ — the sanctioned home for session & agent scripts

One-off scripts that agents (or humans) write during a session — analysis
probes, migration drivers, commit-bucketing helpers, data munging — belong
HERE, not in `/tmp` or the host session scratchpad. Rationale (operator
decision, 2026-07-07): a script that shapes real decisions deserves the same
scrutiny as the code it touches, and future sessions should be able to find
it.

What this location gives you:

- **Gated**: content-quality, security, biome/tsc diff-overlays, line and
  cyclomatic caps all apply — scratch code is first-class, not a workaround
  lane. The TDD companion-test gate and coverage ratchets are exempt here
  (like `scripts/`): demanding tests for one-offs would push work back to
  ungoverned temp dirs.
- **Greppable**: the directory is gitignored (except this README) but
  re-included for search — the root `.ignore` negation restores plain
  `rg`/`grep`, and the trigram index explicitly includes `scratch/` so the
  harness's accelerated greps see it too.
- **Durable**: survives the session; future agents can `rg scratch/` to find
  prior art instead of re-deriving it.

Conventions:

- One subdirectory per effort, date-prefixed: `scratch/2026-07-07-<slug>/`.
- Keep artifacts small and text-based; large/binary outputs still belong in
  the host scratchpad or `/tmp`.
- Anything that graduates to durable tooling moves to `scripts/` (committed)
  with the normal review bar.
