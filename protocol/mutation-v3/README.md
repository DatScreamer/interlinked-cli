# Mutation protocol v3 — cross-repository contract

This directory is the ONE self-contained contract surface between the
mutation result producer (the `interlinked-cloud` runner/Worker) and the
consumer (this CLI). The schemas, fixtures, this README, and the
digest-pinned `normative_sources` define the portable contract; no ignored
local plan file is required to implement or verify it.

## What the contract is

A terminal mutation result is a discriminated union with
`protocol_version: "interlinked-mutation/3.0"` and one of six kinds:
`mutation_result | suite_red | not_mutatable | execution_failed |
cancelled | expired`.

**The envelope carries EVIDENCE, never a verdict.** No field, helper, or
fixture in this contract states "clean". The consumer's ONE local
evaluator combines verified evidence with its baseline and policy; the
protocol layer only answers two mechanical questions:

- Completeness: `complete | partial | none`, with reasons. A red suite,
  an inconclusive mutant (timeout/indeterminate), or an
  `execution_failed` marker degrade completeness explicitly — no consumer
  may infer it.
- Observations: killed / survived / uncovered / inconclusive counts and
  whether the affected suite was red. `uncovered` is mutation debt, not a
  survivor.

Every terminal envelope carries: the job binding (tenant / project /
repository / commit / target file + content hash / job key), the
acceptance receipt hash, EXACTLY ONE of `execution_receipt_hash` (with a
required `attempt_id`) or `terminalization_record_hash`, the
`result_hash`, a signature, `seq` (observability only), and
`occurred_at`. Evidence kinds (`mutation_result`, `suite_red`,
`not_mutatable`) REQUIRE the execution arm and add: the scope echo
(`mutation_scope: "whole_file"`, `incremental: false` — v1 retires both
ambiguities), engine identity with effective config hash and exit code,
runner build + image digest, the exact census
(`generated === executable + approved_excluded`), one row per executable mutant carrying EVALUATOR-GRADE identity —
full 64-hex `symbol_id`, `site_id`, and `mutant_id`, plus
`qualified_name`, `symbol_context`, `mutator`, `original_lexeme`, `replacement`,
`start_offset`, `ordinal_within_symbol`, and `status` — under
`identity_algorithm: "interlinked-site-v2"` (required on
`mutation_result`; travels with the census/excluded/mutants group on
`suite_red`/`execution_failed`), one full v2 identity-provenance row plus
`policy_id` per approved exclusion (disjoint ids; exclusions participate
in ordinal ranking), and test-run evidence with
`executed_test_count`, the test command hash, and the test-runner
identity. `mutation_result` AND `not_mutatable` REQUIRE the hash-bound
report pointer (non-zero bytes) so the verifier can prove the target
appears in the actual report — without it, an omitted target is
indistinguishable from a genuinely clean or non-mutatable one. Timing and
cost NEVER appear in the envelope in 3.0 — the run ledger owns them (this
resolves plan 27's §6 timing contradiction).

The v3 resource contract is intentionally bounded before any consumer
buffers untrusted bytes: a source artifact is at most 64 MiB and a report
is at most 16 MiB. Every source binding carries the exact, hash-bound
`format: "git-archive-tar-v1"`; acceptance and execution receipts repeat
that binding. An executor MUST reject any other or missing format and must
never guess a decoder from content or filename. The request and envelope
schemas carry the same maxima as the reference parser. Producers MUST
reject a larger upload while streaming; consumers MUST reject an oversized
authenticated pointer before fetching its report and enforce the same cap
while reading a missing or dishonest `Content-Length`.

`interlinked-site-v2` is intentionally not a widening presented under the
legacy name. The local mutation manifest remains keyed by the existing
16-hex v1 ids; v1 truncated symbol and site intermediates before hashing
their descendants. V2 applies full SHA-256 at symbol → site → mutant and
hashes each semantic tuple as the UTF-8 JSON encoding of a string array
(an unambiguous field boundary even when a raw lexeme contains NUL), then
is re-derived by the CLI from the hash-bound local target content before
the row can enter the existing evaluator. The cloud supplies evidence,
never the baseline identity or policy verdict.

`start_offset` is a zero-based UTF-16 code-unit offset (the JavaScript
string-index convention), not a Unicode code-point or UTF-8 byte offset. The
shared identity vectors include an astral character before a mutation so a
producer using code-point offsets cannot pass accidentally.

The CLI-side reference implementation is the exact `normative_sources`
list in `contract-digest.json`. That list includes the protocol parser,
verification/report modules, the portable AST identity derivation, and
the authenticated-evidence evaluator bridge; prose counts are not a
substitute for the machine-pinned inventory.

## Trust boundary

Two stages, two BRANDED types — each mintable only by its own function,
so verify cannot be reached without parse, and classification cannot be
reached without verify:

```
parseUntrustedEnvelope(raw)      → ParsedEnvelope         (shape only, untrusted)
verifyEnvelope(parsed, inputs)   → VerifiedEvidenceBundle (THE evaluator/journal boundary)
parseAndVerify(raw, inputs)      → the one public entry point
classifyEvidence(bundle)         → completeness + observations (bundle ONLY)
```

**Immutable evidence (round 33):** `parseUntrustedEnvelope` SNAPSHOTS the
raw input (structuredClone) BEFORE validation, validates the snapshot,
and deep-freezes it — the caller keeps no live reference into the
branded value. `VerifyInputs` are independently snapshotted before any
check (including a byte-for-byte copy of the report); receipt payloads
and the minted deeply-readonly bundle are likewise frozen. A caller
mutating its raw object, registry, expected binding, or report buffer after
authentication changes
nothing the evaluator or journal sees; a mutation attempt against the
bundle throws. The request parser (`request.ts`) applies the same rule:
clone FIRST (reading each field exactly once — accessor games cannot
show the validator one value and the hasher another), then validate,
freeze, brand.

`VerifyInputs` is everything the caller holds: the expected job binding,
the Ed25519 key registry (with `not_before` and `revoked_at` windows), a
validated clock (`now` — malformed fails CLOSED; results unreasonably in
the future are rejected), the SIGNED receipt texts, and the raw report
bytes. Verification checks, in order: the recomputed `result_hash`; the
attestation signature (key window against the SIGNED `occurred_at`); the
caller's job echo; the SIGNED receipts (strict schemas — see below — with
canonical-payload hash binding and EXACT field cross-echoes: acceptance
job/policies/intended image/config/scope, execution attempt_id/job_key/
image/config); and the STRUCTURAL report (both pointer hashes over the
same bytes, exact target entry, one row per envelope mutant with the SAME
status, one excluded row per exclusion, nothing extra; `not_mutatable`
requires the target present with an exact zero-mutant result). Policies
resolve against the signed acceptance receipt's `approved_policy_ids` —
syntax is never approval. Only the `VerifiedEvidenceBundle` reaches the
evaluator, the journal, or `classifyEvidence`.

## Receipt schemas (signed, strict, production fields)

A receipt is `{payload, signature}`; the signature is Ed25519 over
`utf8(canonicalJson({key_id, payload}))` — key_id is INSIDE the signed
bytes; the envelope binds `sha256(canonicalJson(payload))`.
Machine-readable schema:
`schema/receipts.schema.json` (envelope: `schema/envelope.schema.json`;
report: `schema/report.schema.json` — the TS reference implementation
remains normative for the cross-field invariants each schema's
description lists).

**Signed key identity (sixth-pass P0):** every RECEIPT signature covers
`utf8(canonicalJson({key_id, payload}))` — relabeling an unsigned key id
to a same-key alias breaks the signature. A registry where one public-key
fingerprint spans both control-specific (acceptance/terminalization) and
runner-specific (execution) roles is rejected outright. `result` is an
arm-neutral purpose: the envelope signer id MUST equal the verified
execution-receipt signer id on the execution arm, or the verified
terminalization-receipt signer id on the control arm.

**Caller anchoring (sixth-pass P0):** the verifier takes
`expectedAdmission {request_hash, changeset_hash}` from the CALLER's own
state (never the response) and requires the signed acceptance receipt to
match it; the execution receipt carries `acceptance_receipt_hash` and
must bind EXACTLY the envelope's acceptance receipt (no mix-and-match).

**Chronology + continuity (sixth pass):**
`acceptance.issued_at <= execution.issued_at <= result.occurred_at <=
now + skew`; for the pre-execution arm,
`acceptance.issued_at <= terminalization.occurred_at` and
`terminalization.policy_version == acceptance.policy_version`. A
signer-controlled timestamp alone does not prove signing time — the D1
journal anchors issuance in the durable-job round.

**Key purposes (fifth-pass P0):** every registry key declares `purposes`
(`acceptance | execution | terminalization | result`) plus optional
`not_before`/`revoked_at`. The CONTROL plane signs acceptance,
terminalization, and terminal-arm result envelopes; the RUNNER signs
execution receipts and execution-arm result envelopes. Both keys therefore
carry `result`, but exact signer-id equality to the arm receipt prevents
either authority from signing the other arm. A runner key can never approve
its own policies or terminalize a job. Key windows are checked independently
per signed object against that object's SIGNED timestamp (`issued_at`;
`occurred_at` for terminalization and the envelope attestation).

Payloads (unknown keys rejected; all cross-echoes are EXACT fields):

- acceptance: version/kind/`protocol_version` (const
  `interlinked-mutation/3.0` — the receipt is bound to THIS protocol,
  so a receipt cannot be replayed across protocol majors)/issued_at,
  the full job binding,
  `approved_policy_ids[]`, `policy_version`, `request_hash`,
  `test_scope_hash` (sha256 of the canonical test list — must equal the
  actual scope), `quota_reservation_id`, `changeset_hash`,
  `source_artifact` (exact `git-archive-tar-v1` format/id/hash/length),
  `intended_image_digest`, `intended_engine_config_hash`,
  `intended_scope_mode` — each intended value must equal the envelope's
  actual when the block is present.
- execution: version/kind/issued_at, `job_key`, `attempt_id`,
  `source_artifact` (must equal the accepted binding),
  `image_digest`, `engine_name`, `engine_version`, `engine_config_hash`,
  `lockfile_hash`, `runtime_identity`, `package_manager_identity`,
  `test_command_hash`, `test_selection_algorithm`, `selected_test_hash`
  and `selected_test_count` (must equal the actual test list/count) —
  each must equal the envelope's actuals when present.
- terminalization (full plan-27 record): version/kind, `job_key`,
  `acceptance_receipt_hash` (must equal the envelope's), `terminal_state`
  (must equal the envelope kind), `actor`, `authority`, `reason_code`
  (must equal the envelope's cancellation/expiry/failure reason),
  `occurred_at` (must equal the envelope's), `policy_version`. A signed
  contradiction is a rejection.

## Report schema (structural, versioned, recursively strict)

`{report_version:"1", files: { [target]: { mutants: [identity rows] } } }`.
Executable and excluded rows repeat the envelope's complete v2 identity
provenance; exclusions also repeat `policy_id` and use status `excluded`.
Unknown keys reject at the root, the file entry, and every row, and
`files` carries EXACTLY one entry: the target (v1 is single-target
whole-file). A prose mention of the target is not evidence.

## Shared fixtures

- `fixtures/corpus.json` — parse/classification matrix (structural).
- `fixtures/signed-vectors.json` — the deterministic mutation_result
  vector + envelope tamper cases (EXECUTED by consumers).
- `fixtures/signed-bundles.json` — SELF-CONTAINED: carries the contract
  version, the verification clock, the public-key registry (with
  purposes), and per-bundle INDEPENDENT `expected_job` +
  `expected_admission`; one complete signed bundle per kind (all six)
  plus self-contained negative cases (receipt hash, cross-echo,
  contradictory terminalization, purpose violation, prose report, key
  revocation) — another repository executes the file without inventing
  any input, and consumers EXECUTE every case.
- `schema/*.schema.json` — machine-readable JSON Schemas (2020-12) for
  the envelope, receipts, report, AND the job request; the CLI executes
  them with Ajv (a direct pinned devDependency) against the shared
  fixtures and adversarial probes (`schema-conformance.test.ts`). The
  cloud repo takes on the same obligation when it vendors the contract.
- `fixtures/request-vectors.json` — the canonical admission derivation
  (`request_hash` / `changeset_hash`, see `request.ts` and
  `request.schema.json`): the request itself carries
  `protocol_version`; entries sorted by path (code-unit lexicographic,
  unique paths); both repositories must reproduce the exact digests.
  Consumers assert the fixture's `protocol_version` against the
  implementation constant (`PROTOCOL_V3_VERSION`), never a string
  literal.
- `fixtures/identity-vectors.json` — portable `interlinked-site-v2`
  symbol/site/mutant derivation vectors. Producers and consumers reproduce
  the full 64-hex ids from file content + raw mutant provenance; an engine id
  is never substituted for a wire identity.
- `contract-digest.json` — sha-256 digest over EVERY file in this
  directory (except itself) PLUS every `normative_sources` file (the
  reference-implementation modules named by `normative_sources`), in sorted label
  order (`label\0sha256(content)\n` lines). Contract-directory labels are
  relative to `protocol/mutation-v3/` (`README.md`, `schema/request.schema.json`);
  normative-source labels are repository-relative exactly as listed
  (`src/harness/...`). The two namespaces are deliberately different and are
  part of the digest algorithm. The CLI pins the result in tests.
  Any change to the contract OR the normative implementation lands
  together with a digest update — undigested code is not normative.

## Vendoring obligations (normative)

A repository consuming or producing against this contract MUST:

1. Vendor ALL digest inputs as EXACT BYTES — every file in this
   directory AND every named normative source module. A paraphrase, a
   re-serialization, or a partial copy is not the contract.
2. INDEPENDENTLY recompute the digest from its vendored bytes with its
   own code (same `label\0sha256(content)\n` construction and label
   namespaces above, sorted labels) and pin the recomputed value in its own
   CI — never trust the vendored `contract-digest.json` blindly.
3. Execute the shared fixtures (corpus, signed vectors, signed bundles,
   request vectors) and the JSON Schemas against its own
   implementation.

A digest mismatch means the vendored copy is stale or tampered: STOP
and re-vendor; do not patch around it.

## Canonical JSON

`canonicalJson` is the **Interlinked Canonical JSON profile**: recursive
lexicographic key sort, JSON.stringify serialization, no whitespace, and
lone-surrogate strings rejected recursively (at the schema boundary and
in the serializer). Within this protocol's validated domain (safe
integers only, ASCII field names, well-formed strings) its bytes are
RFC 8785 (JCS)-identical; the profile name is the exact claim.

## The signing contract (exact)

- `result_hash = sha256( canonicalJson(payload) )` over UTF-8, where the
  payload is every envelope field EXCEPT `seq`, `occurred_at`,
  `result_hash`, and `signature`. `seq` is unhashed and unsigned (plan 27
  r5.3); `occurred_at` does not participate in result identity.
- `signature.value = base64( Ed25519-sign( utf8( canonicalJson({key_id,
  occurred_at, result_hash}) ) ) )` — `key_id` and `occurred_at` ARE
  signed, so revocation-window checks rest on a signed timestamp. The
  signer id MUST equal the verified arm receipt's signer id (execution or
  terminalization respectively); a generic `result` purpose alone is not
  authorization for either arm.
- `canonicalJson`: recursive lexicographic key sort, JSON.stringify
  serialization, no whitespace. For this schema (safe integers only,
  ASCII field names) it is RFC 8785 (JCS) equivalent.
- The deterministic shared vector lives at `fixtures/signed-vectors.json`
  (seed, key, receipts, report, expected hash/attestation/signature,
  tamper cases). The cloud producer must reproduce the SAME bytes with
  WebCrypto; the CLI pins it in `verify.test.ts`.

## What "passing the corpus" means

`fixtures/corpus.json` (corpus_version 3) is the shared acceptance
matrix. Each case carries an `expected` block:

- `parse: "accepted"` — a consumer MUST parse the envelope; a producer
  MUST be able to emit this shape. The mechanical classification
  (`completeness`, `observations`) MUST match.
- `parse: "rejected"` — a consumer MUST refuse it with a reason
  containing `reason_includes`; a producer MUST NEVER emit it.

Both repositories run the same corpus bytes:

- CLI: `src/harness/mutation/protocol-v3/acceptance.test.ts` (vitest).
- Cloud: vendor this directory with a pinned digest of `corpus.json` and
  drive the matrix through the REAL producer emit path plus its own
  validator — not a standalone copy of the rules.

Signature verification tests use deterministic Ed25519 vectors (fixed
seed) with tamper cases per hash-bound field:
`src/harness/mutation/protocol-v3/verify.test.ts`.

## Derivation contract

A case either embeds a full `envelope`, or derives one from a named case:
start from `base`'s (recursively materialized) envelope, shallow-merge
`patch` (top-level keys replace wholesale), then remove each key in
`delete`. Nothing deeper — no deep merges, no array splices.

## Change rules

1. Never change the schema without changing this corpus in the same
   change, and vice versa.
2. After the first producer vendors/deploys this contract, a new required
   field is a protocol version bump (`interlinked-mutation/3.1`), with new
   fixtures; the parser rejects unknown keys at EVERY level by design. The
   pre-vendoring freeze may be corrected in place only with every fixture,
   schema, normative source, and the contract digest regenerated together.
3. Rejected cases are load-bearing: they are the reviewer-mandated
   malformed/adverse matrix. Do not delete one to make an implementation
   pass — fix the implementation.
4. No change may reintroduce a verdict into this layer. Evidence in the
   envelope; judgment in the one local evaluator.
