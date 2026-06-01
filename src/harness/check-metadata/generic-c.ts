// Metadata fragment: C / C++ checks. Composed into GENERIC_CHECK_META in
// ./generic.ts.

import type { CheckMeta } from "./types.js";

export const GENERIC_C_META: Record<string, CheckMeta> = {
	// C/C++ checks
	c_unsafe_functions: {
		name: "C Unsafe Functions",
		description: "Detects unsafe C functions: strcpy, strcat, gets, sprintf",
		tier: 1,
		determinism: "fully_deterministic",
	},
	c_include_guard: {
		name: "C Include Guard",
		description: "Detects header files missing #pragma once or #ifndef guard",
		tier: 1,
		determinism: "fully_deterministic",
	},
	c_strcmp_boolean_misuse: {
		name: "C strcmp Boolean Misuse",
		description: "Detects strcmp return value used as boolean without comparison",
		tier: 1,
		determinism: "partially_deterministic",
	},
	c_unchecked_malloc: {
		name: "C Unchecked Malloc",
		description: "Detects malloc/calloc/realloc without null check",
		tier: 2,
		determinism: "partially_deterministic",
	},
	c_sprintf_usage: {
		name: "C sprintf Usage",
		description: "Detects sprintf — use snprintf for bounds safety",
		tier: 1,
		determinism: "fully_deterministic",
	},
};
