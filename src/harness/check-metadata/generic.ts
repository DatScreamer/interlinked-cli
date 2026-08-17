// Metadata for generic/inline agent safety checks (PostToolUse, regex-based).
// Keys must match the `name` fields in quality-checks.ts agentSafetyChecks array.
//
// This module composes the full GENERIC_CHECK_META record from per-family
// fragments (sibling generic-<family>.ts files). Each fragment exports a
// `Record<string, CheckMeta>` of verbatim entries; the spread below preserves
// every key. Keys are unique across fragments — a duplicate would be silently
// dropped by the spread, which the key-count assertion in index.test.ts guards
// against. To add a check, append its entry to the matching fragment (or add a
// new fragment + spread it here).

import { GENERIC_AGENT_LAZINESS_META } from "./generic-agent-laziness.js";
import { GENERIC_API_SHAPE_META } from "./generic-api-shape.js";
import { GENERIC_C_META } from "./generic-c.js";
import { GENERIC_CORE_JS_META } from "./generic-core-js.js";
import { GENERIC_CROSS_FILE_META } from "./generic-cross-file.js";
import { GENERIC_DEMO_DATA_META } from "./generic-demo-data.js";
import { GENERIC_ENDPOINT_META } from "./generic-endpoint.js";
import { GENERIC_ITERATION_SAFETY_META } from "./generic-iteration-safety.js";
import { GENERIC_REACT_WARNINGS_META } from "./generic-react-warnings.js";
import { GENERIC_SWIFT_META } from "./generic-swift.js";
import { GENERIC_TEST_HYGIENE_META } from "./generic-test-hygiene.js";
import { GENERIC_TYPE_DISCIPLINE_META } from "./generic-type-discipline.js";
import { GENERIC_UBS_META } from "./generic-ubs.js";
import type { CheckMeta } from "./types.js";

/** Public API — consumed by doc generation and re-exported from check-metadata.ts. */
export const GENERIC_CHECK_META: Record<string, CheckMeta> = {
	...GENERIC_API_SHAPE_META,
	...GENERIC_ITERATION_SAFETY_META,
	...GENERIC_CORE_JS_META,
	...GENERIC_REACT_WARNINGS_META,
	...GENERIC_C_META,
	...GENERIC_UBS_META,
	...GENERIC_AGENT_LAZINESS_META,
	...GENERIC_TEST_HYGIENE_META,
	...GENERIC_CROSS_FILE_META,
	...GENERIC_DEMO_DATA_META,
	...GENERIC_ENDPOINT_META,
	...GENERIC_SWIFT_META,
	...GENERIC_TYPE_DISCIPLINE_META,
};
