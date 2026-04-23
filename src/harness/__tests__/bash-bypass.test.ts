// Tests for detectBashCodeFileWrite — the shell-redirect bypass detector.
// Ensures agents can't route around the content-quality gate by using Bash.

import { describe, expect, it } from "vitest";
import { detectBashCodeFileWrite } from "../pre-checks.js";

describe("detectBashCodeFileWrite", () => {
	describe("detects redirection to code files", () => {
		it("heredoc: cat > file.ts << EOF", () => {
			const cmd = "cat > src/foo.ts << 'EOF'\nconst x = 1;\nEOF";
			const hit = detectBashCodeFileWrite(cmd);
			expect(hit).not.toBeNull();
			expect(hit?.target).toBe("src/foo.ts");
		});

		it("echo > file.ts", () => {
			const hit = detectBashCodeFileWrite('echo "const x = 1;" > src/app.tsx');
			expect(hit?.target).toBe("src/app.tsx");
		});

		it("appending: echo >> file.js", () => {
			const hit = detectBashCodeFileWrite("echo 'const y = 2;' >> lib/util.js");
			expect(hit?.target).toBe("lib/util.js");
		});

		it("printf > file.py", () => {
			const hit = detectBashCodeFileWrite("printf 'print(1)' > foo.py");
			expect(hit?.target).toBe("foo.py");
		});

		it("quoted target: cat > 'src/has spaces.ts'", () => {
			const hit = detectBashCodeFileWrite("cat > 'src/my file.ts' << EOF\nx\nEOF");
			expect(hit?.target).toBe("src/my file.ts");
		});
	});

	describe("detects tee", () => {
		it("tee file.ts", () => {
			const hit = detectBashCodeFileWrite("echo 'x' | tee src/foo.ts");
			expect(hit?.target).toBe("src/foo.ts");
		});

		it("tee -a file.ts", () => {
			const hit = detectBashCodeFileWrite("echo 'x' | tee -a src/foo.ts");
			expect(hit?.target).toBe("src/foo.ts");
		});
	});

	describe("detects sed -i (in-place edit)", () => {
		it("sed -i on ts file", () => {
			const hit = detectBashCodeFileWrite("sed -i 's/foo/bar/' src/app.ts");
			expect(hit?.target).toBe("src/app.ts");
		});
	});

	describe("detects inline interpreter writes", () => {
		it("node -e fs.writeFileSync to .ts", () => {
			const hit = detectBashCodeFileWrite(
				`node -e "require('fs').writeFileSync('src/app.ts', 'const x = 1;')"`,
			);
			expect(hit?.target).toBe("src/app.ts");
		});

		it("python -c open+write to .py", () => {
			const hit = detectBashCodeFileWrite(
				`python3 -c "open('foo.py','w').write('print(1)')"`,
			);
			expect(hit?.target).toBe("foo.py");
		});
	});

	describe("detects cp / mv into tracked files", () => {
		it("cp /tmp/x.ts src/foo.ts", () => {
			const hit = detectBashCodeFileWrite("cp /tmp/x.ts src/foo.ts");
			expect(hit?.target).toBe("src/foo.ts");
		});

		it("mv /tmp/y.js lib/util.js", () => {
			const hit = detectBashCodeFileWrite("mv /tmp/y.js lib/util.js");
			expect(hit?.target).toBe("lib/util.js");
		});
	});

	describe("allows legitimate shell operations", () => {
		it("doesn't flag redirects to non-code files", () => {
			expect(detectBashCodeFileWrite("echo 'log entry' > /tmp/log.txt")).toBeNull();
			expect(detectBashCodeFileWrite("echo 'data' > output.csv")).toBeNull();
			expect(detectBashCodeFileWrite("cat > config.json << EOF\n{}\nEOF")).toBeNull();
		});

		it("doesn't flag stderr/stdout fd redirection", () => {
			expect(detectBashCodeFileWrite("npm test 2>&1")).toBeNull();
			expect(detectBashCodeFileWrite("npm test &> log.txt")).toBeNull();
		});

		it("doesn't flag reads from code files", () => {
			expect(detectBashCodeFileWrite("cat src/app.ts")).toBeNull();
			expect(detectBashCodeFileWrite("grep 'foo' src/*.ts")).toBeNull();
		});

		it("doesn't flag builds/tests that output to dist/", () => {
			expect(detectBashCodeFileWrite("tsc --outDir dist")).toBeNull();
			expect(detectBashCodeFileWrite("npm run build")).toBeNull();
		});

		it("doesn't flag sed WITHOUT -i (reads, prints to stdout)", () => {
			expect(detectBashCodeFileWrite("sed 's/foo/bar/' src/app.ts")).toBeNull();
		});

		it("returns null on empty command", () => {
			expect(detectBashCodeFileWrite("")).toBeNull();
		});
	});

	// Regression: `interlinked write` self-gates via its own content-quality
	// pipeline, so the bash redirect detector must let it through rather than
	// double-gating. See the design doc:
	// `docs/design/bash-writes-through-content-gates.md`.
	describe("allows `interlinked write` through", () => {
		it("single-file with --stdin", () => {
			expect(
				detectBashCodeFileWrite("cat newcontent.ts | interlinked write src/foo.ts --stdin"),
			).toBeNull();
		});

		it("single-file with --from-file", () => {
			expect(
				detectBashCodeFileWrite("interlinked write src/app.ts --from-file /tmp/new.ts"),
			).toBeNull();
		});

		it("batch mode", () => {
			expect(
				detectBashCodeFileWrite("interlinked write --batch /tmp/manifest.json"),
			).toBeNull();
		});

		it("still blocks naive node -e fs.writeFileSync on the same line (no allowlist)", () => {
			// A command that has `interlinked write` as a SUBSTRING inside an
			// unrelated inline write should NOT be allowed. The allowlist only
			// kicks in when the command actually starts or contains a real
			// `interlinked write` invocation. Here we make sure `node -e ...`
			// still fires by using a node one-liner with no `interlinked write`
			// present.
			const hit = detectBashCodeFileWrite(
				`node -e "require('fs').writeFileSync('src/app.ts', 'x')"`,
			);
			expect(hit).not.toBeNull();
		});
	});
});
