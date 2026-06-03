// ===========================================
// Quality & edit registrars — code-quality gates and gated file mutation:
// structural check, full verify gate, codebase search, atomic multi-edit /
// gated write, artifact-structure management, and the coverage / mutation
// per-file ratchets.
// ===========================================

import { type Command, type OptionValues } from "commander";

export function registerQualityCommands(program: Command): void {
	program
		.command("check")
		.description(
			"Scan project for structural issues and optionally run external tool checks (tsc, biome, eslint, semgrep, gitleaks, mypy, ruff, etc.)",
		)
		.option(
			"--only <check>",
			"Run only a specific check (structural: broken-imports, cycles, duplicates, missing-tests, secrets, any-types, blast-radius, dead-imports; tools: tsc, biome, eslint, semgrep, gitleaks, mypy, ruff, cargo-check, cargo-clippy, go-build, golangci-lint, c-compile, clang-tidy)",
		)
		.option(
			"--tools [list]",
			"Also run external tool checks (comma-separated, or omit for all available)",
		)
		.option("--report", "Show tool coverage/discovery report")
		.option("--json", "Machine-readable output")
		.option("--cwd <path>", "Project root (default: current directory)")
		.action(async (opts: OptionValues) => {
			const { checkCommand } = await import("../commands/check.js");
			await checkCommand(opts);
		});

	program
		.command("search <query>")
		.description("Search the local codebase (ripgrep with native fallback)")
		.option("--path <dir>", "Search root directory (default: cwd)")
		.option("--glob <pattern>", "File glob pattern (e.g. '*.ts')")
		.option("--type <type>", "File type filter for ripgrep (e.g. ts, py, rust)")
		.option("--limit <n>", "Max results (default: 30, max: 200)")
		.option("--context <n>", "Context lines around matches (default: 2)")
		.option("--engine <engine>", "Force engine: ripgrep or native")
		.option("--json", "Machine-readable output")
		.option("--short", "One-line summary")
		.option("--full", "Full output with context lines")
		.action(async (query: string, opts: OptionValues) => {
			const { searchCommand } = await import("../commands/search.js");
			await searchCommand(query, opts);
		});

	program
		.command("multi-edit [path]")
		.description(
			"Apply N old/new string edits atomically to one or more files. Gate runs once on final content. Ambiguity evaluated after prior edits.",
		)
		.option("--stdin", "Read a single-file manifest ({version,edits}) from stdin (requires <path>)")
		.option(
			"--manifest <file>",
			"Read a single- or multi-file manifest ({version,edits} or {version,batches}) from <file>",
		)
		.option("--json", "Machine-readable output (emits the design-doc error-code shape)")
		.action(async (path: string | undefined, opts: OptionValues) => {
			const { multiEditCommand } = await import("../commands/multi-edit.js");
			await multiEditCommand(path, opts);
		});

	program
		.command("verify [target]")
		.description(
			"Run tsc + biome on a project and report errors. Target can be a local path, GitHub URL, or any git remote URL.",
		)
		.option("--only <tool>", "Run only tsc or biome (e.g., --only tsc)")
		.option("--suggestions", "Also run scored regex heuristics (sql-injection, perf, quality)")
		.option("--json", "Machine-readable output")
		.option("--details", "Show per-file details for all findings")
		.option("--cwd <path>", "Project root (default: current directory)")
		.option("--branch <ref>", "Branch, tag, or commit to check (remote repos)")
		.option("--subdir <path>", "Only scan a subdirectory (useful for monorepos)")
		.option(
			"--skip <checks>",
			"Skip specific checks (comma-separated: semgrep,knip,complexity,silent_catches,...)",
		)
		.option("--suppress <entries...>", "Suppress a finding: file:check or file:check:reason")
		.option("--show-suppressions", "List all active suppressions")
		.option("--structure", "Include generic artifact structure checks")
		.option("--structure-only", "Run only structure checks")
		.option("--adoption-gate", "Fail when adopted categories drop below thresholds")
		.option(
			"--all-checks",
			"Include broad advisory smell checks and dead-code scans in addition to the default high-signal audit",
		)
		.option(
			"--dead-code",
			"Run Supermodel's cloud dead-code analysis (opt-in; requires the `supermodel` CLI)",
		)
		.action(async (target: string | undefined, opts: OptionValues) => {
			const { verifyCommand } = await import("../commands/verify.js");
			await verifyCommand({ ...opts, ...(target !== undefined ? { target } : {}) });
		});

	// `interlinked write` routes Bash-mediated file writes through the full
	// content-quality pipeline (pre_block registry, biome diff-overlay, tsc
	// diff-overlay). The Bash pre_block rule BLOCKS naive `node -e
	// fs.writeFileSync(...)` / `cat > file.ts` / `sed -i` / `tee` invocations
	// against tracked source files; this command is the supported escape
	// hatch for coordinated multi-site atomic edits (add an import AND use
	// it in the same landing) that would trip the diff-overlay if staged as
	// two separate Edit calls. See
	// `docs/design/bash-writes-through-content-gates.md`.
	program
		.command("write [path]")
		.description(
			"Write file(s) through the content-quality gate (pre_block + biome + tsc diff-overlay). Supports --stdin, --from-file, and --batch <manifest.json> for atomic multi-file writes.",
		)
		.option("--stdin", "Read content from stdin (single-file mode)")
		.option("--from-file <src>", "Read content from a source file (single-file mode)")
		.option(
			"--batch <manifest>",
			"Path to a batch manifest JSON {version:1, writes:[{path,content}]}",
		)
		.option("--unsafe-outside-repo", "Allow writing outside the project root (discouraged)")
		.option("--json", "Machine-readable output")
		.action(async (path: string | undefined, opts: OptionValues) => {
			const { writeCommand } = await import("../commands/write.js");
			await writeCommand(path, opts);
		});

	// Structure: generic artifact structure management
	const structCmd = program
		.command("structure")
		.description("Generic artifact structure management (manifests, catalogs, adoption)");

	structCmd
		.command("init")
		.description("Create interlinked/structure.json and scaffold artifact files")
		.option("--mode <mode>", "Structure mode: minimal, standard, strict", "standard")
		.option("--with <categories>", "Comma-separated artifact categories to scaffold")
		.option("--write", "Actually write files (default is dry-run)")
		.option("--json", "Machine-readable output")
		.action(async (opts: OptionValues) => {
			const { structureInitCommand } = await import("../commands/structure.js");
			await structureInitCommand(opts);
		});

	structCmd
		.command("scan")
		.description("Build or refresh local generated artifact catalogs")
		.option("--full", "Force full rescan")
		.option("--incremental", "Only refresh changed categories")
		.option("--json", "Machine-readable output")
		.action(async (opts: OptionValues) => {
			const { structureScanCommand } = await import("../commands/structure.js");
			await structureScanCommand(opts);
		});

	structCmd
		.command("status")
		.description("Show adoption coverage, cache staleness, and invalid references")
		.option("--json", "Machine-readable output")
		.action(async (opts: OptionValues) => {
			const { structureStatusCommand } = await import("../commands/structure.js");
			await structureStatusCommand(opts);
		});

	structCmd
		.command("accept")
		.description("Promote extracted findings into committed artifact files")
		.option("--json", "Machine-readable output")
		.action(async (opts: OptionValues) => {
			const { structureAcceptCommand } = await import("../commands/structure.js");
			await structureAcceptCommand(opts);
		});

	structCmd
		.command("doctor")
		.description("Validate structure files, cache freshness, and cross-references")
		.option("--json", "Machine-readable output")
		.action(async (opts: OptionValues) => {
			const { structureDoctorCommand } = await import("../commands/structure.js");
			await structureDoctorCommand(opts);
		});

	structCmd
		.command("baseline <action>")
		.description("Manage structure baselines (save, clear, status)")
		.option("--json", "Machine-readable output")
		.action(async (action: string, opts: OptionValues) => {
			const { structureBaselineCommand } = await import("../commands/structure.js");
			await structureBaselineCommand(action, opts);
		});

	// ===========================================
	// Coverage ratchet — per-file coverage-delta gate
	// ===========================================
	const coverageCmd = program
		.command("coverage")
		.description("Per-file coverage ratchet — fails on any file whose coverage drops");

	coverageCmd
		.command("check", { isDefault: true })
		.description("Compare current coverage against baseline and exit non-zero on any per-file drop")
		.option("--summary <path>", "Path to coverage-summary.json", "coverage/coverage-summary.json")
		.option(
			"--baseline <path>",
			"Path to baseline (defaults to .interlinked/coverage-baseline.json)",
		)
		.option("--update-baseline", "Persist the current coverage as the new baseline")
		.option("--json", "Machine-readable output")
		.action(async (opts: OptionValues) => {
			const { coverageCheckCommand } = await import("../commands/coverage.js");
			await coverageCheckCommand(opts);
		});

	coverageCmd
		.command("baseline")
		.description("Show the current coverage baseline")
		.option("--json", "Machine-readable output")
		.action(async (opts: { json?: boolean }) => {
			const { coverageBaselineCommand } = await import("../commands/coverage.js");
			coverageBaselineCommand(opts);
		});

	// ===========================================
	// Mutation ratchet — per-file mutation-score gate
	// ===========================================
	const mutationCmd = program
		.command("mutation")
		.description("Per-file mutation-score ratchet — fails on any file whose mutation score drops");

	mutationCmd
		.command("check", { isDefault: true })
		.description("Compare the Stryker report against baseline and exit non-zero on any drop")
		.option("--report <path>", "Path to Stryker mutation.json", "reports/mutation/mutation.json")
		.option(
			"--baseline <path>",
			"Path to baseline (defaults to .interlinked/mutation-baseline.json)",
		)
		.option("--update-baseline", "Persist the current mutation scores as the new baseline")
		.option("--json", "Machine-readable output")
		.action(async (opts: OptionValues) => {
			const { mutationCheckCommand } = await import("../commands/mutation.js");
			await mutationCheckCommand(opts);
		});

	mutationCmd
		.command("baseline")
		.description("Show the current mutation-score baseline")
		.option("--json", "Machine-readable output")
		.action(async (opts: { json?: boolean }) => {
			const { mutationBaselineCommand } = await import("../commands/mutation.js");
			mutationBaselineCommand(opts);
		});
}
