import { describe, expect, it } from "vitest";
import { checkRustUnsafeSpan } from "./unsafe-span.js";

const RS = "src/ffi/bridge.rs";
const code = (n: number): string[] => Array.from({ length: n }, (_, i) => `    op_${i}();`);
const rust = (lines: string[]) => checkRustUnsafeSpan(lines.join("\n"), RS);

describe("unsafe-span equiv-falsification kills", () => {
	// test-contract: boundary — cf61477ad9fb2ef9: blankRange must blank a char
	// literal to a SPACE, not "", so a following `unsafe{` keeps its word
	// boundary; blanking to "" would merge it into the preceding identifier.
	it("still detects unsafe{ when a char literal directly precedes it with no space", () => {
		const found = rust(["x'a'unsafe{", ...code(6), "}"]);
		expect(found).toHaveLength(1);
		expect(found[0]?.text).toContain("spans 6 nonblank lines");
	});

	// test-contract: boundary — eaf8fd7effd5ddaa: the char-literal closer must
	// compare against a real "'", not "" (which any out-of-bounds charAt
	// returns); otherwise an unterminated `'}` at EOF is misread as a closed
	// char literal and blanks the block's real closing brace.
	it("still detects the block when it closes with an unterminated apostrophe-then-brace at EOF", () => {
		const found = rust(["unsafe {", ...code(6), "'}"]);
		expect(found).toHaveLength(1);
		expect(found[0]?.text).toContain("spans 6 nonblank lines");
	});
});
