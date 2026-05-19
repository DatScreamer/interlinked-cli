// interlinked-tdd: exempt — type declarations only, no runtime logic.
// ===========================================
// Interlinked Harness — Project Graph, Structural & Impact Analysis Types
// ===========================================

// ===========================================
// Project Graph — Import/Export Indexing
// ===========================================

export interface ExportedSymbol {
	/** Symbol name ("default" for default exports) */
	name: string;
	/** What kind of export */
	kind:
		| "function"
		| "class"
		| "const"
		| "let"
		| "var"
		| "interface"
		| "type"
		| "enum"
		| "default"
		| "re-export"
		| "namespace";
	/** Whether this is a type-only export */
	isTypeOnly: boolean;
	/** Line number (1-based) */
	line: number;
}

export interface ImportEdge {
	/** File that contains the import statement */
	fromFile: string;
	/** Resolved absolute path of the imported module */
	toFile: string;
	/** Raw import specifier (e.g., "./utils", "../types") */
	specifier: string;
	/** Imported symbol names (empty for side-effect or namespace imports) */
	symbols: string[];
	/** Whether this is a type-only import */
	isTypeOnly: boolean;
}

// ===========================================
// Structural Check Results
// ===========================================

export interface StructuralCheckResult {
	/** Which check produced this result */
	check: string;
	/** Severity level */
	severity: "error" | "warning" | "info";
	/** Human-readable message for the agent */
	message: string;
	/** The file that was edited */
	file: string;
	/** Additional detail (affected files, diff, etc.) */
	detail?: string;
	/** Files affected by this issue */
	affectedFiles?: string[];
}

// ===========================================
// Module Role Classification
// ===========================================

/** Classification based on import/export connectivity */
export type ModuleRole = "leaf" | "internal" | "hub" | "root";

// ===========================================
// Impact Analysis
// ===========================================

export type ImpactSeverity = "low" | "medium" | "high" | "critical";

export interface ImpactAnalysisResult {
	/** The file that was edited */
	file: string;
	/** Overall severity classification */
	severity: ImpactSeverity;
	/** Module role from ProjectGraph */
	moduleRole: ModuleRole;
	/** Total number of direct dependents */
	dependentCount: number;
	/** Files that would break from export surface changes */
	breakingFiles: string[];
	/** Test files that cover the edited file */
	testFiles: string[];
	/** Files that need follow-up updates */
	followUpFiles: string[];
	/** Whether exports actually changed (vs internal-only edit) */
	exportSurfaceChanged: boolean;
	/** Human-readable summary for the agent */
	summary: string;
}
