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

		// `-T` (--no-target-directory) is a boolean flag, NOT a flag that
		// consumes the next argument. Regression test for the bypass where
		// `cp -T /tmp/x src/foo.ts` was misparsed as `cp -T <value> src/foo.ts`
		// and the destination got eaten, leaving only one positional and
		// silently allowing the write.
		it("cp -T /tmp/x.ts src/foo.ts (boolean -T must not consume the source)", () => {
			const hit = detectBashCodeFileWrite("cp -T /tmp/x.ts src/foo.ts");
			expect(hit?.target).toBe("src/foo.ts");
		});

		it("mv -T /tmp/y.js lib/util.js (boolean -T)", () => {
			const hit = detectBashCodeFileWrite("mv -T /tmp/y.js lib/util.js");
			expect(hit?.target).toBe("lib/util.js");
		});

		// `-t DIR` does take an arg — the destination is the LAST positional
		// only when there's no -t. Confirm the parser still flags when the
		// short-form `-t` is used.
		it("cp -t lib /tmp/a.js (lowercase -t takes an arg, lib is destination)", () => {
			const hit = detectBashCodeFileWrite("cp -t lib /tmp/a.js");
			// "lib" is consumed as the -t argument, "/tmp/a.js" is the source,
			// and there is no second positional — so the detector should return
			// null (no protected destination resolvable).
			expect(hit).toBe(null);
		});
	});

	describe("detects link / install / dd / rsync / scp into tracked files", () => {
		it("ln src dst (hard link)", () => {
			const hit = detectBashCodeFileWrite("ln /tmp/x.ts src/foo.ts");
			expect(hit?.target).toBe("src/foo.ts");
		});

		it("ln -s src dst (symlink)", () => {
			const hit = detectBashCodeFileWrite("ln -s /tmp/x.ts src/foo.ts");
			expect(hit?.target).toBe("src/foo.ts");
		});

		it("install src dst (install copies + sets mode)", () => {
			const hit = detectBashCodeFileWrite("install -m 644 /tmp/x.py src/foo.py");
			expect(hit?.target).toBe("src/foo.py");
		});

		it("dd if= of= (block-level copy)", () => {
			const hit = detectBashCodeFileWrite("dd if=/tmp/x.ts of=src/foo.ts");
			expect(hit?.target).toBe("src/foo.ts");
		});

		it("rsync src dst", () => {
			const hit = detectBashCodeFileWrite("rsync -a /tmp/y.js lib/util.js");
			expect(hit?.target).toBe("lib/util.js");
		});

		it("scp local local (local-to-local form)", () => {
			const hit = detectBashCodeFileWrite("scp /tmp/x.ts src/foo.ts");
			expect(hit?.target).toBe("src/foo.ts");
		});
	});

	describe("detects writes to `.graph.*` Supermodel shards (any verb)", () => {
		it("cp into a .graph.ts shard", () => {
			const hit = detectBashCodeFileWrite("cp /tmp/x.txt src/harness/foo.graph.ts");
			expect(hit?.target).toBe("src/harness/foo.graph.ts");
		});

		it("mv into a .graph.go shard", () => {
			const hit = detectBashCodeFileWrite("mv /tmp/x.txt internal/foo.graph.go");
			expect(hit?.target).toBe("internal/foo.graph.go");
		});

		it("ln into a .graph.js shard", () => {
			const hit = detectBashCodeFileWrite("ln /tmp/x src/foo.graph.js");
			expect(hit?.target).toBe("src/foo.graph.js");
		});

		it("rsync into a .graph.py shard", () => {
			const hit = detectBashCodeFileWrite("rsync -a /tmp/x src/foo.graph.py");
			expect(hit?.target).toBe("src/foo.graph.py");
		});

		it("dd if= of= a .graph.ts shard", () => {
			const hit = detectBashCodeFileWrite("dd if=/tmp/x of=src/foo.graph.ts");
			expect(hit?.target).toBe("src/foo.graph.ts");
		});

		it("compound: cp ... && touch — still catches the cp", () => {
			const hit = detectBashCodeFileWrite(
				"cp /tmp/x.txt src/harness/break-glass.graph.ts && touch -r src/harness/break-glass.ts src/harness/break-glass.graph.ts",
			);
			expect(hit?.target).toBe("src/harness/break-glass.graph.ts");
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

		it("doesn't mistake sed -n reads across multiple commands for sed -i", () => {
			expect(
				detectBashCodeFileWrite(
					"sed -n '200,250p' src/lib/__tests__/hook-installers.test.ts && sed -n '35,75p' src/lib/codex-feature-flag.test.ts",
				),
			).toBeNull();
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

	describe("root confinement (2026-07-06 dogfood FP: scratchpad probe blocked as 'tracked')", () => {
		const ROOT = "/Users/dev/project";

		it("allows a redirect to an out-of-repo scratchpad path when a root is provided", () => {
			const hit = detectBashCodeFileWrite(
				"printf 'x' > /private/tmp/claude-501/session/scratchpad/probe.mts",
				ROOT,
			);
			expect(hit).toBeNull();
		});

		it("allows tee / cp / dd landing outside the project root", () => {
			expect(detectBashCodeFileWrite("make | tee /tmp/build-log.ts", ROOT)).toBeNull();
			expect(detectBashCodeFileWrite("cp src/a.ts /tmp/elsewhere/a.ts", ROOT)).toBeNull();
			expect(detectBashCodeFileWrite("dd if=src/a.ts of=/tmp/out.ts", ROOT)).toBeNull();
		});

		it("treats ~ as the home directory, not a repo-relative path", () => {
			expect(detectBashCodeFileWrite("echo hi > ~/notes/snippet.ts", ROOT)).toBeNull();
		});

		it("still blocks in-repo targets — relative and absolute forms", () => {
			expect(detectBashCodeFileWrite("echo bad > src/foo.ts", ROOT)?.target).toBe("src/foo.ts");
			expect(detectBashCodeFileWrite(`echo bad > ${ROOT}/src/foo.ts`, ROOT)?.target).toBe(
				`${ROOT}/src/foo.ts`,
			);
		});

		it("still blocks the second segment when the first writes out-of-repo", () => {
			const hit = detectBashCodeFileWrite(
				"echo a > /tmp/scratch.ts && echo b > src/real.ts",
				ROOT,
			);
			expect(hit?.target).toBe("src/real.ts");
		});

		it("preserves the historical conservative reach when no root is available", () => {
			expect(detectBashCodeFileWrite("echo x > /tmp/anywhere.ts")).not.toBeNull();
		});

		it("does not let a path-traversal target dodge the guard", () => {
			// Resolves back INSIDE the root → still blocked.
			expect(
				detectBashCodeFileWrite(`echo x > ${ROOT}/../project/src/foo.ts`, ROOT),
			).not.toBeNull();
		});
	});

	describe("variable + cd resolution (2026-07-09 dogfood FP: `> $SCRATCH/x.ts` blocked as tracked)", () => {
		const ROOT = "/Users/dev/project";
		const SCRATCHPAD = "/private/tmp/claude-501/-Users-dev-project/sess-1/scratchpad";

		it("expands a same-command assignment pointing OUT of the repo (the real block)", () => {
			const cmd = `SCRATCH=${SCRATCHPAD}\nmkdir -p $SCRATCH\ncat > $SCRATCH/schema-draft.ts <<'EOF'\nexport {};\nEOF`;
			expect(detectBashCodeFileWrite(cmd, ROOT)).toBeNull();
		});

		it("expands the ${VAR} braces form the same way", () => {
			const cmd = `SCRATCH="${SCRATCHPAD}" && echo x > \${SCRATCH}/probe.mts`;
			expect(detectBashCodeFileWrite(cmd, ROOT)).toBeNull();
		});

		it("still blocks when the variable expands INTO the repo", () => {
			const hit = detectBashCodeFileWrite("SRC=src && echo bad > $SRC/index.ts", ROOT);
			expect(hit?.target).toBe("$SRC/index.ts");
		});

		it("treats an unresolvable variable as not provably in-root (passes through)", () => {
			expect(detectBashCodeFileWrite("echo x > $UNKNOWN_DIR/probe.ts", ROOT)).toBeNull();
		});

		it("keeps the no-root conservative reach for variable targets", () => {
			expect(detectBashCodeFileWrite("echo x > $ANYWHERE/a.ts")).not.toBeNull();
		});

		it("expands $HOME from the process environment", () => {
			// Out of the repo whether HOME resolves (real home) or not (unresolvable).
			expect(detectBashCodeFileWrite("echo hi > $HOME/notes/snippet.ts", ROOT)).toBeNull();
		});

		it("resolves relative targets against a same-command cd OUT of the repo", () => {
			const cmd = `cd ${SCRATCHPAD} && echo x > probe.ts`;
			expect(detectBashCodeFileWrite(cmd, ROOT)).toBeNull();
		});

		it("follows cd $VAR into an out-of-repo dir", () => {
			const cmd = `SCRATCH=${SCRATCHPAD}\ncd $SCRATCH\necho x > probe.ts`;
			expect(detectBashCodeFileWrite(cmd, ROOT)).toBeNull();
		});

		it("still blocks a relative write after cd to an in-repo subdirectory", () => {
			const hit = detectBashCodeFileWrite("cd src && echo bad > util.ts", ROOT);
			expect(hit?.target).toBe("util.ts");
		});
	});
});
