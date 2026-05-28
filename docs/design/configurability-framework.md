# Configurability Framework

**Source:** extracted from `docs/test-quality-harness-plan.md` §22 (v3.2).

**Companion documents:**
- `docs/design/test-quality-harness-local-first.md` — local-first kernel (Phase 0–3.7). Retains only the principle (Layer 1/2/3), the decision-framework tree, and the non-configurable list.
- `docs/test-quality-harness-plan.md` — full v3.2 plan; §22 stays there as part of the full plan.

**Why this lives separately:** roughly half of v3.2 §22 is product-strategy / sales-positioning content — premium pricing, sales conversations, customer success teams, configuration-as-a-feature marketing framing, brownfield onboarding wizard. It doesn't constrain technical design in the local-first kernel and shouldn't load into the kernel doc by default. The principle (Layer 1/2/3) does constrain design and is retained in the kernel doc; everything else lives here for findability when the harness ships to non-Quentin users.

**Status:** verbatim extract from v3.2 §22. Becomes relevant when shipping to external customers (post local-first kernel + cloud Tier 2 substrate).

---

## 1. The Principle: Opinions About WHAT, Configurable HOW/WHERE

The harness divides every design decision into three layers:

**Layer 1 — Non-negotiable opinions (vendor-enforced).** These are the "we believe" claims that constitute the product's value proposition. If a customer rejects these, the harness can't deliver value, so they're not configurable:

- AI-generated code requires verification before completion
- Security-critical findings must be addressed (cannot disable secret detection, credential exposure checks)
- Receipts must be cryptographically signed when audit-grade tier is active
- Verification must be deterministic where possible (no fuzzy substitutes for exact checks)
- The agent cannot bypass the harness once the harness is engaged

**Layer 2 — Strong default opinions (vendor-recommended, customer-overridable).** These are the choices vendor believes are best for most customers but acknowledges customer expertise about their context:

- Default scope is per-file (catches more) rather than per-diff (less intrusive)
- Default policy is fix-everything-pre-existing rather than scope-disciplined
- Default LoC limits are 80 lines for existing-file modifications
- Default location for test files is `tests/` alongside source
- Default escalation is to non-LLM verification, not bigger LLMs
- Default LLM tier is open-weight, not frontier

**Layer 3 — Customer configuration (full control).** These are the cosmetic and structural choices where customer preference dominates:

- Where each artifact type lives (in repo at custom path, in sidecar repo, cloud-only, etc.)
- Which Lane C rules are active
- Specific severity assignments per rule
- Per-file-pattern policy overrides
- Telemetry granularity
- LoC limit values

This three-layer split lets the harness say: "We have strong opinions about what verification means. We have recommendations for how to do it well. We support your preferences about how you want it integrated."

## 2. The Artifact Location Framework

Every artifact the harness produces or consumes has a natural location category. Default location varies by category, but all locations are customer-configurable within constraints:

| Category | Examples | Default location | Configurable options | Constraints |
|---|---|---|---|---|
| **Customer code** | Application code | Customer repo (customer owns) | Customer owns entirely | None |
| **Test code** | Unit, integration, acceptance tests | Customer repo at `tests/` | Custom path, sidecar repo, cloud-only | Must be executable somehow |
| **Configuration artifacts** | Capability maps, Semgrep rules, `/enforce` rules | Customer repo at conventional paths | Custom path, cloud-managed | Must be version-trackable |
| **Operational state** | Baselines, telemetry, finding history | Cloud (paid tier), local (free CLI) | Cloud-only, local-only, mirrored | Cloud required for team features |
| **Generated artifacts** | Graph shards, AST caches | Local cache (gitignored) | Cloud-cached, no-cache | Must be regeneratable |
| **Audit artifacts** | Receipts, audit logs | Cloud-only | Cloud-only (export available) | Cannot be local-only for paid tier |

The three categories that benefit most from customer-configurable location:

1. **Test code** — because tests are simultaneously customer IP, agent context, and runtime artifacts. Different customers have different opinions about which aspect dominates.

2. **Configuration artifacts** — because they encode customer policies and customers care about version control.

3. **Operational state** — because the data has compliance, privacy, and analytics implications customers want to control.

## 3. Test File Location — Configurations

The user's example: "Keep test files only on our remote side rather than the developer's local machine." This is technically feasible but has serious tradeoffs that need explicit acknowledgment. The harness supports multiple configurations, ranked from most-standard to most-separated:

### Configuration A: Tests in customer repo at default path (RECOMMENDED DEFAULT)

```
customer-repo/
├── src/
│   └── orders.ts
└── tests/
    └── orders.test.ts
```

**Tradeoffs:**
- ✅ Familiar pattern; works with all standard tooling
- ✅ Customer's IDE shows tests next to code
- ✅ CI runs tests as usual
- ✅ Tests are version-controlled in customer's git
- ✅ Test refactoring uses normal editor flow
- ⚠️ Adds files to customer repo (the original objection)

**Best for:** standard development teams, open-source projects, anyone who treats tests as first-class artifacts.

### Configuration B: Tests in customer repo at custom path

```
customer-repo/
├── src/
│   └── orders.ts
└── .interlinked-tests/
    └── orders.test.ts
```

Customer configures: `test_location: .interlinked-tests/`

**Tradeoffs:**
- ✅ Customer chooses path that fits their conventions
- ✅ Can be gitignored if customer wants (with caveats)
- ✅ Easy to identify harness-generated tests
- ⚠️ Non-standard path may confuse other tooling
- ⚠️ If gitignored, loses version control benefit

**Best for:** teams that want clear separation between hand-written and harness-generated tests, teams with strong opinions about repo structure.

### Configuration C: Tests in sidecar repo

```
customer-app/                 # Customer's main repo
└── src/orders.ts

customer-app-tests/           # Harness-managed sidecar repo
└── orders.test.ts
```

Customer configures: `test_location: sidecar_repo`. Harness creates and manages the sidecar repo (in customer's git org).

**Tradeoffs:**
- ✅ Main repo stays clean
- ✅ Tests still version-controlled (in sidecar)
- ✅ CI can clone both repos
- ✅ Clear ownership: sidecar is harness-managed
- ⚠️ More complex git workflow
- ⚠️ Sidecar repo to manage, permission, back up
- ⚠️ Cross-repo coordination during refactoring

**Best for:** teams that want main repo cleanliness without giving up version control of tests, organizations with mature multi-repo workflows.

### Configuration D: Tests cloud-only (ADVANCED)

```
customer-repo/                # No test files at all
└── src/orders.ts

(Vendor cloud)
└── Workspace tests for orders.ts (stored in DO SQLite)
```

Customer configures: `test_location: cloud_only`.

**Architecture:**
- Tests live in workspace DO SQLite
- Cloud Sandbox spawned per test run: clones customer repo, injects tests from DO, executes, returns results
- Agent sees tests via context window injection from cloud
- Developer accesses tests via dashboard UI (read, edit, export)
- CI integrates via vendor API: `interlinked test-run` instead of `npm test`
- Test version history maintained in cloud, exportable on demand

**Tradeoffs:**
- ✅ Main repo absolutely clean of test files
- ✅ Tests still version-tracked (in vendor cloud)
- ✅ Agent has full test visibility
- ⚠️ Customer CI must integrate with vendor API
- ⚠️ Customer IDE doesn't show tests locally
- ⚠️ Test debugging requires dashboard or CLI to view test code
- ⚠️ Test IP/version control at vendor (some customers won't accept this)
- ⚠️ Cannot run tests offline without first downloading
- ⚠️ Some compliance frameworks require test code in customer-controlled storage

**Best for:** the rare customer who has strong "lean main repo" requirements and accepts the operational tradeoffs. Often pitched as "managed test infrastructure" — vendor handles test storage, customer focuses on application code.

### Configuration E: No tests at all (NOT SUPPORTED)

Customer wants the harness without any test enforcement.

**This is not supported.** Tests are core to the harness's value proposition. A customer who doesn't want tests is not the right customer for this product. We don't deliver crippled value to win business that wouldn't otherwise convert.

## 4. The General Decision Framework for These Tensions

For any customer preference that pushes against vendor opinion, apply this decision tree:

```
Is the customer's preference cosmetic (path, format, naming)?
├── YES → Support as configuration. Document the option. Default to vendor recommendation.
└── NO ↓

Does the customer's preference reduce harness value but preserve core function?
├── YES → Support as advanced configuration. Document tradeoffs explicitly. 
│         Default to vendor recommendation with warning when customer chooses alternative.
└── NO ↓

Does the customer's preference eliminate harness value?
├── YES → Do not support. Refuse the configuration. Document why.
└── NO ↓

Is the customer's preference better than vendor's default for this customer's context?
├── YES → Update vendor default OR support as documented alternative
└── NO → Default holds
```

Examples:

- "Tests at `__tests__/` instead of `tests/`" → cosmetic, support directly
- "Tests in cloud only" → reduces value (no local IDE visibility) but preserves core function (tests still exist and run) → advanced configuration with documented tradeoffs
- "No tests at all" → eliminates value → refuse
- "Tests must run in our existing CI, not vendor's" → reduces value (less integration) but preserves core function → supported with documented tradeoffs

## 5. Other Configurable Surfaces Beyond Test Location

The same principle applies to many other product decisions:

### Configuration locations

| Artifact | Default | Configurable options |
|---|---|---|
| Capability maps | `capability-map.yaml` in repo | Custom path, cloud-managed |
| Domain Semgrep rules | `.semgrep/` in repo | Custom path, cloud-managed |
| `/enforce` rule files | `.claude/skills/enforce/` | Custom path, cloud-managed |
| Workspace config | `.harness.yaml` in repo | Custom path, environment vars, cloud dashboard |
| LoC limits | Compiled defaults | Per-file-type overrides in workspace config |

### Enforcement strictness levels

For each lane and tier, customer can choose strictness:

| Level | Behavior |
|---|---|
| `strict` (default for security) | Block on any finding |
| `enforce` (default for quality) | Block on critical/high, warn on medium |
| `advise` (option) | Warn on all findings, don't block |
| `monitor` (option) | Log findings, don't surface to agent |
| `off` (option for specific rules) | Disable specific checks |

### Rule selection within lanes

Customer can:
- Disable specific Lane C rules (with audit log of disabled rules)
- Add custom Lane C rules (their own Semgrep patterns)
- Configure rule severity (within bounds — can't downgrade critical to low)
- Per-file-pattern rule overrides

### Policy action overrides

The policy matrix from §21.3 of the kernel doc is fully customer-configurable:
- For each (category × severity × provenance) tuple, customer chooses action
- Vendor provides recommended defaults
- Customer can override per workspace or per file pattern

### Telemetry granularity

| Level | What's reported |
|---|---|
| `full` (default for paid tiers) | All measurement data |
| `aggregate` (default for free CLI) | Anonymized aggregate only |
| `minimal` (option) | Only crash reports and version |
| `off` (option) | Nothing |

## 6. What's Non-Configurable and Why

The vendor's "we believe" opinions that don't yield, with reasoning:

**1. AI-generated code requires verification.**
- *Why non-configurable:* This is the product's reason for existing. A customer who rejects this isn't a customer.
- *Customer escape:* Don't use the harness.

**2. Critical security findings must be addressed.**
- *Why non-configurable:* These are by definition findings that endanger the customer or their users. Allowing override creates liability for vendor and potential harm for customer's users.
- *Customer escape:* False positive triage process; vendor adjusts the rule's specificity, not whether it blocks.

**3. Receipts must be cryptographically signed (paid tiers).**
- *Why non-configurable:* The receipt's value is its tamper-evidence. Unsigned receipts are useless for audit.
- *Customer escape:* Use free tier (no signed receipts).

**4. The harness cannot be bypassed once engaged.**
- *Why non-configurable:* A bypassable harness has no value as a gatekeeper. The whole architecture depends on inviolability.
- *Customer escape:* Uninstall the harness if they don't want it.

**5. Verification must use deterministic primitives where available.**
- *Why non-configurable:* The receipt-bound trust model depends on this. Fuzzy substitutes (embeddings, similarity matching) weaken the trust architecture.
- *Customer escape:* Use a different tool if they want fuzzy verification.

**6. Verification must complete within budget (30s blocking, 60s bridging).**
- *Why non-configurable:* Longer wait times break the agent feedback loop. Customers who want longer verification windows are misunderstanding what the harness is for.
- *Customer escape:* Use slower batch tools for the cases that need them.

These aren't arbitrary lines. Each represents a load-bearing assumption that the rest of the architecture depends on. Yielding on them would unravel the product.

## 7. Configuration as a Feature

Done well, this framework becomes a feature in marketing and sales:

> "interlinked has strong opinions about what makes AI-generated code trustworthy. It also has strong opinions about respecting your team's conventions. Configure where artifacts live, which rules apply, and how strict enforcement is — but don't ever question whether your code is verified."

**Positioning against comparables:**

- SonarQube has comprehensive configuration but no opinions about AI agents specifically
- Snyk has opinions about security but limited customization
- GitHub Copilot has minimal customization at all
- interlinked has opinions AND deep customization, scoped to AI-agent-generated code

**Customer onboarding implications:**

The configurability framework affects the brownfield onboarding wizard from the v3.2 plan §21.7:

```
Step 3.5: Configuration preferences

Where should test files live?
[1] In your repo at tests/ (recommended for most teams)
[2] In your repo at a custom path
[3] In a sidecar repo we'll create
[4] Cloud-only (advanced; documented tradeoffs)

How aggressive should enforcement be?
[1] Strict — block on most findings
[2] Standard — block on critical/high, warn on rest (recommended)
[3] Advisory — warn but don't block
[4] Monitor — log but don't surface

What's your telemetry preference?
[1] Full (helps us improve the product, helps you measure ROI)
[2] Aggregate only (anonymized)
[3] Minimal (crashes only)
[4] Off
```

Each choice is explicit, each comes with vendor recommendation, each documents implications.

**Customer success implications:**

Customer success teams need to:
- Identify when customer configuration is undermining harness value
- Recommend default-aligned configurations during onboarding
- Track which non-default configurations correlate with churn or low engagement
- Update defaults when customer base patterns show better choices

A customer who configures everything to "advise" mode and never sees blocking probably won't see the value and will churn. Customer success identifies this pattern and intervenes early.

## 8. Implementation Across Phases

The configurability framework is largely infrastructure-level work, distributed across phases (per v3.2 plan; not applicable to local-first kernel):

**Phase 0 additions (in full v3.2 plan):**
- **0.11 Configuration substrate.** YAML-based workspace config with schema validation. Cloud-managed or repo-resident per customer choice. Override hierarchy: workspace defaults → file-pattern overrides → individual file overrides.

**Phase 0.9 (Customer-facing surfaces) additions:**
- Configuration management UI in dashboard
- CLI commands: `harness config get/set`, `harness config validate`
- Configuration migration tools for changing layouts

**Phase 4 additions:**
- **4.7 Policy configuration loader.** Reads workspace config, applies overrides, validates against vendor constraints.

**Phase 11.10 (within brownfield onboarding):**
- Configuration wizard during onboarding
- Default recommendation engine based on detected codebase characteristics

**Phase 12 (post-launch):**
- **12.1 Test storage abstraction.** Support for the four test location configurations (repo-default, repo-custom, sidecar, cloud-only). Test execution adapter for each.
- **12.2 Sidecar repo management.** Auto-create, auto-sync, permission management for customers choosing sidecar.
- **12.3 Cloud-only test infrastructure.** DO storage of tests, Sandbox execution flow, dashboard UI for test management, CLI/API for CI integration.
- **12.4 Configuration analytics.** Track which configurations correlate with adoption success vs. churn; feed back into default recommendations.

## 9. The Customer Story This Enables

For sales conversations where customer expresses concerns about vendor opinions vs. their preferences:

> "We have strong opinions about what verification means. We don't have strong opinions about how it fits into your existing setup. Tell us your conventions and we'll configure around them — within the constraints of what makes verification meaningful."

For technical evaluators who push hard on configurability:

> "We're not Snyk or SonarQube where every rule is independently configurable to the point that you can make it do nothing. We're not GitHub Copilot where you take what we give you. We sit in the middle: opinionated about what we believe, flexible about how you integrate it. Here's the configuration matrix."

For customers comparing against in-house tooling:

> "You could build something custom that matches your exact preferences perfectly. You'd then have to maintain it, evolve it, support it. We give you 80% of your preferences with 100% of the verification capability, for less than the cost of one engineer maintaining custom infrastructure."

This framing — opinions about what, flexible about how — is also the right framing for the broader product strategy. It justifies premium pricing (opinions = expertise = value) while addressing the legitimate customization needs that prevent customer churn (flexibility = respect = trust).

## 10. Decision Log Addendum

**Why is test file location customer-configurable but the existence of tests is not?** Because tests are core to the harness's value proposition (Lane A doesn't function without tests), but where they live is operational preference. The "opinions about what, configurable about where" principle. A customer who doesn't want tests at all is asking for a different product.

**Why support cloud-only tests if it has so many tradeoffs?** Because the rare customers who genuinely want this configuration are often the highest-value enterprise customers — they have specific architectural requirements (lean main repo, vendor-managed test infrastructure) that translate to willingness to pay. Supporting the configuration is cheap; refusing it loses those customers entirely.

**Why is the policy matrix configurable but rule existence is not?** Because rules represent vendor's domain expertise (what should be checked); policy represents customer's enforcement preferences (how strict to be about it). Both are valid concerns and should be separated. Customer can say "I want this checked less aggressively" without having to say "I don't want this checked."

**Why allow customers to override the policy matrix at all if defaults are aggressive?** Because not all customers are in the same context. A regulated bio/clinical customer needs maximum aggression; a hobbyist exploring AI tools wants minimum interference. The defaults serve the majority who haven't expressed a preference; configuration serves the minority who have. Both are first-class customers.

**Why distinguish "non-configurable" from just "we strongly recommend"?** Because vendor reputation depends on certain things. If a customer disables secret detection and then ships secrets to production, they will blame the vendor regardless of who configured what. Some things must be non-configurable to protect the vendor's integrity and the customer's outcomes simultaneously.
