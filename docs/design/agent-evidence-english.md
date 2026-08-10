# Agent Evidence English

| Field | Value |
|---|---|
| Status | Research proposal for review |
| Version | AEE 0.1 draft |
| Date | 2026-08-09 |
| Scope | Human-agent reports, agent handoffs, task-state messages, and machine-checkable completion claims |
| Implementation status | Not implemented |

## Executive decision

Do not replace or revise ASD Simplified Technical English (STE). Use STE as the
grammar and vocabulary layer. Add an agent-specific companion profile called
**Agent Evidence English (AEE)**.

STE reduces linguistic ambiguity. It does not define whether an agent directly
observed a fact, inferred it, proposed it, or verified it against a criterion.
It also does not define task state, evidence provenance, remaining work, or a
portable agent-to-agent handoff. AEE adds these concepts.

AEE has two representations:

1. **A human report form.** This is concise STE-compatible prose with explicit
   result, claim status, scope, evidence, and remaining work.
2. **A machine report envelope.** This is a structured object that a harness,
   SDK, gateway, MCP tool, or agent protocol can validate and transport.

The harness MUST enforce only deterministic contradictions and structural
requirements. It MUST NOT block a response because it contains one word such as
`pipeline`, `surface`, or `clean`. Language-smell detection remains advisory.

The recommended rollout is `collect`, then `warn`, then an opt-in `revise` mode.
In `revise` mode, a final-response hook can request one correction before it
accepts the response.

## Problem statement

An agent can use short sentences, active voice, and approved vocabulary while
still giving an imprecise status report. These statements illustrate the gap:

- “The plumbing is done.”
- “Lane A is mid-pipeline.”
- “This is a clean implementation.”
- “The integration should now work.”
- “Everything is wired up.”

Each sentence is easy to read. None states a precise scope, acceptance
criterion, evidence source, or remaining obligation. Some convert an intended
state into a current fact without evidence.

The core defect is not figurative language alone. The defect is a missing
contract between a claim and its evidence.

### Why the current STE instruction is insufficient

The current user-level Claude instruction applies STE primarily to final
replies. That scope allows progress messages, subagent handoffs, task updates,
and compacted summaries to use a different reporting style. The instruction
also asks Claude to label verified and assumed information, but it does not
define the evidence needed for each claim type.

AEE should apply to all user-visible and agent-to-agent prose that reports
state. It should not apply to source code, shell commands, paths, logs, direct
quotes, or hidden model reasoning.

## Local corpus review

### Sources and method

The review used these local sources from `interlinked-cli` and the sibling
`mcp-client-bio` repository:

- `.interlinked/timeline.jsonl` for normalized agent messages;
- `.interlinked/activity.jsonl` for final messages captured on `agent_stop`;
- `.interlinked/collection.jsonl` for tool-centered event context;
- Claude transcript JSONL under `~/.claude/projects/` for the original message
  context.

`collection.jsonl` is useful for tool behavior, but it is not the best source
for prose analysis. `timeline.jsonl` and raw transcripts contain more complete
agent language. The smaller `agent_stop` set gives a useful sample of messages
that agents presented as final reports.

The 2026-08-09 snapshot contains:

- 14,814 `agent_message` records in the two timeline files;
- 870 `agent_stop` records in the two activity files;
- 343 `agent_stop` records with a non-empty `last_assistant_message`.

The following counts are case-insensitive exact-token occurrences in those 343
final messages. They are indicators for review. They are not violation counts.

| Token | Count | Token | Count |
|---|---:|---|---:|
| `clean` | 133 | `lands` | 56 |
| `surface` | 71 | `shape` | 48 |
| `layer` | 57 | `wired` | 28 |
| `drift` | 25 | `pipeline` | 20 |
| `seam` | 14 | `plumbing` | 14 |
| `polished` | 5 | `robust` | 3 |
| `solid` | 2 |  |  |

The corpus includes phrases such as “target shape,” “Pi-style surface,” “lane A
is mid-pipeline,” “connective-tissue spine,” “endgame seam,” “the plumbing is
done,” “diagnosis is solid,” and “a clean demonstration.” These phrases can be
useful shorthand inside a shared technical context. They become problematic
when they replace a factual status report.

### Working taxonomy

| Class | Examples | Communication risk |
|---|---|---|
| Structure metaphor | surface, seam, spine, lane, shape, layer, substrate, pipeline | The reader cannot identify the component or relation. |
| Completion metaphor | landed, wired, plumbed, stitched | The reader cannot tell what action occurred or whether it was tested. |
| Unsupported quality | clean, solid, robust, polished, airtight, elegant | The adjective has no stated criterion. |
| Vague status | mid-pipeline, mostly done, in good shape | The reader cannot identify completed and remaining work. |
| Introductory ceremony | the good news, key insight, what jumps out | The main result arrives late. |
| Evidence laundering | should work, looks good, appears healthy, now correctly, fully | The wording converts expectation or appearance into completion. |

This taxonomy should seed a contextual detector. It should not become a global
denylist. For example, “CI pipeline,” “API surface,” and “storage layer” can be
exact technical terms.

### Candidate advisory lexicon

The following list combines terms seen in the reviewed messages with related
forms that a corpus annotator should test. Inclusion means “inspect the use.” It
does not mean “reject the word.”

| Family | Candidate terms and phrases |
|---|---|
| Spatial abstraction | surface, layer, seam, spine, substrate, shape, topology, lane, axis, edge, boundary, bridge |
| Flow abstraction | pipeline, channel, funnel, flow, cascade, propagate, bubble up, feed through |
| Completion metaphor | land, wire, plumb, stitch, thread, hook up, lock in, nail down, shore up |
| Unsupported quality | clean, solid, robust, polished, elegant, crisp, coherent, airtight, healthy, sane, sharp |
| Unquantified degree | mostly, largely, essentially, basically, effectively, nearly, fully, end-to-end |
| Introductory ceremony | good news, key insight, what jumps out, importantly, the real story, here is the thing |
| Weak evidence | should work, looks good, appears healthy, seems correct, probably fixed, now correctly |

The detector should consider nearby technical nouns, evidence labels, and
criteria. “The deployment pipeline has three stages” is specific. “The change
is in the pipeline” is not specific unless the report names the current stage.

## What AEE keeps from STE

[ASD-STE100 Issue 9](https://www.asd-ste100.org/assets/files/ASD-STE100_ISSUE9.pdf)
already supplies a strong language base. AEE keeps these principles:

- Use approved or defined words consistently.
- Use one technical noun for one item.
- Use active voice unless the actor is unknown or unimportant.
- Keep sentences short and clear.
- Put one instruction in each procedural sentence.
- Replace ambiguous pronouns with the actual referent.
- Avoid slang, unexplained jargon, and decorative variation.

AEE does not create a competing general-purpose controlled language. It adds a
reporting contract for actions, facts, evidence, and agent state.

## What other standards add

| Source | Useful concept | AEE use |
|---|---|---|
| [NASA Systems Engineering Handbook, Appendix C](https://www.nasa.gov/reference/system-engineering-handbook-appendix/) | A requirement should be clear, singular, traceable, and individually verifiable. NASA also distinguishes test, demonstration, inspection, and analysis. | Require one material claim per claim record, an explicit acceptance criterion, and a suitable evidence method. |
| [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119.html) and [RFC 8174](https://www.rfc-editor.org/rfc/rfc8174.html) | Uppercase terms define normative force. | Use uppercase `MUST`, `MUST NOT`, `SHOULD`, and `MAY` only with their BCP 14 meanings in the normative rules. |
| [W3C PROV-O](https://www.w3.org/TR/prov-o/) | Entities, activities, agents, derivation, attribution, and association form a provenance model. | Link each evidence item to the event, tool, artifact, agent, and session that produced it. |
| [JSON Schema 2020-12](https://json-schema.org/draft/2020-12) | A schema can validate structure and declared constraints. | Validate the machine envelope, enums, required fields, and references. A schema cannot prove the truth of a claim. |
| [NIST AI RMF Core](https://airc.nist.gov/airmf-resources/airmf/5-sec-core/) and [Generative AI Profile](https://www.nist.gov/publications/artificial-intelligence-risk-management-framework-generative-artificial-intelligence) | Measurement should be documented, repeatable, contextual, and tied to limits and assumptions. | Record the criterion, method, conditions, timestamp, and limitation for a verification claim. |
| [SLSA terminology](https://slsa.dev/spec/v1.1/terminology) | Verification checks provenance against producer-defined expectations. | Separate the evidence artifact from the policy or acceptance criterion applied to it. |
| [OpenTelemetry overview](https://opentelemetry.io/docs/specs/otel/overview/) and [log correlation](https://opentelemetry.io/docs/specs/otel/logs/) | Trace and span identifiers correlate events across components. | Carry optional session, prompt, trace, span, and tool-use identifiers in evidence references. |
| [A2A protocol](https://a2a-protocol.org/latest/specification/) | A task has a state, messages carry communication, and artifacts carry results. | Keep task state separate from claim status and transport AEE reports as structured artifacts or data parts. |
| [MCP tool results](https://modelcontextprotocol.io/specification/2025-11-25/server/tools) and [MCP tasks](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks) | Tools can declare structured output, while durable tasks separate status from later results. | Use schema-declared output for AEE envelopes and map durable work to explicit task states. MCP tasks are experimental in the cited version. |

NASA is the most important addition to STE for this proposal. STE improves the
sentence. NASA-style verification connects the sentence to a checkable result.
W3C PROV and OpenTelemetry then make that connection portable across tools and
agents.

## AEE 0.1 draft

### Normative vocabulary

The key words `MUST`, `MUST NOT`, `REQUIRED`, `SHOULD`, `SHOULD NOT`, and `MAY`
in this section use the meanings in BCP 14 when, and only when, they appear in
uppercase.

### Scope

AEE applies to:

- final answers that report work or system state;
- progress messages that make material state claims;
- task creation, completion, failure, and blocked-state messages;
- subagent handoffs and multi-agent messages;
- compacted summaries that future agents will use as state;
- structured tool or protocol results that make completion claims.

AEE does not apply to:

- source code and generated code;
- commands, paths, identifiers, and exact configuration keys;
- raw logs and tool output;
- direct quotations;
- informal conversation that makes no material state claim;
- hidden reasoning or chain-of-thought.

### Separate task state from claim status

A task state answers, “What is happening with the work?” A claim status answers,
“How does the reporter know this statement?” They MUST use separate fields.

#### Task states

| State | Meaning |
|---|---|
| `NOT_STARTED` | The scoped work has not started. |
| `WORKING` | Work is active. Partial results and remaining work MUST be stated separately. |
| `COMPLETED` | All scoped acceptance criteria are satisfied, or the user accepted stated exceptions. |
| `BLOCKED` | Work cannot progress because an external dependency or state must change. The blocker MUST be named. |
| `INPUT_REQUIRED` | A user decision, authority grant, credential, or missing input is required. The required input MUST be named. |
| `FAILED` | The attempt ended without satisfying the criteria. The failure result MUST be stated. |
| `CANCELED` | The work stopped by request or policy. |
| `UNKNOWN` | The harness cannot determine the current task state. |

“Partial” is not a terminal task state. Report partial work as `WORKING`, then
list the completed result and remaining work.

#### Claim statuses

| Status | Meaning | Minimum support |
|---|---|---|
| `OBSERVED` | A current tool, source, or user statement directly showed the fact. | Evidence reference and observation time |
| `VERIFIED` | Current evidence satisfied an explicit criterion suitable for the claim. | Criterion, evidence method, evidence reference, and outcome |
| `INFERRED` | The reporter derived the conclusion from evidence but did not directly test the conclusion. | Evidence references and inference description |
| `PROPOSED` | The statement describes a future, desired, or recommended state. | No proof required, but it MUST NOT be presented as current state. |
| `UNKNOWN` | Available evidence is insufficient. | Missing evidence or uncertainty SHOULD be stated. |

`VERIFIED` is stronger than `OBSERVED`. For example:

- “`npm run test` exited with code 0” is `OBSERVED`.
- “The test suite passes” is `VERIFIED` if that command is the defined suite
  and the captured run satisfied the criterion.
- “The deployment is healthy” is not verified by a local build. It needs a
  runtime probe or deployed-target query and an artifact identity check.

### Evidence methods

AEE defines these evidence methods:

| Method | Suitable use |
|---|---|
| `INSPECTION` | File existence, file content, configuration, static metadata, or visible UI state |
| `TEST` | Automated checks with defined inputs and pass criteria |
| `DEMONSTRATION` | A runtime probe or direct execution that demonstrates behavior |
| `ANALYSIS` | A derived conclusion from measurements, traces, models, or static analysis |
| `EXTERNAL_ATTESTATION` | A signed or attributable result from CI, a deployment system, a registry, or another authority |
| `USER_STATEMENT` | A fact or constraint supplied by the user and not independently checked |

The evidence method MUST match the claim type. A file inspection cannot verify
runtime behavior. A local build cannot verify deployment. A test that did not
run is not failed evidence; it is missing evidence.

Evidence SHOULD record:

- the source event or artifact identifier;
- the command, tool, or authority in a safe summarized form;
- the observation time;
- the result and exit state;
- the relevant scope;
- the session, prompt, trace, span, or tool-use identifier when available;
- limitations, skipped checks, stale data, or environmental conditions.

Raw evidence can contain secrets or excessive output. The human report SHOULD
reference a stored event or digest instead of copying the full output.

### Human report form

A completion or handoff report SHOULD use this minimum form:

```text
Result: <exact result>
Task state: <state>
Claim status: <status>
Scope: <files, process, system, or task>
Evidence: <method and evidence reference>
Remaining: <none or exact work>
```

The labels are not required for every conversational reply. They are required
when a response asserts completion, operational status, or a handoff that
another agent will treat as state.

Example:

```text
Result: Added the Stop-event normalizer for Claude final messages.
Task state: COMPLETED
Claim status: VERIFIED
Scope: src/lib/hook-template-chunks/event-normalizers-claude.ts
Evidence: TEST — the focused normalizer test passed in this session.
Remaining: Codex, Gemini, and Copilot adapters are outside this change.
```

### Machine report envelope

This example is an illustrative instance. It is not yet the normative JSON
Schema.

```json
{
  "aee_version": "0.1",
  "report_kind": "completion",
  "task": {
    "id": "task-421",
    "state": "COMPLETED"
  },
  "result": "Added the Stop-event normalizer for Claude final messages.",
  "claims": [
    {
      "id": "claim-1",
      "text": "The focused normalizer test passes.",
      "status": "VERIFIED",
      "scope": [
        "src/lib/hook-template-chunks/event-normalizers-claude.ts"
      ],
      "criterion": "The focused Vitest command exits with code 0.",
      "evidence_refs": ["evidence-1"],
      "limitations": []
    }
  ],
  "evidence": [
    {
      "id": "evidence-1",
      "method": "TEST",
      "source": "tool-use:toolu_example",
      "summary": "Focused Vitest command exited with code 0.",
      "observed_at": "2026-08-09T14:00:00Z",
      "session_id": "session-example"
    }
  ],
  "remaining": []
}
```

A schema can validate field presence, enum values, identifiers, and reference
integrity. Application logic must validate semantic rules, such as whether a
`TEST` result is suitable evidence for a runtime claim. Neither layer is a
truth oracle.

### Language rules

1. A material state claim MUST name its subject and scope.
2. A completion claim MUST name the completed result and remaining work.
3. A `VERIFIED` claim MUST cite current evidence and an explicit criterion.
4. An `INFERRED` claim MUST identify the evidence and the inference.
5. A `PROPOSED` claim MUST use future or recommendation language.
6. An agent MUST NOT convert “should work” into “works” without suitable
   evidence.
7. An agent MUST NOT use a quality adjective as the only acceptance criterion.
8. An agent SHOULD quantify terms such as “fast,” “small,” “many,” and “mostly.”
9. An agent SHOULD replace an ambiguous pronoun with the exact referent.
10. An agent SHOULD put the main result before background or ceremony.
11. An agent SHOULD distinguish a failed check from a check that did not run.
12. An agent SHOULD state who owns the next action when work remains.
13. A handoff MUST include the task state, evidence references, and unresolved
    obligations that the next agent needs.
14. A compacted summary MUST preserve claim status and evidence references for
    any fact that future work depends on.

### Rewrite examples

| Imprecise report | AEE report |
|---|---|
| “The plumbing is done.” | “Result: The Stop adapter now sends `last_assistant_message` to the harness. Claim status: OBSERVED by code inspection. Runtime verification has not run.” |
| “Lane A is mid-pipeline.” | “Task state: WORKING. Completed: parsed the transcript. Current action: classify final messages. Remaining: define and test the revision rule.” |
| “This is a clean implementation.” | “The implementation adds no dependency and passes the type check and focused tests. The full test suite did not run.” |
| “The integration should now work.” | “Claim status: PROPOSED. The configuration is present. A runtime integration probe has not run.” |
| “Everything is wired up.” | “The Claude and Codex Stop events are registered. Gemini and Copilot final-response validation remain unimplemented.” |

## Portable enforcement contract

AEE should target abstract lifecycle capabilities instead of vendor event names.
Each adapter maps the capabilities that its host provides.

| Capability | Purpose |
|---|---|
| `session_start` | Inject the AEE version and static reporting rules. |
| `turn_start` | Add a short reminder, task identifier, and active acceptance criteria. |
| `evidence_event` | Capture tool results, artifact digests, timestamps, and provenance. |
| `final_candidate` | Validate the candidate final report and request at most one revision. |
| `final_accepted` | Store the accepted report and its validation result. |
| `subagent_candidate` | Validate a handoff before the parent treats it as state. |
| `task_state_change` | Validate completion, blocked, failed, and input-required transitions. |
| `post_compact` | Reload the AEE rules and preserve the evidence summary after compaction. |
| `display_transform` | Optionally change display text without changing the canonical report. |

### Final-text acquisition order

An adapter SHOULD use the first available source in this order:

1. a direct final-message field such as `last_assistant_message` or
   `prompt_response`;
2. a direct subagent response field;
3. the last complete assistant message in `transcript_path`;
4. a custom SDK or gateway that holds the candidate output before delivery.

Transcript readers MUST account for asynchronous writes and incomplete final
records. A host-provided final-message field is preferable.

### Capability tiers

| Tier | Host capability | Enforcement result |
|---|---|---|
| A | The host exposes the final candidate and can continue or retry the agent. | Enforce deterministic rules with one revision attempt. |
| B | The host exposes the final response but cannot continue the agent. | Warn, log, and score the response. |
| C | An SDK or gateway controls delivery and accepts structured output. | Validate the envelope before delivery; return a typed error on failure. |
| D | Only static instructions are available. | Inject AEE guidance and collect post hoc observations when possible. |

A Stop-style hook often runs after some text has already streamed to the user.
It can correct the canonical final state, but it does not guarantee that the
first visible text was valid. A true pre-display guarantee requires a buffering
SDK or gateway.

### Current host mapping

This table reflects official documentation reviewed on 2026-08-09. Adapter
tests and documentation checks should detect vendor changes.

| Host | Final candidate | Revision mechanism | Evidence and handoff surfaces | Important limit |
|---|---|---|---|---|
| [Claude Code](https://code.claude.com/docs/en/hooks) | `Stop.last_assistant_message` | A Stop decision or additional context continues the conversation. `SubagentStop` has equivalent control. | `PostToolUse`, `PostToolBatch`, task hooks, `SubagentStop`, `PostCompact`, and instruction/configuration events | `MessageDisplay` is display-only. It does not change the transcript or what Claude sees. |
| [OpenAI Codex](https://developers.openai.com/codex/hooks) | `Stop.last_assistant_message` | A Stop block continues with the reason as a new prompt. `SubagentStop` can do the same. | Session, tool, compaction, subagent, Stop, and SessionEnd events | Current hook execution supports command handlers. Prompt and agent handler declarations are not an enforcement substitute. |
| [Gemini CLI](https://geminicli.com/docs/hooks/reference/) | `AfterAgent.prompt_response` | `AfterAgent` can deny completion and force a retry. | `AfterTool`, `AfterAgent`, session, model, and tool-selection events | `AfterModel` works on model output chunks; `AfterAgent` is the stable final-response boundary for this use. |
| [GitHub Copilot](https://docs.github.com/en/copilot/reference/hooks-reference) | `agentStop` supplies `transcriptPath`; `subagentStop` supplies response data | `agentStop` can prevent stopping. `subagentStop` can control or modify a handoff. | Tool, session, prompt, agent-stop, and subagent-stop events vary by Copilot surface | The main-agent Stop adapter must read the transcript. Hook timeouts fail open. |
| Custom SDK or gateway | Direct candidate object | Reject or re-prompt before delivery | Full event, trace, and schema control | This gives the strongest guarantee but requires ownership of the serving path. |
| [A2A](https://a2a-protocol.org/latest/specification/) | Structured message or artifact | Protocol or application validation | Task state, messages, artifacts, data parts, extensions | A2A transports reports; it is not a local lifecycle-hook system. |
| [MCP](https://modelcontextprotocol.io/specification/2025-11-25/server/tools) | Structured tool result | Server, client, or hook validation | Output schema, structured content, tool errors, and experimental durable tasks | MCP transports tool results; final conversational enforcement remains a client or gateway responsibility. |

### Claude Code enforcement surfaces

The complete [Claude Code documentation index](https://code.claude.com/docs/llms.txt)
and current [hooks reference](https://code.claude.com/docs/en/hooks) show several
distinct enforcement modes:

- `SessionStart` can inject the static AEE version and context.
- `UserPromptSubmit` can add task criteria, but it cannot replace the user
  prompt.
- `PostToolUse` and `PostToolBatch` can record evidence near its source.
- `TaskCreated` and `TaskCompleted` can validate task-state fields.
- `Stop` and `SubagentStop` can request a corrected final report or handoff.
- `PostCompact` can audit the generated summary, while a later session-start or
  instruction load can restore static policy.
- `InstructionsLoaded` and `ConfigChange` can audit policy provenance.
- `MessageDisplay` can redact or reformat visible text, but the original text
  remains canonical.
- Prompt hooks use an LLM classifier and are heuristic. Agent hooks are
  experimental. Command hooks are the correct base for deterministic AEE
  validation.

[Claude output styles](https://code.claude.com/docs/en/output-styles) can make AEE
the default prose style. They are instruction mechanisms, not evidence
enforcement. [Claude Agent SDK structured outputs](https://code.claude.com/docs/en/agent-sdk/structured-outputs)
can validate a JSON Schema and retry invalid output, which is a stronger option
when an application owns the response path.

### Failure and loop rules

- Normal chat validation SHOULD fail open with a visible diagnostic if the
  validator crashes or times out. Communication quality is not a safety gate.
- A controlled SDK endpoint MAY fail closed when its published contract
  requires a valid structured result.
- A harness MUST request no more than one automatic language revision per final
  candidate.
- A second invalid candidate SHOULD be accepted with a visible validation
  report in an interactive client. An SDK MAY return a typed validation error.
- A revision request MUST identify the exact failed rule and a concrete repair.
- A communication validator MUST NOT instruct an agent to commit, push, deploy,
  or expand task scope.
- A display transformation MUST NOT be treated as canonical correction.

## Deterministic and heuristic checks

The repository's zero-false-positive contract applies. A deterministic
completion rule can request revision. A language smell can only warn.

| Check | Class | Default action |
|---|---|---|
| Required envelope field is absent for an in-scope completion or handoff | Deterministic | Revise in opt-in mode |
| Task or claim enum value is invalid | Deterministic | Revise in opt-in mode |
| `VERIFIED` claim has no criterion or evidence reference | Deterministic | Revise in opt-in mode |
| Evidence reference does not resolve to a captured event or artifact | Deterministic | Revise in opt-in mode |
| Task is `COMPLETED` while required work remains | Deterministic when both fields are structured | Revise in opt-in mode |
| `PROPOSED` claim is encoded as current implementation state | Deterministic when fields contradict | Revise in opt-in mode |
| Evidence method is mechanically incompatible with the claim type | Deterministic only for an explicit mapping | Revise in opt-in mode |
| Metaphor or corpus seed term appears | Heuristic | Advisory |
| Sentence exceeds an STE length target | Heuristic in free Markdown | Advisory |
| Passive voice is detected | Heuristic | Advisory |
| Pronoun referent may be ambiguous | Heuristic | Advisory |
| Quality adjective lacks a nearby criterion | Heuristic | Advisory |
| An LLM reviewer believes a claim is vague | Heuristic | Advisory |

The validator must parse Markdown. It should exclude fenced code, inline code,
quotes, tables that contain raw data, paths, identifiers, and log blocks from
language-smell checks.

The harness can treat a missing envelope as deterministic only when event
metadata, a task transition, or an SDK request declares the report kind. In
unstructured chat, detecting whether prose asserts completion is itself
heuristic. A free-prose classifier MAY recommend the envelope, but it MUST NOT
trigger automatic revision by itself.

## Interlinked CLI implementation review

The repository already captures most of the data needed for AEE, but it does
not yet evaluate final language through the daemon.

### Current evidence

- The Claude normalizer captures `Stop.last_assistant_message` in
  [`event-normalizers-claude.ts`](../../src/lib/hook-template-chunks/event-normalizers-claude.ts).
- The generated hook calls the daemon for user-prompt, pre-tool, and post-tool
  paths in [`hooks-template.ts`](../../src/lib/hooks-template.ts). It does not
  call the daemon to validate a Stop candidate.
- The daemon Stop handler builds warnings, persists the trajectory, drains
  analysis, and then cleans the session in
  [`lifecycle-events.ts`](../../src/harness/server/lifecycle-events.ts).
- The `last_assistant_message` type comment currently describes only
  `SubagentStop`, although Claude and Codex also provide the field on `Stop`, in
  [`events.ts`](../../src/harness/types/events.ts).
- The current Codex installer registers only the event set shown in
  [`hook-installers-codex.ts`](../../src/lib/hook-installers-codex.ts). The
  official current surface also documents subagent, compaction, and session-end
  events. The local comment that says `SessionEnd` is unavailable is stale.
- The current Copilot installer omits `agentStop` and
  `subagentStop` in
  [`hook-installers-copilot.ts`](../../src/lib/hook-installers-copilot.ts).
- [`hooks-ecosystem-comparison.md`](../hooks-ecosystem-comparison.md) is a useful
  architectural reference, but its 2026-04 event counts and Copilot scope claims
  need a separate refresh against current vendor documentation.

The installed clients at this review point are Claude Code 2.1.226, Codex CLI
0.147.0, Gemini CLI 0.51.0, and GitHub Copilot CLI 1.0.77.

### Required implementation sequence

1. Define a provider-neutral `FinalCandidate` event with final text, task state,
   client, session, transcript, and evidence references.
2. Add final-text acquisition to each adapter. Prefer direct fields and use the
   transcript fallback only where required.
3. Add a deterministic AEE envelope validator and a separate advisory prose
   linter.
4. Run the validator before Stop cleanup.
5. If the validator requests a revision, preserve the trajectory and evidence
   state for the continued turn.
6. Clean the session only after the candidate is accepted or the one-revision
   limit is exhausted.
7. Record both the original candidate and validation result in observability
   data. Treat revised content according to the host's transcript semantics.
8. Add subagent-handoff validation and task-state validation after the main
   Stop path is stable.
9. Add SDK, A2A, and MCP envelope helpers without coupling their schemas to one
   vendor's event names.

The cleanup ordering is important. The current Stop handler cleans per-turn
state before returning. A revision response would continue the conversation.
If cleanup occurs first, the next attempt loses the evidence needed to validate
the corrected claim.

This design follows the existing
[`stop-event-checks.md`](./stop-event-checks.md) principle: Stop should make an
agent reflect before it claims completion. It must not push the agent toward a
commit, PR, deployment, or any other external action.

### Proposed configuration

This configuration is illustrative and is not part of the current schema:

```yaml
communication_policy:
  enabled: true
  mode: collect # off | collect | warn | revise
  standard: aee-0.1
  surfaces:
    - final
    - subagent
  max_revision_attempts: 1
  require_envelope_for:
    - completion
    - handoff
  heuristic_mode: advisory
```

`collect` should be the initial default during an experiment. `revise` should
remain opt-in until the corpus demonstrates that each deterministic rule has no
false positives in its declared scope.

## Rollout and evaluation

### Phase 0: specification

- Review the state and status enums.
- Define claim-to-evidence compatibility rules.
- Publish the JSON Schema and examples separately from the prose standard.
- Define Markdown exclusions and privacy treatment for evidence summaries.

### Phase 1: collect

- Record validation results without changing agent behavior.
- Observe at least 500 in-scope final and handoff messages.
- Label false positives, missed vague claims, and valid technical uses of the
  seed lexicon.
- Measure added latency and transcript-read failures by client.

### Phase 2: warn

- Show deterministic defects and heuristic advice separately.
- Do not change task state or keep an agent running.
- Let users suppress an advisory finding with a reason.

### Phase 3: revise

- Enable one automatic revision for deterministic defects only.
- Preserve evidence across the continuation.
- Accept the second candidate with a diagnostic if it remains invalid.
- Keep semantic LLM review advisory.

### Evaluation measures

| Measure | Target |
|---|---|
| Deterministic-rule false-positive rate | 0 in the promoted rule scope |
| Final reports with resolvable evidence references | Increase from the observed baseline |
| Completion claims with explicit remaining work | Increase from the observed baseline |
| Revision loops per candidate | At most 1 |
| Validator timeout or crash | Visible, logged, and fail-open in interactive mode |
| Added Stop latency | Report per client and keep within an agreed budget |
| User-rated clarity | Improve without forcing forms onto ordinary conversation |

## Review questions

1. Is “Agent Evidence English” the correct name, or should the profile use a
   vendor-neutral name such as “Evidence-Bound Technical English”?
2. Should `OBSERVED` remain distinct from `VERIFIED`?
3. Which report kinds require the human labels: completion, handoff, blocked,
   deployment, or all material state claims?
4. Should a user statement be a first-class evidence method or a provenance
   attribute on a claim?
5. What claim types can Interlinked classify deterministically enough to check
   evidence-method compatibility?
6. Should interactive `revise` mode fail open after one attempt, while an SDK
   endpoint returns a typed schema error?
7. How long should evidence remain current for runtime, deployment, and external
   service claims?
8. Should compacted summaries carry the complete envelope or only claim and
   evidence identifiers?
9. Which A2A extension URI and MCP output schema should identify AEE reports?
10. Should the existing STE instruction apply to progress messages and
    subagents immediately, before harness enforcement exists?

## Source index

### Controlled language and requirements

- [ASD Simplified Technical English official site](https://www.asd-ste100.org/)
- [ASD-STE100 Issue 9](https://www.asd-ste100.org/assets/files/ASD-STE100_ISSUE9.pdf)
- [NASA Systems Engineering Handbook, Appendix C](https://www.nasa.gov/reference/system-engineering-handbook-appendix/)
- [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119.html)
- [RFC 8174](https://www.rfc-editor.org/rfc/rfc8174.html)

### Evidence, validation, and provenance

- [W3C PROV-O](https://www.w3.org/TR/prov-o/)
- [JSON Schema Draft 2020-12](https://json-schema.org/draft/2020-12)
- [JSON Schema Validation](https://json-schema.org/draft/2020-12/json-schema-validation)
- [NIST AI RMF Core](https://airc.nist.gov/airmf-resources/airmf/5-sec-core/)
- [NIST Generative AI Profile](https://www.nist.gov/publications/artificial-intelligence-risk-management-framework-generative-artificial-intelligence)
- [SLSA terminology](https://slsa.dev/spec/v1.1/terminology)
- [OpenTelemetry overview](https://opentelemetry.io/docs/specs/otel/overview/)
- [OpenTelemetry log correlation](https://opentelemetry.io/docs/specs/otel/logs/)

### Agent protocols and harnesses

- [A2A protocol specification](https://a2a-protocol.org/latest/specification/)
- [MCP tool specification](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)
- [MCP task specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks)
- [Claude Code complete documentation index](https://code.claude.com/docs/llms.txt)
- [Claude Code hooks reference](https://code.claude.com/docs/en/hooks)
- [Claude Code output styles](https://code.claude.com/docs/en/output-styles)
- [Claude Agent SDK structured outputs](https://code.claude.com/docs/en/agent-sdk/structured-outputs)
- [OpenAI Codex hooks](https://developers.openai.com/codex/hooks)
- [Gemini CLI hooks reference](https://geminicli.com/docs/hooks/reference/)
- [GitHub Copilot hooks reference](https://docs.github.com/en/copilot/reference/hooks-reference)
