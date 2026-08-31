import type { Command } from "commander";
import {
    semanticIndexAction,
    semanticInstallAction,
    semanticModelsAction,
    semanticSearchAction,
    semanticSimilarAction,
    semanticStatusAction,
} from "../commands/semantic.js";

export function registerSemanticCommands(program: Command): void {
    const semantic = program.command("semantic").description("Build and query the optional local semantic function index");

    semantic.command("models")
        .description("List pinned local embedding models and installation state")
        .option("--json", "Machine-readable output")
        .action(async (options: { json?: boolean }) => {
            process.exitCode = await semanticModelsAction(options);
        });

    semantic.command("install")
        .description("Explicitly download and hash-verify a local embedding model")
        .requiredOption("--model <alias>", "Pinned registry model alias")
        .option("--json", "Machine-readable output")
        .action(async (options: { model: string; json?: boolean }) => {
            process.exitCode = await semanticInstallAction(options.model, options);
        });

    semantic.command("index")
        .description("Build or incrementally refresh the local function-vector index")
        .option("--rebuild", "Ignore reusable vectors from the current generation")
        .option("--include-tests", "Include test/spec functions for this build")
        .option("--cwd <path>", "Project root (default: current directory)")
        .option("--json", "Machine-readable output")
        .action(async (options: { rebuild?: boolean; includeTests?: boolean; cwd?: string; json?: boolean }) => {
            process.exitCode = await semanticIndexAction(options);
        });

    semantic.command("status")
        .description("Show absent, building, current, stale, corrupt, and model/runtime states")
        .option("--cwd <path>", "Project root (default: current directory)")
        .option("--json", "Machine-readable output")
        .action(async (options: { cwd?: string; json?: boolean }) => {
            process.exitCode = await semanticStatusAction(options);
        });

    semantic.command("search <query>")
        .description("Embed a query locally and run an exact cosine scan")
        .option("--top <n>", "Maximum results (1-100)", "10")
        .option("--language <id>", "Only return one canonical language id")
        .option("--path <glob>", "Only return repository-relative paths matching the glob")
        .option("--cwd <path>", "Project root (default: current directory)")
        .option("--json", "Machine-readable output")
        .action(async (query: string, options: { top?: string; language?: string; path?: string; cwd?: string; json?: boolean }) => {
            process.exitCode = await semanticSearchAction(query, options);
        });

    semantic.command("similar <file>")
        .description("Find functions similar to the indexed function containing a line")
        .requiredOption("--line <n>", "One-based source line inside the function")
        .option("--top <n>", "Maximum results (1-100)", "10")
        .option("--cwd <path>", "Project root (default: current directory)")
        .option("--json", "Machine-readable output")
        .action(async (file: string, options: { line: string; top?: string; cwd?: string; json?: boolean }) => {
            process.exitCode = await semanticSimilarAction(file, options);
        });
}
