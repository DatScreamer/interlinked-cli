// C/C++ memory-safety and header-hygiene checks. All pre_block, severity=error.

import {
	checkCIncludeGuard,
	checkCSprintfUsage,
	checkCUnsafeFunctions,
} from "../generic-checks.js";
import type { CheckRegistration } from "./types.js";

export const C_CPP_ENTRIES: CheckRegistration[] = [
	{
		id: "c_unsafe_functions",
		phase: "pre_block",
		name: "C Unsafe Functions",
		description: "Detects unsafe C functions: strcpy, strcat, gets, sprintf",
		tier: 1,
		determinism: "fully_deterministic",
		severity: "error",
		pipeline: "agent_safety",
		fix_instruction:
			"Use safer alternatives: `strncpy` instead of `strcpy`, `strncat` instead of `strcat`, `fgets` instead of `gets`, `snprintf` instead of `sprintf`.",
		fn: checkCUnsafeFunctions,
		resultsPropName: "cUnsafeFunctions",
	},
	{
		id: "c_include_guard",
		phase: "pre_block",
		name: "C Include Guard",
		description: "Detects header files missing #pragma once or #ifndef guard",
		tier: 1,
		determinism: "fully_deterministic",
		severity: "error",
		pipeline: "agent_safety",
		fix_instruction:
			"Add `#pragma once` at the top of the header file, or use a traditional `#ifndef`/`#define` include guard.",
		fn: checkCIncludeGuard,
		resultsPropName: "cIncludeGuard",
	},
	{
		id: "c_sprintf_usage",
		phase: "pre_block",
		name: "C sprintf Usage",
		description: "Detects sprintf — use snprintf for bounds safety",
		tier: 1,
		determinism: "fully_deterministic",
		severity: "error",
		pipeline: "agent_safety",
		fix_instruction:
			"Use `snprintf()` with an explicit buffer size instead of `sprintf()` to prevent buffer overflows.",
		fn: checkCSprintfUsage,
		resultsPropName: "cSprintfUsage",
	},
];
