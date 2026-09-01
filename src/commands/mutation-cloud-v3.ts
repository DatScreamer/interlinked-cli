// =========================================================
// mutation cloud — explicit protocol-v3 submit/process verbs
// =========================================================

import { resolve } from "node:path";
import { isJsonObject } from "../lib/json-types.js";
import { getOutputMode, output, outputError } from "../lib/output.js";
import { loadMutationCloudV3Config } from "../harness/mutation/mutation-cloud-v3-config.js";
import {
	MutationCloudV3Runtime,
	type MutationCloudV3OnboardResult,
	type MutationCloudV3ProcessResult,
	type MutationCloudV3RedriveResult,
	type MutationCloudV3RuntimeConfig,
	type MutationCloudV3SubmitResult,
} from "../harness/mutation/mutation-cloud-v3-runtime.js";
import type { DeadLetteredMutationJob } from "../harness/mutation/mutation-journal-types.js";
import { parseMutationJobRequestV3 } from "../harness/mutation/protocol-v3/request.js";
import {
	MAX_SOURCE_ARTIFACT_BYTES,
	MAX_TARGET_SOURCE_BYTES,
	checkRepoRelativePath,
} from "../harness/mutation/protocol-v3/field-checks.js";
import {
	type BoundedLocalRead,
	readConfinedFileBytes,
	readConfinedFileText,
} from "../harness/mutation/mutation-cloud-v3-local-read.js";

const MAX_JOB_REQUEST_BYTES = 1024 * 1024;
const DEFAULT_DEAD_LETTER_LIMIT = 20;
const MAX_DEAD_LETTER_LIMIT = 100;

export interface MutationCloudV3SubmitCommandOptions {
	request: string;
	artifact: string;
	config?: string;
	cwd?: string;
	json?: boolean;
}

export interface MutationCloudV3ProcessCommandOptions {
	config?: string;
	cwd?: string;
	json?: boolean;
}

export type MutationCloudV3OnboardCommandOptions = MutationCloudV3ProcessCommandOptions;
export type MutationCloudV3SubmitEditCommandOptions = MutationCloudV3ProcessCommandOptions;

export interface MutationCloudV3DeadLettersCommandOptions extends MutationCloudV3ProcessCommandOptions {
	limit?: string;
}

export interface MutationCloudV3RedriveCommandOptions extends MutationCloudV3ProcessCommandOptions {
	redriveToken: string;
}

interface RuntimeHandle {
	onboard(targetFile: string): Promise<MutationCloudV3OnboardResult>;
	submitEdit(targetFile: string, proposedBytes: Uint8Array): Promise<MutationCloudV3SubmitResult>;
	submit(input: Parameters<MutationCloudV3Runtime["submit"]>[0]): Promise<MutationCloudV3SubmitResult>;
	processNext(): Promise<MutationCloudV3ProcessResult>;
	listDeadLetters(limit: number): DeadLetteredMutationJob[];
	redriveDeadLetter(jobId: string, redriveToken: string): MutationCloudV3RedriveResult;
	close(): void;
}

export interface MutationCloudV3CommandDependencies {
	readBytes?: (input: BoundedLocalRead) => Uint8Array;
	readText?: (input: BoundedLocalRead) => string;
	loadConfig?: (root: string, path?: string) => MutationCloudV3RuntimeConfig;
	openRuntime?: (root: string, config: MutationCloudV3RuntimeConfig) => RuntimeHandle;
	clock?: () => number;
}

function dependencies(overrides: MutationCloudV3CommandDependencies): Required<MutationCloudV3CommandDependencies> {
	return {
		readBytes: overrides.readBytes ?? readConfinedFileBytes,
		readText: overrides.readText ?? readConfinedFileText,
		loadConfig: overrides.loadConfig ?? loadMutationCloudV3Config,
		openRuntime: overrides.openRuntime ?? ((root, config) => new MutationCloudV3Runtime(root, config)),
		clock: overrides.clock ?? Date.now,
	};
}
function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function deadLetterLimit(raw: string | undefined): number {
	const text = raw ?? String(DEFAULT_DEAD_LETTER_LIMIT);
	if (!/^\d+$/.test(text)) {
		throw new Error(`--limit must be an integer from 1 through ${MAX_DEAD_LETTER_LIMIT}`);
	}
	const limit = Number(text);
	if (!Number.isFinite(limit) || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_DEAD_LETTER_LIMIT) {
		throw new Error(`--limit must be an integer from 1 through ${MAX_DEAD_LETTER_LIMIT}`);
	}
	return limit;
}

function readRequest(
	root: string,
	path: string,
	readText: Required<MutationCloudV3CommandDependencies>["readText"],
) {
	let raw: unknown;
	try {
		raw = JSON.parse(readText({ root, path, maxBytes: MAX_JOB_REQUEST_BYTES, label: "mutation job request" }));
	} catch (error) {
		throw new Error(`could not read mutation job request ${path}: ${errorMessage(error)}`, { cause: error });
	}
	const parsed = parseMutationJobRequestV3(raw);
	if (!parsed.ok) throw new Error(`mutation job request ${path} is invalid: ${parsed.reason}`);
	return parsed.request;
}

function verdict(result: MutationCloudV3ProcessResult): string | null {
	const decision = result.evaluation?.decision;
	if (!isJsonObject(decision)) return null;
	const value = decision.verdict;
	return typeof value === "string" ? value : null;
}

function findingSummary(result: MutationCloudV3ProcessResult): string | null {
	const first = result.evaluation?.findings[0]?.payload;
	return isJsonObject(first) && typeof first.message === "string" && first.message.length > 0
		? first.message
		: null;
}

function evaluationSuffix(result: MutationCloudV3ProcessResult): string {
	const localVerdict = verdict(result);
	const finding = findingSummary(result);
	return [
		...(localVerdict === null ? [] : [`local verdict: ${localVerdict}`]),
		...(finding === null ? [] : [finding]),
	].join("; ");
}

function renderProcess(result: MutationCloudV3ProcessResult): string {
	const outcome = result.processor;
	if (outcome.kind === "idle") return "No durable mutation job is ready.";
	if (outcome.kind === "pending") return `Mutation job ${outcome.jobId} is accepted and still pending.`;
	if (outcome.kind === "acknowledged") {
		const summary = evaluationSuffix(result);
		const suffix = summary === "" ? "" : `; ${summary}`;
		return `Mutation job ${outcome.jobId} was journaled before remote acknowledgement${suffix}.`;
	}
	if (outcome.kind === "lost_lease") {
		return `Mutation job ${outcome.jobId} lost its local lease during ${outcome.stage}; no clean verdict exists.`;
	}
	if (outcome.kind === "dead_letter") {
		return `Mutation job ${outcome.jobId} was dead-lettered after ${outcome.failureCount} failures during ${outcome.stage}: ${outcome.reason}; no clean verdict exists.`;
	}
	const summary = evaluationSuffix(result);
	const suffix = summary === "" ? "" : `; ${summary}`;
	return `Mutation job ${outcome.jobId} remains durable for retry after ${outcome.stage}: ${outcome.reason}${suffix}`;
}

function processingFailed(result: MutationCloudV3ProcessResult): boolean {
	return result.processor.kind === "retry" ||
		result.processor.kind === "dead_letter" ||
		result.processor.kind === "lost_lease";
}

function compactError(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function renderDeadLetters(rows: readonly DeadLetteredMutationJob[]): string {
	if (rows.length === 0) return "No mutation cloud job dead letters.";
	return [
		`Mutation cloud job dead letters (${rows.length}):`,
		...rows.flatMap((row) => [
			`${row.jobId}  phase=${row.phase}  failures=${row.failureCount}  dead_lettered_at_ms=${row.deadLetteredAtMs}`,
			`  redrive_token=${row.redriveToken}`,
			`  last_error=${compactError(row.lastError)}`,
		]),
	].join("\n");
}

export async function mutationCloudV3SubmitCommand(
	opts: MutationCloudV3SubmitCommandOptions,
	overrides: MutationCloudV3CommandDependencies = {},
): Promise<void> {
	const mode = getOutputMode(opts);
	const deps = dependencies(overrides);
	const root = resolve(opts.cwd ?? process.cwd());
	let runtime: RuntimeHandle | null = null;
	try {
		const requestPath = resolve(root, opts.request);
		const request = readRequest(root, requestPath, deps.readText);
		const artifactPath = resolve(root, opts.artifact);
		const targetPath = resolve(root, request.job.target_file);
		const sourceArtifactBytes = deps.readBytes({
			root,
			path: artifactPath,
			maxBytes: MAX_SOURCE_ARTIFACT_BYTES,
			label: "mutation source artifact",
		});
		const targetBytes = deps.readBytes({
			root,
			path: targetPath,
			maxBytes: MAX_TARGET_SOURCE_BYTES,
			label: "mutation target source",
		});
		const config = deps.loadConfig(root, opts.config);
		runtime = deps.openRuntime(root, config);
		const result = await runtime.submit({
			request,
			sourceArtifactBytes,
			targetBytes,
			createdAtMs: deps.clock(),
		});
		output(mode, result, {
			json: () => result,
			normal: () => `${renderProcess(result.immediate)}\nSubmission: ${result.submission.jobId}`,
		});
		if (processingFailed(result.immediate)) process.exitCode = 1;
	} catch (error) {
		outputError(mode, errorMessage(error));
	} finally {
		runtime?.close();
	}
}

export async function mutationCloudV3OnboardCommand(
	target: string,
	opts: MutationCloudV3OnboardCommandOptions,
	overrides: MutationCloudV3CommandDependencies = {},
): Promise<void> {
	const mode = getOutputMode(opts);
	const deps = dependencies(overrides);
	const root = resolve(opts.cwd ?? process.cwd());
	let runtime: RuntimeHandle | null = null;
	try {
		runtime = deps.openRuntime(root, deps.loadConfig(root, opts.config));
		const result = await runtime.onboard(target);
		output(mode, result, {
			json: () => result,
			normal: () => `Mutation onboarding ${result.onboarding.jobId} activated from immutable HEAD.\n${renderProcess(result.immediate)}`,
		});
		if (processingFailed(result.immediate)) process.exitCode = 1;
	} catch (error) {
		outputError(mode, errorMessage(error));
	} finally {
		runtime?.close();
	}
}

/** Explicit proposed-edit submission. This is not the live gate: the caller
 * opts in to one current target, and the durable journal still records the
 * proposed edit with require_established baseline semantics. */
export async function mutationCloudV3SubmitEditCommand(
	target: string,
	opts: MutationCloudV3SubmitEditCommandOptions,
	overrides: MutationCloudV3CommandDependencies = {},
): Promise<void> {
	const mode = getOutputMode(opts);
	const deps = dependencies(overrides);
	const root = resolve(opts.cwd ?? process.cwd());
	let runtime: RuntimeHandle | null = null;
	try {
		const invalidTarget = checkRepoRelativePath(target, "mutation per-edit target");
		if (invalidTarget !== null) throw new Error(invalidTarget);
		const config = deps.loadConfig(root, opts.config);
		const targetBytes = deps.readBytes({
			root,
			path: resolve(root, target),
			maxBytes: MAX_TARGET_SOURCE_BYTES,
			label: "mutation per-edit target",
		});
		runtime = deps.openRuntime(root, config);
		const result = await runtime.submitEdit(target, targetBytes);
		output(mode, result, {
			json: () => result,
			normal: () => `${renderProcess(result.immediate)}\nProposed edit submission: ${result.submission.jobId} (require_established).`,
		});
		if (processingFailed(result.immediate)) process.exitCode = 1;
	} catch (error) {
		outputError(mode, errorMessage(error));
	} finally {
		runtime?.close();
	}
}

export async function mutationCloudV3ProcessCommand(
	opts: MutationCloudV3ProcessCommandOptions,
	overrides: MutationCloudV3CommandDependencies = {},
): Promise<void> {
	const mode = getOutputMode(opts);
	const deps = dependencies(overrides);
	const root = resolve(opts.cwd ?? process.cwd());
	let runtime: RuntimeHandle | null = null;
	try {
		runtime = deps.openRuntime(root, deps.loadConfig(root, opts.config));
		const result = await runtime.processNext();
		output(mode, result, { json: () => result, normal: () => renderProcess(result) });
		if (processingFailed(result)) process.exitCode = 1;
	} catch (error) {
		outputError(mode, errorMessage(error));
	} finally {
		runtime?.close();
	}
}

export async function mutationCloudV3DeadLettersCommand(
	opts: MutationCloudV3DeadLettersCommandOptions,
	overrides: MutationCloudV3CommandDependencies = {},
): Promise<void> {
	const mode = getOutputMode(opts);
	const deps = dependencies(overrides);
	const root = resolve(opts.cwd ?? process.cwd());
	let runtime: RuntimeHandle | null = null;
	try {
		const limit = deadLetterLimit(opts.limit);
		runtime = deps.openRuntime(root, deps.loadConfig(root, opts.config));
		const deadLetters = runtime.listDeadLetters(limit);
		const result = { limit, deadLetters };
		output(mode, result, { json: () => result, normal: () => renderDeadLetters(deadLetters) });
	} catch (error) {
		outputError(mode, errorMessage(error));
	} finally {
		runtime?.close();
	}
}

export async function mutationCloudV3RedriveCommand(
	jobId: string,
	opts: MutationCloudV3RedriveCommandOptions,
	overrides: MutationCloudV3CommandDependencies = {},
): Promise<void> {
	const mode = getOutputMode(opts);
	const deps = dependencies(overrides);
	const root = resolve(opts.cwd ?? process.cwd());
	let runtime: RuntimeHandle | null = null;
	try {
		runtime = deps.openRuntime(root, deps.loadConfig(root, opts.config));
		const result = runtime.redriveDeadLetter(jobId, opts.redriveToken);
		output(mode, result, {
			json: () => result,
			normal: () => `Mutation job ${result.jobId} was redriven and is due for processing; no job was processed.`,
		});
	} catch (error) {
		outputError(mode, errorMessage(error));
	} finally {
		runtime?.close();
	}
}
