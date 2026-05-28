// Combined CHECK_REGISTRY: concatenation of the five entry categories.

import { C_CPP_ENTRIES } from "./entries-c-cpp.js";
import { ERROR_ENTRIES } from "./entries-errors.js";
import { SWIFT_ENTRIES } from "./entries-swift.js";
import { TASTE_ENTRIES } from "./entries-taste.js";
import { WARNING_ENTRIES } from "./entries-warnings.js";
import type { CheckRegistration } from "./types.js";

export const CHECK_REGISTRY: CheckRegistration[] = [
	...ERROR_ENTRIES,
	...WARNING_ENTRIES,
	...TASTE_ENTRIES,
	...C_CPP_ENTRIES,
	...SWIFT_ENTRIES,
];
