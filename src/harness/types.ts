// ===========================================
// Interlinked Harness — Type Definitions (barrel)
// ===========================================
// Shared types for the harness server, evaluator, cohort, and reservations.
//
// This file is a BARREL. The actual declarations live in `src/harness/types/`,
// split by domain. It re-exports 100% of the prior public surface so every
// existing `import { ... } from "./types.js"` / `"../types.js"` keeps working
// with zero changes. Add new harness types to the relevant `types/<domain>.ts`
// module and re-export them here.
//
// Modules:
//   events.ts            — Determinism, hook events, agent classification, HarnessEvent
//   decisions.ts         — HarnessDecision, CheckResultEntry, GrepStats, LogEntry, ReservationAction
//   rules.ts             — GuardRule, RulePattern, InputRewrite, ActiveWhen scoping
//   config.ts            — GuardRulesConfig and every nested config interface
//   cohort-reservations.ts — agent cohort + file reservation types
//   taint.ts             — sensitivity / taint tracking + output scanning config
//   session.ts           — SessionTrajectory, TDD-cycle, session-level tracking
//   graph.ts             — project graph, structural & impact analysis types
//   language.ts          — language profiles + tool concurrency classification
//   policy.ts            — escalation request + LLM policy classifier types
//   failure-recovery.ts  — Phase 1 failure-recovery channel types
//   env-vars.ts          — SAFE_ENV_VARS / DANGEROUS_ENV_VARS runtime constants

// --- events ---
export type {
	Determinism,
	HookEventName,
	AgentSource,
	AgentRole,
	HarnessEvent,
} from "./types/events.js";
export { ASK_CAPABLE_AGENTS, agentSupportsAsk } from "./types/events.js";

// --- decisions ---
export type {
	HarnessDecision,
	CheckResultEntry,
	GrepStats,
	LogEntry,
	ReservationAction,
} from "./types/decisions.js";

// --- guard rules ---
export type {
	InputRewrite,
	GuardRule,
	RulePattern,
	ActiveWhen,
	PhaseSpec,
	AfterCommandSpec,
	SessionPredicateSpec,
	ActiveSkillRecord,
} from "./types/rules.js";

// --- guard rules configuration ---
export type {
	ProtectedFileRule,
	FileReminder,
	CurlMcpConfig,
	QualityCheckConfig,
	DiffAwareConfig,
	PreEditBaseline,
	GuardRulesConfig,
	VerificationStopChecksConfig,
	CommitCadenceConfig,
	ProjectWideCheckConfig,
	StructuralChecksConfig,
	ErrorMemoryConfig,
	ErrorRecord,
} from "./types/config.js";

// --- agent cohort + file reservations ---
export type {
	AgentStatus,
	CohortAgent,
	ReservationEntry,
	ReservationConflict,
} from "./types/cohort-reservations.js";

// --- sensitivity / taint tracking + output scanning ---
export type {
	SensitivityLevel,
	TaintSource,
	TaintTrackingConfig,
	OutputScanningConfig,
} from "./types/taint.js";

// --- session trajectory + TDD cycle ---
export type {
	AssertionCounts,
	SessionTrajectory,
	TddCycleState,
	TddCycle,
	WarningRecord,
	CheckEffectivenessStats,
	FeedbackEffectivenessSummary,
	FailedFileEntry,
	PendingCompletion,
	RouteInfo,
	TurnEndSummary,
	LearnedRule,
} from "./types/session.js";

// --- project graph, structural & impact analysis ---
export type {
	ExportedSymbol,
	ImportEdge,
	StructuralCheckResult,
	ModuleRole,
	ImpactSeverity,
	ImpactAnalysisResult,
} from "./types/graph.js";

// --- language profiles + tool concurrency ---
export type {
	LanguageId,
	LanguageProfile,
	LanguageCheckDef,
	LanguageTestDef,
	InlineCheckDef,
	ToolConcurrencyClass,
} from "./types/language.js";

// --- escalation request + LLM policy classifier ---
export type {
	EscalationRequest,
	ClassifierConfig,
	PolicyClassification,
	PolicyEvidence,
	PolicyRule,
} from "./types/policy.js";

// --- Phase 1 failure-recovery channels ---
export type {
	TriageLabel,
	ToolFailureEvent,
	TriageRule,
	TriageResult,
	RecoverySuggestion,
	RecoveryContext,
	RollbackAssessment,
	ExplanationTemplate,
	FailureRecord,
} from "./types/failure-recovery.js";

// --- env var safety classification (runtime constants) ---
export { SAFE_ENV_VARS, DANGEROUS_ENV_VARS } from "./types/env-vars.js";
