import { isJsonObject } from "../../lib/json-types.js";
import type { GuardRulesConfig, HarnessEvent, SessionTrajectory } from "../types.js";
import { STUB_INTRODUCED_CAP, scanForStubs } from "../verification-stop-checks.js";
import { isFileWrite } from "./tool-classifiers.js";

/** Record newly written stub patterns for the verification-before-stop nudge. */
export function recordStubsIntroduced(
	event: HarnessEvent,
	rules: GuardRulesConfig,
	session: SessionTrajectory | undefined,
): void {
	if (!session) return;
	const vsc = rules.verification_stop_checks;
	if (!vsc?.enabled || !vsc.warn_stubs_introduced) return;
	const toolName = event.tool_name || "";
	if (!isFileWrite(toolName)) return;
	const filePathValue = event.tool_input?.file_path;
	const pathValue = event.tool_input?.path;
	let filePath = "";
	if (typeof filePathValue === "string") filePath = filePathValue;
	else if (typeof pathValue === "string") filePath = pathValue;
	if (!filePath) return;
	if (!session.stubs_introduced) session.stubs_introduced = [];

	const pushMatches = (content: string): void => {
		if (!session.stubs_introduced) return;
		if (session.stubs_introduced.length >= STUB_INTRODUCED_CAP) return;
		for (const stub of scanForStubs(content)) {
			if (session.stubs_introduced.length >= STUB_INTRODUCED_CAP) break;
			session.stubs_introduced.push({ file: filePath, kind: stub.kind, snippet: stub.snippet });
		}
	};

	for (const text of collectStubScanInputs(event)) pushMatches(text);
}

/** Gather Write, Edit, and MultiEdit string payloads that may contain stubs. */
function collectStubScanInputs(event: HarnessEvent): string[] {
	const inputs: string[] = [];
	const content = event.tool_input?.content;
	if (typeof content === "string") inputs.push(content);

	const newString = event.tool_input?.new_string;
	if (typeof newString === "string") inputs.push(newString);

	const edits = event.tool_input?.edits;
	if (Array.isArray(edits)) {
		for (const edit of edits) {
			if (!isJsonObject(edit)) continue;
			const newValue = edit.new_string;
			if (typeof newValue === "string") inputs.push(newValue);
		}
	}
	return inputs;
}
