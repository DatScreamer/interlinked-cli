// ===========================================
// Experimental protocol-v3 mutation-cloud verbs
// ===========================================

import { type Command, type OptionValues } from "commander";

interface MutationCloudRedriveOptions {
	redriveToken: string;
	config?: string;
	cwd?: string;
	json?: boolean;
}

function registerSubmitEditCommand(cloud: Command): void {
	cloud
		.command("submit-edit <target>")
		.description("Submit current target bytes as one immutable-HEAD proposed edit (never baseline adoption)")
		.option("--config <path>", "Local cloud runtime config", ".interlinked/mutation-cloud-v3.local.json")
		.option("--cwd <path>", "Project root (default: current directory)")
		.option("--json", "Machine-readable output")
		.action(async (target: string, opts: OptionValues) => {
			const { mutationCloudV3SubmitEditCommand } = await import("../commands/mutation-cloud-v3.js");
			await mutationCloudV3SubmitEditCommand(target, opts);
		});
}

export function registerMutationCloudCommands(mutationCmd: Command): void {
	const cloud = mutationCmd
		.command("cloud")
		.description("Opt-in protocol-v3 durable mutation jobs (experimental; requires local cloud config)");

	cloud
		.command("onboard <target>")
		.description("Safely adopt one clean immutable-HEAD target through a durable authenticated cloud job")
		.option("--config <path>", "Local cloud runtime config", ".interlinked/mutation-cloud-v3.local.json")
		.option("--cwd <path>", "Project root (default: current directory)")
		.option("--json", "Machine-readable output")
		.action(async (target: string, opts: OptionValues) => {
			const { mutationCloudV3OnboardCommand } = await import("../commands/mutation-cloud-v3.js");
			await mutationCloudV3OnboardCommand(target, opts);
		});

	registerSubmitEditCommand(cloud);

	cloud
		.command("submit")
		.description("Submit one pre-built v3 request, journal its authenticated acceptance, and poll once")
		.requiredOption("--request <path>", "Protocol-v3 MutationJobRequest JSON")
		.requiredOption("--artifact <path>", "Exact source-artifact bytes bound by the request")
		.option("--config <path>", "Local cloud runtime config", ".interlinked/mutation-cloud-v3.local.json")
		.option("--cwd <path>", "Project root (default: current directory)")
		.option("--json", "Machine-readable output")
		.action(async (opts: {
			request: string;
			artifact: string;
			config?: string;
			cwd?: string;
			json?: boolean;
		}) => {
			const { mutationCloudV3SubmitCommand } = await import("../commands/mutation-cloud-v3.js");
			await mutationCloudV3SubmitCommand(opts);
		});

	cloud
		.command("process")
		.description("Resume at most one journaled v3 job through claim, verify, evaluate, commit, and ack")
		.option("--config <path>", "Local cloud runtime config", ".interlinked/mutation-cloud-v3.local.json")
		.option("--cwd <path>", "Project root (default: current directory)")
		.option("--json", "Machine-readable output")
		.action(async (opts: OptionValues) => {
			const { mutationCloudV3ProcessCommand } = await import("../commands/mutation-cloud-v3.js");
			await mutationCloudV3ProcessCommand(opts);
		});

	cloud
		.command("dead-letters")
		.description("List bounded local protocol-v3 job dead letters without claiming or processing them")
		.option("--limit <n>", "Maximum rows to list (default 20, max 100)", "20")
		.option("--config <path>", "Local cloud runtime config", ".interlinked/mutation-cloud-v3.local.json")
		.option("--cwd <path>", "Project root (default: current directory)")
		.option("--json", "Machine-readable output")
		.action(async (opts: OptionValues) => {
			const { mutationCloudV3DeadLettersCommand } = await import("../commands/mutation-cloud-v3.js");
			await mutationCloudV3DeadLettersCommand(opts);
		});

	cloud
		.command("redrive <job-id>")
		.description("Make one token-fenced local job dead letter due again without processing it")
		.requiredOption("--redrive-token <token>", "Fencing token emitted by mutation cloud dead-letters")
		.option("--config <path>", "Local cloud runtime config", ".interlinked/mutation-cloud-v3.local.json")
		.option("--cwd <path>", "Project root (default: current directory)")
		.option("--json", "Machine-readable output")
		.action(async (jobId: string, opts: MutationCloudRedriveOptions) => {
			const { mutationCloudV3RedriveCommand } = await import("../commands/mutation-cloud-v3.js");
			await mutationCloudV3RedriveCommand(jobId, opts);
		});
}
