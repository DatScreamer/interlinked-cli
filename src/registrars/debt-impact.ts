// ===========================================
// Manual debt markers + evidence-classed impact
// ===========================================

import { type Command, type OptionValues } from "commander";

function registerImpactCommand(program: Command): void {
    program
        .command("impact")
        .description("Report evidence-classed local impact facts without causal attribution")
        .option("--base <ref>", "Verified git commit to compare with the worktree", "HEAD")
		.option(
			"--experiment-manifest <path>",
			"Pinned controlled-experiment manifest for an optional causal evidence class",
		)
        .option("--cwd <path>", "Project root (default: current directory)")
        .option("--json", "Machine-readable output")
        .option("--short", "One-line observed summary")
        .option("--full", "Include source scopes and detailed folds")
        .action(async (opts: OptionValues) => {
            const { impactCommand } = await import("../commands/impact.js");
			process.exitCode = await impactCommand(opts);
        });
}

function registerDebtMarkersCommand(program: Command): void {
    const debt = program.commands.find((command) => command.name() === "debt");
    if (!debt) throw new Error("debt command must be registered before debt markers");
    debt
        .command("markers")
        .description("Scan source comments for manual design-debt receipts; recording is explicit")
        .option("--root <path...>", "Source roots to scan (default: project root)")
        .option("--exclude <path...>", "Additional repo-relative paths to exclude")
        .option("--cwd <path>", "Project root (default: current directory)")
        .option("--record", "Append a local source snapshot and lifecycle-transition receipt")
        .option("--reason <text>", "Why this snapshot or closure is being recorded")
        .option("--json", "Machine-readable output")
        .option("--short", "One-line summary")
        .option("--full", "Include marker fields and coverage details")
        .action(async (opts: OptionValues) => {
            const { debtMarkersCommand } = await import("../commands/debt-markers.js");
            await debtMarkersCommand(opts);
        });
}

export function registerDebtImpactCommands(program: Command): void {
    registerImpactCommand(program);
    registerDebtMarkersCommand(program);
}
