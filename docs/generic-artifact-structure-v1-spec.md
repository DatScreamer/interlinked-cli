# Interlinked CLI / Harness — Generic Artifact Structure V1 Spec

Status: Proposed v1 implementation spec

Audience:
- Interlinked CLI maintainers
- Interlinked Harness maintainers
- Teams adopting Interlinked on arbitrary repositories

Scope:
- Improvements to the Interlinked CLI / Harness system
- Generic artifact support that can be applied to any codebase at all
- No framework-specific route, ORM, or CLI extraction in v1

Non-scope:
- Repo-specific business logic
- Framework-specific adapters beyond simple language and file conventions
- Hook-time blocking for non-security repo-structure issues

## 1. Problem Statement

The current Interlinked Harness is good at:
- destructive-command blocking
- quality checks after edits
- structural dependency checks around imports and exports
- surfacing follow-up work after some code changes

It is not yet a generic repo-understanding system. It lacks a first-class model for:
- what artifacts in a repo matter to downstream readers and agents
- which files are companions of which other files
- what is declared versus extracted versus inferred
- how much of a repo is machine-readable enough for deterministic enforcement

V1 introduces a generic artifact structure system so that Interlinked can:
- attach to any repository with zero custom code
- classify what it knows with explicit determinism levels
- provide better `PostToolUse` follow-up guidance
- make `interlinked verify` enforce deterministic companion failures when enabled
- help teams gradually adopt more machine-readable repo structure without requiring framework-specific support

## 2. Product Goals

V1 must:
- work on arbitrary repositories with generic artifacts only
- improve agent continuity and repo navigation without blocking normal work
- keep `PostToolUse` repo-structure findings informational, not blocking
- keep destructive and security blocking where it already belongs: `PreToolUse`
- give `interlinked verify` a clear, enforceable structure layer
- separate deterministic facts from partial conventions and heuristics
- support progressive adoption rather than requiring a fully annotated repo

V1 should:
- provide scaffolding for committed structure manifests
- provide local generated catalogs and caches
- provide stable JSON formats that can be versioned
- support diff-aware follow-up tracking
- avoid framework lock-in

V1 must not:
- execute application code to discover structure
- rely on an LLM for core correctness
- claim determinism when only conventions are available
- require repos to adopt all manifests before getting value
- block edit/write actions for non-security structure findings

## 3. Design Principles

1. Default to non-blocking guidance.
`PostToolUse` structure findings exist to help the agent self-correct in real time.

2. Determinism must be explicit.
Every structure result must say whether it is:
- `fully_deterministic`
- `partially_deterministic`
- `heuristic`

3. Provenance must be explicit.
Every artifact and finding must carry provenance:
- `declared`
- `extracted`
- `inferred`

4. Adoption must be progressive.
Interlinked should produce useful output on day one, then become more enforceable as a repo adopts manifests.

5. Generic first.
V1 supports artifact kinds that make sense in any repo:
- modules
- public symbols
- packages
- env keys
- config keys
- tests
- docs
- examples
- glossary terms
- layers

6. `verify` is the repo-wide gate.
Hook-time feedback helps the current agent. `interlinked verify` catches whole-repo issues and is what CI/CD should run.

## 4. Determinism Model

### 4.1 Determinism Classes

`fully_deterministic`
- Backed by declared manifests or exact parser-extracted facts.
- Example: a declared public symbol changed and its declared docs/test/example companions were not updated.

`partially_deterministic`
- Backed by extracted facts plus conventions or incomplete declarations.
- Example: a public-looking symbol changed and Interlinked mapped likely tests by file naming and import graph.

`heuristic`
- Ranked guidance only.
- Example: a new high-fanout module probably needs a purpose docstring.

### 4.2 Provenance Classes

`declared`
- Comes from committed Interlinked structure files.

`extracted`
- Comes from static analysis or parser-supported extraction.

`inferred`
- Comes from naming/path conventions, token matching, or proximity rules.

### 4.3 Enforcement Rules

`PreToolUse`
- Existing destructive and security rules may block.
- Repo-structure checks do not block in v1.

`PostToolUse`
- Repo-structure findings never block.
- Findings are emitted as warnings with determinism and provenance.

`interlinked verify`
- Tool failures keep existing behavior.
- `fully_deterministic` structure failures may fail verification when enabled.
- `partially_deterministic` and `heuristic` findings do not fail verification by default.

## 5. Artifact Kinds In Scope For V1

### 5.1 Active Artifact Kinds

`module`
- A source file or source module.

`public_symbol`
- A symbol exposed as part of the repo's intended public surface.

`package`
- A package or repo sub-boundary rooted by a package marker.

`env_key`
- An environment variable referenced or declared by the repo.

`config_key`
- A structured configuration key referenced or declared by the repo.

`test`
- A test file or test bundle associated with another artifact.

`doc`
- A documentation file associated with another artifact.

`example`
- An example or sample file associated with another artifact.

`term`
- A canonical glossary term and its aliases or deprecated forms.

`layer`
- A declared architectural layer or boundary label.

### 5.2 Deferred Artifact Kinds

These are intentionally deferred to later versions:
- `route`
- `schema_entity`
- `migration`
- `cli_command`
- `cli_flag`

The data model may reserve names for these, but V1 does not depend on them.

## 6. On-Disk Layout

### 6.1 Committed Files

These files live in the repository and are intended to be committed:

```text
interlinked/
  structure.json
  artifacts/
    public-api.json
    env.json
    config.json
    tests.json
    docs.json
    examples.json
    glossary.json
    layers.json
    packages.json
```

### 6.2 Local Generated Files

These files live under `.interlinked/` and are local/runtime artifacts:

```text
.interlinked/
  structure-cache/
    catalog-meta.json
    artifact-nodes.json
    artifact-edges.json
    public-symbol-catalog.json
    env-catalog.json
    config-catalog.json
    package-catalog.json
    test-catalog.json
    docs-catalog.json
    examples-catalog.json
    glossary-catalog.json
    adoption-report.json
    baseline.json
```

### 6.3 Directory Policy

- `interlinked/` is committed structure data.
- `.interlinked/` remains local runtime state.
- `interlinked/` files are authored and updated by users and Interlinked commands.
- `.interlinked/structure-cache/` is rebuilt and invalidated by Interlinked.

## 7. Root File Schema

The required root file is `interlinked/structure.json`.

Unknown keys are invalid.
All relative paths use POSIX separators.
All paths are repo-relative.

### 7.0 Global Validation Rules

These rules apply to all committed structure files in v1:
- JSON only, UTF-8 encoded, no comments, no trailing commas
- unknown keys are invalid at every object level, not just the top level
- declared local IDs must match `^[A-Za-z0-9][A-Za-z0-9._-]*$`
- arrays that behave like sets must not contain duplicates
- all file paths must be repo-relative and must not start with `/` or `../`
- globs must be repo-relative and use POSIX separators
- references by ID must point to an existing declared object of the expected kind
- if a declared file path does not exist, verification returns invalid structure
- `:` is reserved for global artifact-reference prefixes
- `#` is reserved for derived public-symbol local IDs
- declared IDs must be unique within their artifact-kind namespace
- cross-kind ID collisions are allowed because global references are always kind-qualified
- individual artifact schemas may impose stricter ID rules than the global baseline

### 7.1 Exact JSON Shape

```json
{
  "version": 1,
  "mode": "standard",
  "artifacts": {
    "public_api": "artifacts/public-api.json",
    "env": "artifacts/env.json",
    "config": "artifacts/config.json",
    "tests": "artifacts/tests.json",
    "docs": "artifacts/docs.json",
    "examples": "artifacts/examples.json",
    "glossary": "artifacts/glossary.json",
    "layers": "artifacts/layers.json",
    "packages": "artifacts/packages.json"
  },
  "verify": {
    "fail_on_deterministic": true,
    "fail_on_invalid_structure": true,
    "fail_on_partial": false,
    "fail_on_heuristic": false
  },
  "posttooluse": {
    "emit_deterministic": true,
    "emit_partial": true,
    "emit_heuristic": true,
    "max_heuristics": 3
  },
  "adoption": {
    "coverage_thresholds": {
      "public_api": 0.6,
      "env": 0.8,
      "config": 0.8,
      "tests": 0.5,
      "docs": 0.5,
      "examples": 0.3,
      "glossary": 0.4,
      "layers": 0.7,
      "packages": 1.0
    }
  },
  "builtins": {
    "public_symbol_companions": true,
    "env_key_companions": true,
    "config_key_companions": true,
    "layer_boundary_violations": true,
    "glossary_residue": true,
    "package_boundary_violations": true
  }
}
```

### 7.2 Field Semantics

`version`
- Must be `1`.

`mode`
- One of `minimal`, `standard`, `strict`.
- `minimal`: manifests optional, warnings only for most structure issues.
- `standard`: deterministic findings enabled where manifests or extracted facts exist.
- `strict`: deterministic manifest-backed failures expected in `verify`.

Mode sets defaults.
Explicit values under `verify`, `posttooluse`, and `adoption` override mode defaults.

V1 mode defaults:
- `minimal`
  - `verify.fail_on_deterministic = false`
  - `verify.fail_on_invalid_structure = true`
  - `posttooluse.emit_deterministic = true`
  - `posttooluse.emit_partial = true`
  - `posttooluse.emit_heuristic = true`
- `standard`
  - `verify.fail_on_deterministic = true`
  - `verify.fail_on_invalid_structure = true`
  - `posttooluse.emit_deterministic = true`
  - `posttooluse.emit_partial = true`
  - `posttooluse.emit_heuristic = true`
- `strict`
  - `verify.fail_on_deterministic = true`
  - `verify.fail_on_invalid_structure = true`
  - `posttooluse.emit_deterministic = true`
  - `posttooluse.emit_partial = true`
  - `posttooluse.emit_heuristic = true`
  - `--adoption-gate` is recommended in CI/CD

In v1, `strict` is intentionally not stricter on partial or heuristic findings.
Its additional strictness comes from adoption expectations and CI/CD usage with `--adoption-gate`,
not from failing on partially deterministic or heuristic output by default.

`artifacts`
- Map of artifact file identifiers to repo-relative JSON files.
- Keys are optional.
- Missing files are allowed only if the corresponding artifact kind is intentionally not adopted yet.

`verify`
- Governs `interlinked verify --structure`.

`posttooluse`
- Governs hook-time emission, not blocking.

`adoption`
- Coverage thresholds used by `structure status` and optional strictness escalation.

`builtins`
- Toggles built-in rule families.

### 7.3 Version Compatibility Rules

Committed structure files:
- V1 implementations must require `version === 1`
- if `version > 1`, reject as unsupported committed structure
- if `version < 1`, reject as unsupported committed structure

Generated cache files:
- must carry a `schema_version`
- caches with a different `schema_version` must be ignored and rebuilt
- caches with a mismatched CLI major schema must never be trusted

## 8. Artifact IDs And Cross-References

V1 distinguishes between:
- local artifact IDs
- global artifact references

Local artifact IDs:
- are kind-local
- must not contain `:`
- are declared directly in artifact files or derived by Interlinked

Global artifact references:
- are formatted as `<artifact_kind>:<local_id>`
- are used for graph node IDs and internal cache references

Examples:
- `doc:doc-api-create-client`
- `test:test-create-client-contract`
- `env_key:API_BASE_URL`
- `config_key:http.timeoutMs`
- `public_symbol:pkg-index#createClient`

For `config_key`, the local ID is the dotted key path itself.
Example: `http.timeoutMs` is the local ID and `config_key:http.timeoutMs` is the global reference.

Public-symbol local IDs are derived, not authored directly:
- format: `<module-id>#<symbol-name>`
- example: `pkg-index#createClient`
- default exports use the derived symbol name `default`

Cross-file `covers` references use split fields:
- `artifact_kind`
- `artifact_id`

In `covers`, `artifact_id` means the local ID, not the global artifact reference.

Examples:
- `artifact_kind = "public_symbol", artifact_id = "pkg-index#createClient"`
- `artifact_kind = "env_key", artifact_id = "API_BASE_URL"`
- `artifact_kind = "config_key", artifact_id = "http.timeoutMs"`

## 9. Artifact File Schemas

Each artifact file:
- must be valid JSON
- must include `"version": 1`
- must reject unknown top-level keys

### 9.1 `artifacts/public-api.json`

Purpose:
- declare public modules and symbols
- attach deterministic docs/tests/examples companions

Exact shape:

```json
{
  "version": 1,
  "modules": [
    {
      "id": "pkg-index",
      "file": "src/index.ts",
      "symbols": [
        {
          "name": "createClient",
          "kind": "function",
          "stability": "public",
          "docs": ["doc-api-create-client"],
          "tests": ["test-create-client-contract"],
          "examples": ["example-create-client-basic"]
        }
      ]
    }
  ]
}
```

Rules:
- `id` must be unique among modules.
- `file` must exist or verification fails with invalid structure.
- `kind` must be one of `function`, `class`, `type`, `interface`, `const`, `enum`, `default_export`.
- `stability` must be one of `public`, `beta`, `internal`.
- `docs`, `tests`, and `examples` contain IDs declared in their respective artifact files.

### 9.2 `artifacts/env.json`

Purpose:
- declare canonical environment keys and companions

Exact shape:

```json
{
  "version": 1,
  "sources": {
    "declarations": [".env.example"],
    "defaults": ["src/config/defaults.ts"]
  },
  "keys": [
    {
      "name": "API_BASE_URL",
      "required": true,
      "docs": ["doc-config-env"],
      "tests": ["test-env-validation"],
      "examples": [],
      "default_sources": ["src/config/defaults.ts"]
    }
  ]
}
```

Rules:
- `name` must match `^[A-Z][A-Z0-9_]*$`.
- `default_sources` paths must exist if provided.
- `docs`, `tests`, `examples` must reference declared IDs.

### 9.3 `artifacts/config.json`

Purpose:
- declare canonical configuration keys and companions

Exact shape:

```json
{
  "version": 1,
  "roots": [
    {
      "id": "app-config",
      "file": "src/config/schema.ts"
    }
  ],
  "keys": [
    {
      "name": "http.timeoutMs",
      "required": false,
      "docs": ["doc-config-http"],
      "tests": ["test-http-config"],
      "examples": [],
      "declared_in": ["src/config/schema.ts"]
    }
  ]
}
```

Rules:
- `name` is a stable dotted key path.
- `declared_in` values must exist.

### 9.4 `artifacts/tests.json`

Purpose:
- declare reusable test IDs and optional source coverage mappings

Exact shape:

```json
{
  "version": 1,
  "tests": [
    {
      "id": "test-create-client-contract",
      "file": "test/create-client.contract.test.ts",
      "kind": "contract",
      "covers": [
        {
          "artifact_kind": "public_symbol",
          "artifact_id": "pkg-index#createClient"
        }
      ]
    }
  ]
}
```

Rules:
- `kind` must be one of `unit`, `integration`, `contract`, `golden`, `smoke`.
- `covers` may reference any V1 artifact kind.
- for public symbols, `artifact_id` format is `<module-id>#<symbol-name>`.
- companion resolution in v1 is only defined for:
  - `public_symbol`
  - `env_key`
  - `config_key`
- other `covers` targets are informational unless a later rule family defines behavior for them.

### 9.5 `artifacts/docs.json`

Purpose:
- declare reusable documentation IDs and coverage mappings

Exact shape:

```json
{
  "version": 1,
  "docs": [
    {
      "id": "doc-api-create-client",
      "file": "docs/api/create-client.md",
      "kind": "reference",
      "covers": [
        {
          "artifact_kind": "public_symbol",
          "artifact_id": "pkg-index#createClient"
        }
      ]
    }
  ]
}
```

Rules:
- `kind` must be one of `reference`, `guide`, `concept`, `readme`, `runbook`.
- `covers` may reference any V1 artifact kind.
- companion resolution in v1 is only defined for:
  - `public_symbol`
  - `env_key`
  - `config_key`
- other `covers` targets are informational unless a later rule family defines behavior for them.

### 9.6 `artifacts/examples.json`

Purpose:
- declare reusable examples and coverage mappings

Exact shape:

```json
{
  "version": 1,
  "examples": [
    {
      "id": "example-create-client-basic",
      "file": "examples/create-client-basic.ts",
      "covers": [
        {
          "artifact_kind": "public_symbol",
          "artifact_id": "pkg-index#createClient"
        }
      ]
    }
  ]
}
```

Rules:
- `covers` may reference any V1 artifact kind.
- companion resolution in v1 is only defined for:
  - `public_symbol`
  - `env_key`
  - `config_key`
- other `covers` targets are informational unless a later rule family defines behavior for them.

Companion resolution in V1 may be one-directional or bidirectional:
- one-directional: `env.json` or `config.json` names companion IDs directly
- bidirectional: docs/tests/examples also declare `covers`

When both directions are present, Interlinked should validate consistency.
When only one direction is present, Interlinked may still resolve the companion relationship.

### 9.7 `artifacts/glossary.json`

Purpose:
- declare canonical terms and deprecated or alias forms

Exact shape:

```json
{
  "version": 1,
  "terms": [
    {
      "id": "agent-handle",
      "canonical": "agent handle",
      "aliases": ["agent id"],
      "deprecated": ["worker id"],
      "docs": ["doc-glossary-agents"]
    }
  ]
}
```

Rules:
- `canonical`, `aliases`, and `deprecated` are compared case-insensitively.
- `canonical` must not appear in another term entry's `canonical`, `aliases`, or `deprecated` fields.

### 9.8 `artifacts/layers.json`

Purpose:
- declare generic architectural boundaries

Exact shape:

```json
{
  "version": 1,
  "layers": [
    {
      "id": "domain",
      "globs": ["src/domain/**"]
    },
    {
      "id": "app",
      "globs": ["src/app/**"]
    }
  ],
  "rules": [
    {
      "from": "domain",
      "cannot_import": ["app"],
      "reason": "Domain code must not depend on application wiring."
    }
  ]
}
```

Rules:
- `from` and `cannot_import` values must reference declared layer IDs.
- `reason` should be a concise human-readable sentence and should stay under 160 characters.

### 9.9 `artifacts/packages.json`

Purpose:
- declare package roots and optional public entry files in monorepos or multi-package repos

Exact shape:

```json
{
  "version": 1,
  "packages": [
    {
      "id": "cli",
      "root": "cli",
      "entrypoints": ["cli/src/index.ts"]
    }
  ]
}
```

Rules:
- `root` must exist.
- `entrypoints` must exist if provided.

## 10. Generic Artifact Graph Model

The ArtifactGraph is an internal Interlinked data model built from:
- committed manifests
- extracted static analysis
- inferred conventions

If `interlinked/structure.json` is absent:
- Interlinked operates in implicit `minimal` mode
- all artifacts come from `extracted` or `inferred` sources only
- no missing-manifest condition is treated as invalid structure by itself

### 10.1 Node Shape

```json
{
  "id": "public_symbol:pkg-index#createClient",
  "kind": "public_symbol",
  "label": "createClient",
  "file": "src/index.ts",
  "provenance": "declared",
  "determinism_ceiling": "fully_deterministic",
  "metadata": {
    "module_id": "pkg-index",
    "symbol_kind": "function"
  }
}
```

### 10.2 Edge Shape

```json
{
  "id": "edge:public_symbol:pkg-index#createClient->doc:doc-api-create-client",
  "kind": "documents",
  "from": "public_symbol:pkg-index#createClient",
  "to": "doc:doc-api-create-client",
  "provenance": "declared",
  "confidence": 1.0
}
```

### 10.3 Edge Kinds

V1 edge kinds:
- `exports`
- `imports`
- `belongs_to_package`
- `belongs_to_layer`
- `documents`
- `tests`
- `illustrates`
- `aliases_term`
- `declares_env`
- `references_env`
- `declares_config`
- `references_config`

### 10.4 Graph Sources

`declared`
- built from `interlinked/` manifests

`extracted`
- built from static parsing and local scanners

`inferred`
- built from naming, path, or text conventions

## 11. Generated Cache Contracts

Generated cache files are not committed, but they still need a versioned contract.

### 11.1 `catalog-meta.json`

Exact minimum shape:

```json
{
  "schema_version": 1,
  "cli_version": "0.2.0",
  "built_at": "2026-03-26T12:00:00.000Z",
  "repo_root": "/abs/path/to/repo",
  "last_scanned_commit": "abc123def456",
  "manifest_hash": "sha256:...",
  "extractor_versions": {
    "module": 1,
    "public_symbol": 1,
    "env": 1,
    "config": 1,
    "test": 1,
    "docs": 1,
    "examples": 1,
    "package": 1
  }
}
```

### 11.2 `artifact-nodes.json`

Exact minimum shape:

```json
{
  "schema_version": 1,
  "nodes": []
}
```

Each entry in `nodes` must match the node shape from Section 10.1.

### 11.3 `artifact-edges.json`

Exact minimum shape:

```json
{
  "schema_version": 1,
  "edges": []
}
```

Each entry in `edges` must match the edge shape from Section 10.2.

### 11.4 Category Catalog Files

Files such as `public-symbol-catalog.json` and `env-catalog.json` must have:

```json
{
  "schema_version": 1,
  "items": []
}
```

Each item must include:
- `local_id`
- `global_ref`
- `file`
- `provenance`
- `determinism_ceiling`

Cache files may include additional fields beyond the minimum required schema.
Committed structure files reject unknown keys; generated cache files do not.

### 11.5 `adoption-report.json`

Exact minimum shape:

```json
{
  "schema_version": 1,
  "categories": {
    "public_api": 0.0,
    "env": 0.0,
    "config": 0.0,
    "tests": 0.0,
    "docs": 0.0,
    "examples": 0.0,
    "glossary": 0.0,
    "layers": 0.0,
    "packages": 0.0
  }
}
```

### 11.6 `baseline.json`

Exact minimum shape:

```json
{
  "schema_version": 1,
  "entries": []
}
```

Baseline entries must store:
- `finding_name`
- `artifact_ref`
- `source_file`
- `determinism`
- `required_companion_files`
- `context_hash`

## 12. Extraction and Adapter Model

V1 ships generic extractors only.

### 12.1 Generic Extractors

`module extractor`
- discovers source files by language extension and package roots

`public symbol extractor`
- extracts exports from supported source languages where possible
- falls back to path-based entrypoint extraction for unsupported languages

`env extractor`
- finds `process.env.*`, `import.meta.env.*`, `os.Getenv`, `getenv`, and similar common patterns

`config extractor`
- finds dotted or indexed access against known config roots where extraction is safe

`test extractor`
- uses naming conventions and import graph proximity

`docs extractor`
- scans `docs/`, `README*`, `*.md`, `*.mdx`, `*.rst`

`examples extractor`
- scans `examples/`, `sample/`, `samples/`, `demo/`

`glossary extractor`
- no automatic authoritative glossary in v1
- may extract candidate repeated terms for `structure accept`, but not as deterministic facts

`layer extractor`
- none by default
- layers are declared only in v1

`package extractor`
- package roots from `package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, or repo root fallback

### 12.2 Adapter Contract

Each extractor must declare:
- supported file patterns
- exact output artifact kinds
- whether output is `extracted` or `inferred`
- maximum determinism class it can support
- cache invalidation keys

### 12.3 Execution Constraints

Extractors must:
- not execute repo code
- not make network calls
- not run package managers
- operate from static reads only

## 13. Built-In Rule Families

V1 ships built-in rule families only. Arbitrary custom rule DSL is out of scope.

### 13.1 Public Symbol Companions

Trigger:
- declared or extracted public symbol changes

Required companions:
- declared docs
- declared tests
- declared examples

Result class:
- `fully_deterministic` if symbol and companions are declared
- `partially_deterministic` if symbol is extracted and companions are inferred

### 13.2 Env Key Companions

Trigger:
- new env key
- removed env key
- renamed env key

Required companions:
- declared docs
- declared tests
- declared default sources

### 13.3 Config Key Companions

Trigger:
- new config key
- removed config key
- renamed config key

Required companions:
- declared docs
- declared tests
- declared declaration sources

### 13.4 Layer Boundary Violations

Trigger:
- import edge crosses a forbidden declared layer boundary

Result class:
- `fully_deterministic`

### 13.5 Package Boundary Violations

Trigger:
- import edge crosses a package boundary against package rules

Result class:
- `fully_deterministic` when package roots are declared
- `partially_deterministic` when package roots are extracted only

### 13.6 Glossary Residue

Trigger:
- deprecated term still appears in edited files after canonical term adoption

Result class:
- `fully_deterministic` if glossary is declared
- otherwise not emitted as deterministic

## 14. Hook Pipeline Changes

### 14.1 PreToolUse

V1 adds non-blocking structure context injection only.

New PreToolUse structure context:
- whether target file is a declared public module
- which deterministic companions exist
- whether unresolved deterministic follow-ups already exist
- whether target file belongs to a declared layer or package boundary

PreToolUse must not block on structure findings in v1.

### 14.2 PostToolUse

New PostToolUse sequence:
1. Existing quality checks
2. Existing structural checks
3. Artifact graph incremental refresh for changed files
4. Built-in deterministic rule evaluation
5. Partial convention-based rule evaluation
6. Existing heuristic suggestion scoring
7. Session follow-through tracking update

### 14.3 Follow-Through Tracking

The existing completion tracking model must be generalized from export changes to artifact changes.

New tracked pending completion types:
- `public_symbol_companions`
- `env_key_companions`
- `config_key_companions`
- `glossary_cleanup`

Each pending completion stores:
- source artifact reference
- source file
- finding class
- required companion files
- resolved companion files
- determinism
- provenance
- first detected tool call

## 15. Machine-Readable Hook Output

`CheckResultEntry` must be extended with:

```json
{
  "source": "structure",
  "name": "public_symbol_companions",
  "severity": "warning",
  "message": "Public symbol createClient changed without companion updates.",
  "file": "src/index.ts",
  "detail": "Declared companions were not touched.",
  "line": 1,
  "affected_files": [
    "docs/api/create-client.md",
    "test/create-client.contract.test.ts",
    "examples/create-client-basic.ts"
  ],
  "determinism": "fully_deterministic",
  "provenance": "declared",
  "artifact_kind": "public_symbol",
  "artifact_id": "pkg-index#createClient",
  "required_updates": [
    {
      "file": "docs/api/create-client.md",
      "kind": "doc",
      "reason": "declared companion"
    }
  ],
  "confidence": 1.0
}
```

`CheckResultEntry.source` must add:
- `structure`

Required new fields:
- `determinism`
- `provenance`
- `artifact_kind`
- `artifact_id`
- `required_updates`
- `confidence`

## 16. Human Hook Output Format

Hook-time stderr should prefer compact, high-signal structure output.

Canonical format:

```text
[interlinked:structure] public_symbol_companions
  file: src/index.ts
  artifact: public_symbol pkg-index#createClient
  determinism: fully_deterministic
  provenance: declared
  required follow-ups:
    - docs/api/create-client.md (doc)
    - test/create-client.contract.test.ts (test)
    - examples/create-client-basic.ts (example)
```

Formatting rules:
- deterministic findings first
- partial findings second
- heuristics last
- max heuristic findings comes from `posttooluse.max_heuristics`
- no generic lecture text
- always include exact file paths when known

## 17. `interlinked verify --structure`

### 17.1 Command Behavior

`interlinked verify --structure`
- runs generic artifact scan if cache is stale
- validates committed manifests
- rebuilds or refreshes the ArtifactGraph
- evaluates deterministic and partial structure rules repo-wide
- emits JSON and human-readable output

If `interlinked/structure.json` is absent:
- run in implicit `minimal` mode
- do not return exit code `2`
- only emit extracted or inferred structure findings

`interlinked verify --structure-only`
- runs structure checks only

`interlinked verify --adoption-gate`
- fails when invalid structure configuration exists
- optionally fails when adopted categories drop below declared thresholds

### 17.2 Verify Exit-Code Policy

V1 exit codes:

`0`
- no enforceable failures

`1`
- enforceable verification failures
- includes existing tool failures
- includes deterministic structure failures when `fail_on_deterministic` is enabled

`2`
- invalid Interlinked structure configuration
- malformed or unreadable `interlinked/` files
- broken file references in declared manifests

`3`
- internal Interlinked execution failure

Partial and heuristic structure findings do not change exit code by default.

### 17.3 CI/CD Meaning

CI/CD here means any automation that treats `interlinked verify` as a gate:
- GitHub Actions
- pre-push hooks
- Buildkite
- CircleCI
- local release scripts

It is not specific to GitHub, though GitHub Actions is the expected common case.

## 18. Verify JSON Output

New `structure` section:

```json
{
  "structure": {
    "mode": "standard",
    "catalog_fresh": true,
    "invalid_files": [],
    "adoption": {
      "public_api": 0.75,
      "env": 1.0,
      "config": 0.5,
      "tests": 0.6,
      "docs": 0.55,
      "examples": 0.2,
      "glossary": 0.0,
      "layers": 0.0,
      "packages": 1.0
    },
    "findings": {
      "fully_deterministic": 2,
      "partially_deterministic": 4,
      "heuristic": 3
    },
    "details": [
      {
        "name": "public_symbol_companions",
        "determinism": "fully_deterministic",
        "provenance": "declared",
        "file": "src/index.ts",
        "artifact_id": "pkg-index#createClient",
        "required_updates": [
          {
            "file": "docs/api/create-client.md",
            "kind": "doc",
            "reason": "declared companion"
          }
        ]
      }
    ]
  }
}
```

## 19. Adoption Model

### 19.1 Adoption Levels

`minimal`
- no committed files required beyond optional `structure.json`
- Interlinked can run in extracted and inferred mode only
- no structure finding blocks hooks
- verification fails only on invalid structure config if present

`standard`
- committed root file expected
- some artifact files adopted
- deterministic checks active where declarations exist

`strict`
- committed root file required
- adopted categories expected to stay above thresholds
- deterministic structure failures fail `verify`

### 19.2 Coverage Calculation

Each category reports a number from `0.0` to `1.0`.

Examples:
- `public_api`: declared public symbols / extracted public-looking symbols
- `env`: declared env keys / extracted referenced env keys
- `tests`: declared test bundles / extracted likely companion targets
- `docs`: declared docs bundles / extracted likely doc targets

Coverage is advisory in v1 except where explicitly used by `--adoption-gate`.

### 19.3 Baselines

Baselines are local, not committed, by default.

Location:
- `.interlinked/structure-cache/baseline.json`

Purpose:
- suppress known existing structure drift
- report only newly introduced deterministic or partial issues

Baseline entries store:
- finding name
- artifact reference
- source file
- determinism
- required companion files
- hash of manifest/catalog context

## 20. New CLI Commands

### 20.1 `interlinked structure init`

Purpose:
- create `interlinked/structure.json`
- optionally scaffold empty artifact files

Options:
- `--mode minimal|standard|strict`
- `--with public_api,env,config,tests,docs,examples,glossary,layers,packages`
- `--write`
- `--json`

Default behavior:
- dry-run preview unless `--write` is given
- when `--write` is used, Interlinked should ensure `.interlinked/` remains ignored
- `structure init` must never add `interlinked/` to `.gitignore`

### 20.2 `interlinked structure scan`

Purpose:
- build or refresh local generated catalogs

Options:
- `--full`
- `--incremental`
- `--json`

`--incremental` staleness rules:
- compare committed manifest hashes against `catalog-meta.json`
- compare extractor versions against `catalog-meta.json`
- compare current file mtimes or hashes for previously indexed files
- if the repo is a git repo, use git diff against the last scanned commit when available
- refresh only categories whose inputs changed
- fall back to `--full` behavior if cache metadata is missing or invalid

### 20.3 `interlinked structure status`

Purpose:
- show adoption coverage
- show stale caches
- show invalid manifest references

### 20.4 `interlinked structure accept`

Purpose:
- promote extracted findings into committed artifact files

V1 scope:
- accept candidate public symbols
- accept extracted env keys
- accept candidate docs/tests/examples links

Conflict behavior:
- if an extracted finding conflicts with an existing declared entry, `structure accept` must not silently merge
- the default behavior is `warn-and-skip`
- a later enhancement may add explicit `--merge` or `--replace` modes, but v1 should require an explicit user decision for conflicts

### 20.5 `interlinked structure doctor`

Purpose:
- validate structure files
- validate cache freshness
- show broken IDs and paths

### 20.6 `interlinked structure baseline`

Subcommands:
- `save`
- `clear`
- `status`

### 20.7 `interlinked enable --structure`

New option:
- `--structure minimal|standard|strict`

Behavior:
- if passed, scaffold `interlinked/structure.json` during enable flow
- do not modify committed artifact files unless explicitly requested

## 21. Cache and Invalidation

### 21.1 Cache Inputs

Cache keys include:
- repo root
- manifest file mtimes and hashes
- extractor version
- Interlinked CLI version
- relevant source file mtimes and hashes

### 21.2 Incremental Invalidation

PostToolUse invalidates:
- changed file node
- neighboring edges
- affected artifact catalogs for file type

SessionStart may:
- refresh stale caches
- compare git diff against previous cache state

Verify may:
- force full refresh when caches are stale or manifest hashes changed

## 22. Performance Targets

Warm-cache targets:
- artifact graph refresh for one edited file: under 50ms median
- deterministic structure checks for one edit: under 50ms median
- partial structure checks for one edit: under 150ms median
- hook output formatting: under 10ms

Cold-cache targets:
- small repo scan: under 2s
- medium repo scan: under 10s

These are goals, not hard guarantees.

## 23. Backward Compatibility

V1 must preserve:
- existing quality checks
- existing structural checks
- existing `verify` behavior when `--structure` is not used
- existing hook blocking policy for destructive/security rules

If no `interlinked/structure.json` exists:
- hooks still work
- generic extracted catalogs may still run if enabled
- structure findings remain best-effort and non-blocking

## 24. Testing Plan

### 24.1 Unit Tests

Add tests for:
- root file validation
- each artifact file validation
- ArtifactGraph node and edge construction
- determinism classification
- baseline suppression logic
- required companion resolution

### 24.2 Fixture Repos

Add generic fixture repos covering:
- public symbol change with declared companions
- public symbol change with inferred companions only
- env key addition
- config key rename
- glossary residue
- layer boundary violation
- package boundary violation
- invalid structure file references

### 24.3 Hook Tests

Add tests that assert:
- PostToolUse emits deterministic findings before heuristic findings
- no structure finding blocks the tool call
- follow-through tracking carries artifact references and required files
- repeated warnings are session-suppressed appropriately

### 24.4 Verify Tests

Add tests that assert:
- exit code `1` for deterministic structure failures when enabled
- exit code `2` for invalid structure configuration
- partial findings do not fail by default
- baselines suppress only matching prior findings

### 24.5 Noise-Budget Tests

Assert:
- single edit emits at most 3 heuristic structure suggestions
- deterministic findings always include exact files when known
- structure output does not duplicate existing structural-check warnings

### 24.6 Performance Tests

Add:
- cold-cache scan benchmark
- warm-cache single-file edit benchmark
- large-repo incremental refresh benchmark

## 25. Milestones

### M0: Type System And Result Shape

Deliverables:
- extend `CheckResultEntry`
- add structure-specific result types
- add determinism and provenance enums

### M1: Local Catalog And ArtifactGraph

Deliverables:
- `.interlinked/structure-cache/`
- ArtifactGraph builder
- generic extractors for modules, packages, docs, tests, examples, env, config

### M2: Root File And Artifact File Validation

Deliverables:
- `structure.json` loader
- validators for all v1 artifact files
- `structure doctor`

### M3: Built-In Rule Families

Deliverables:
- public symbol companions
- env key companions
- config key companions
- layer boundary violations
- package boundary violations
- glossary residue

### M4: Hook Integration

Deliverables:
- PostToolUse structure phase
- follow-through tracking generalization
- human-readable structure warning formatting

### M5: Verify Integration

Deliverables:
- `verify --structure`
- structure JSON output
- exit-code behavior

### M6: Adoption Tooling

Deliverables:
- `structure init`
- `structure status`
- `structure baseline`
- optional `structure accept`

### M7: Hardening

Deliverables:
- fixture repos
- parity tests
- performance tests
- docs and command reference updates

## 26. Explicit V1 Decisions

These decisions are fixed for v1:
- generic artifacts only
- no framework-specific route/schema/CLI support
- structure findings never block hooks
- `verify` is the enforcement point
- committed structure files live in `interlinked/`
- local generated state lives in `.interlinked/structure-cache/`
- unknown keys in committed structure files are invalid
- baselines are local by default
- deterministic findings must include provenance and determinism fields

## 27. Future Extension Points

Deferred to later versions:
- framework-specific adapters
- route and schema artifacts
- CLI command and flag artifacts
- custom declarative rule DSL
- committed team baselines
- server-side syncing of structure metadata

## 28. Summary

V1 turns Interlinked into a generic artifact-aware repo structure system.

It does this by adding:
- committed optional structure manifests
- local generated artifact catalogs
- an internal ArtifactGraph
- determinism-aware structure findings
- non-blocking hook guidance
- repo-wide verification enforcement

The key product boundary is:
- security and destructive behavior may still block in hooks
- repo-structure understanding does not block hooks in v1
- repo-structure determinism is enforced by `interlinked verify` when enabled
