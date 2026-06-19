// interlinked-tdd: exempt
// ===========================================
// Dead Import Detection (shared with structural-checks.ts)
// ===========================================

// Helper: true for lines that precede / interleave with imports but are not
// themselves import statements (blank, JSDoc/star comments, shebang).
function isNonImportPrefixLine(trimmed: string): boolean {
	return (
		trimmed === "" ||
		trimmed.startsWith("*") ||
		trimmed.startsWith("/*") ||
		trimmed.startsWith("*/") ||
		trimmed.startsWith("#!")
	);
}

interface ImportScanState {
	bindings: string[];
	lastImportLine: number;
	buffer: string;
	importSectionEnded: boolean;
}

// Helper: processes a single source line during the import-collection scan,
// mutating `state` (buffer continuation, binding extraction, section end).
function scanImportLine(state: ImportScanState, lineIndex: number, trimmed: string): void {
	if (state.buffer) {
		state.buffer += ` ${trimmed}`;
		if (/from\s+['"]/.test(state.buffer) || /['"]/.test(state.buffer)) {
			extractBindings(state.buffer, state.bindings);
			state.buffer = "";
		}
		state.lastImportLine = lineIndex;
		return;
	}
	// Stop scanning once we hit non-import code (prevents matching imports
	// inside string literals, template HTML, generated scripts, etc.)
	if (state.importSectionEnded) return;
	if (isNonImportPrefixLine(trimmed)) return;
	if (/^import\s/.test(trimmed) && trimmed.includes("{") && !trimmed.includes("}")) {
		state.buffer = trimmed;
		state.lastImportLine = lineIndex;
		return;
	}
	if (/^import\s/.test(trimmed)) {
		extractBindings(trimmed, state.bindings);
		state.lastImportLine = lineIndex;
		return;
	}
	// Non-import, non-blank line — import section is over
	state.importSectionEnded = true;
}

// Helper: returns the subset of import bindings that never appear in the file
// body below the import section.
function filterDeadBindings(bindings: string[], body: string): string[] {
	const dead: string[] = [];
	for (const name of bindings) {
		if (!name || name.length < 2) continue;
		const regex = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
		if (!regex.test(body)) {
			dead.push(name);
		}
	}
	return dead;
}

/** Find import bindings that are not referenced in the file body */
export function findDeadImports(content: string): string[] {
	const lines = content.split("\n");
	const state: ImportScanState = {
		bindings: [],
		lastImportLine: 0,
		buffer: "",
		importSectionEnded: false,
	};

	for (let i = 0; i < lines.length; i++) {
		// Strip inline comments from import lines
		const trimmed = lines[i]
			.trim()
			.replace(/\/\/[^\n]*/g, "")
			.trim();
		scanImportLine(state, i, trimmed);
	}
	if (state.buffer) extractBindings(state.buffer, state.bindings);

	if (state.bindings.length === 0) return [];

	const body = lines.slice(state.lastImportLine + 1).join("\n");
	return filterDeadBindings(state.bindings, body);
}

export function extractBindings(line: string, bindings: string[]): void {
	const trimmed = line.trim();
	if (trimmed.startsWith("//")) return;
	if (/^import\s+['"]/.test(trimmed)) return;
	if (/^import\s+\*\s+as\s/.test(trimmed)) return;

	const namedMatch = trimmed.match(/^import\s+(?:type\s+)?\{([^}]+)\}/);
	if (namedMatch) {
		const names = namedMatch[1]
			.split(",")
			.map((s) => {
				const parts = s
					.trim()
					.replace(/^type\s+/, "")
					.split(/\s+as\s+/);
				return parts[parts.length - 1].trim();
			})
			.filter(Boolean);
		for (const name of names) {
			if (name !== "type") bindings.push(name);
		}
		return;
	}

	const defaultMatch = trimmed.match(/^import\s+(?:type\s+)?(\w+)\s+from/);
	if (defaultMatch && defaultMatch[1] !== "type") {
		bindings.push(defaultMatch[1]);
	}
}
