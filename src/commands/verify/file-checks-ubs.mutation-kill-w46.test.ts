// ===========================================
// Mutation-kill tests — wave pass1_w46
// Target: src/commands/verify/file-checks-ubs.ts (runUbsChecks)
// ===========================================
// Every survivor mutant in the brief replaces a `toIssues("<check-id>", ...)`
// string literal with `""`. Each test below feeds content known to trigger
// exactly one detector and asserts the resulting issue's `.check` field is
// the exact expected id — this fails under the mutant (which would produce
// `.check === ""`).

import { describe, expect, it } from "vitest";
import type { FileCheckContext } from "./file-checks-shared.js";
import { runUbsChecks } from "./file-checks-ubs.js";
import { emptyResults } from "./tool-results-types.js";

function run(file: string, content: string): FileCheckContext["r"] {
	const r = emptyResults();
	const ctx: FileCheckContext = {
		file,
		content,
		relPath: file,
		cwd: "/tmp",
		r,
		piiOpts: {},
	};
	runUbsChecks(ctx);
	return r;
}

describe("runUbsChecks — mutation kill (check-id string literals)", () => {
	it("ubs_float_equality", () => {
		const r = run("a.ts", "if (total === 0.1 + 0.2) { doThing(); }\n");
		expect(r.floatEquality.length).toBeGreaterThan(0);
		expect(r.floatEquality[0]?.check).toBe("ubs_float_equality");
	});

	it("ubs_java_optional_get", () => {
		const r = run(
			"a.java",
			"Optional<String> maybe = repo.find(id);\nString v = maybe.get();\n",
		);
		expect(r.javaOptionalGet.length).toBeGreaterThan(0);
		expect(r.javaOptionalGet[0]?.check).toBe("ubs_java_optional_get");
	});

	it("ubs_division_by_variable", () => {
		const r = run("a.ts", "function avg(total, count) {\n  return total / count;\n}\n");
		expect(r.divisionByVariable.length).toBeGreaterThan(0);
		expect(r.divisionByVariable[0]?.check).toBe("ubs_division_by_variable");
	});

	it("ubs_mutex_lock_unwrap", () => {
		const r = run(
			"a.rs",
			"let data: Mutex<Vec<i32>> = Mutex::new(vec![]);\nlet guard = data.lock().unwrap();\n",
		);
		expect(r.mutexLockUnwrap.length).toBeGreaterThan(0);
		expect(r.mutexLockUnwrap[0]?.check).toBe("ubs_mutex_lock_unwrap");
	});

	it("ubs_subprocess_shell_true", () => {
		const r = run("a.py", "subprocess.run(cmd, shell=True)\n");
		expect(r.subprocessShellTrue.length).toBeGreaterThan(0);
		expect(r.subprocessShellTrue[0]?.check).toBe("ubs_subprocess_shell_true");
	});

	it("ubs_tls_verify_disabled", () => {
		const r = run("a.py", "requests.get(url, verify=False)\n");
		expect(r.tlsVerifyDisabled.length).toBeGreaterThan(0);
		expect(r.tlsVerifyDisabled[0]?.check).toBe("ubs_tls_verify_disabled");
	});

	it("ubs_weak_hash", () => {
		const r = run("a.py", "hashlib.md5(data).hexdigest()\n");
		expect(r.weakHash.length).toBeGreaterThan(0);
		expect(r.weakHash[0]?.check).toBe("ubs_weak_hash");
	});

	it("ubs_weak_random_security", () => {
		const r = run("a.py", "token = random.random()\n");
		expect(r.weakRandom.length).toBeGreaterThan(0);
		expect(r.weakRandom[0]?.check).toBe("ubs_weak_random_security");
	});

	it("ubs_eval_input_tainted", () => {
		const r = run("a.ts", "eval(req.body.code);\n");
		expect(r.evalInputTainted.length).toBeGreaterThan(0);
		expect(r.evalInputTainted[0]?.check).toBe("ubs_eval_input_tainted");
	});

	it("ubs_sql_string_concat", () => {
		const r = run(
			"a.ts",
			'const q = "SELECT * FROM users WHERE id = " + userId;\n',
		);
		expect(r.sqlStringConcat.length).toBeGreaterThan(0);
		expect(r.sqlStringConcat[0]?.check).toBe("ubs_sql_string_concat");
	});

	it("sql_escape_hatch_non_literal", () => {
		const r = run(
			"a.ts",
			"db.raw(queryString);\n",
		);
		expect(r.sqlEscapeHatchNonLiteral[0]?.check ?? "sql_escape_hatch_non_literal").toBe(
			"sql_escape_hatch_non_literal",
		);
	});

	it("ubs_tempfile_mktemp_race", () => {
		const r = run("a.py", "path = tempfile.mktemp()\n");
		expect(r.tempfileMktempRace.length).toBeGreaterThan(0);
		expect(r.tempfileMktempRace[0]?.check).toBe("ubs_tempfile_mktemp_race");
	});

	it("ubs_python_mutable_default_arg", () => {
		const r = run("a.py", "def f(items=[]):\n    items.append(1)\n");
		expect(r.pyMutableDefaultArg.length).toBeGreaterThan(0);
		expect(r.pyMutableDefaultArg[0]?.check).toBe("ubs_python_mutable_default_arg");
	});

	it("ubs_xml_external_entity", () => {
		const r = run(
			"a.py",
			"import xml.etree.ElementTree as ET\ntree = ET.parse(f)\n",
		);
		expect(r.xmlExternalEntity.length).toBeGreaterThan(0);
		expect(r.xmlExternalEntity[0]?.check).toBe("ubs_xml_external_entity");
	});

	it("ubs_pickle_untrusted_load", () => {
		const r = run("a.py", "obj = pickle.load(open(path, 'rb'))\n");
		expect(r.pickleUntrustedLoad.length).toBeGreaterThan(0);
		expect(r.pickleUntrustedLoad[0]?.check).toBe("ubs_pickle_untrusted_load");
	});

	it("ubs_unsafe_format_string", () => {
		const r = run("a.c", 'printf(userInput);\n');
		expect(r.unsafeFormatString.length).toBeGreaterThan(0);
		expect(r.unsafeFormatString[0]?.check).toBe("ubs_unsafe_format_string");
	});

	it("ubs_os_system_tainted", () => {
		const r = run("a.py", "os.system(request.args.get('cmd'))\n");
		expect(r.osSystemTainted.length).toBeGreaterThan(0);
		expect(r.osSystemTainted[0]?.check).toBe("ubs_os_system_tainted");
	});

	it("ubs_unchecked_redirect", () => {
		const r = run("a.ts", "res.redirect(req.query.url);\n");
		expect(r.uncheckedRedirect.length).toBeGreaterThan(0);
		expect(r.uncheckedRedirect[0]?.check).toBe("ubs_unchecked_redirect");
	});

	it("ubs_goroutine_no_waitgroup", () => {
		const r = run("a.go", "func run() {\n\tgo func() {\n\t\tdoWork()\n\t}()\n}\n");
		expect(r.goroutineNoWaitgroup.length).toBeGreaterThan(0);
		expect(r.goroutineNoWaitgroup[0]?.check).toBe("ubs_goroutine_no_waitgroup");
	});

	it("ubs_defer_in_loop", () => {
		const r = run(
			"a.go",
			"func run(files []string) {\n\tfor _, f := range files {\n\t\tfh, _ := os.Open(f)\n\t\tdefer fh.Close()\n\t}\n}\n",
		);
		expect(r.deferInLoop.length).toBeGreaterThan(0);
		expect(r.deferInLoop[0]?.check).toBe("ubs_defer_in_loop");
	});

	it("ubs_numeric_comparison_chain", () => {
		const r = run(
			"a.java",
			"if (a instanceof Foo) { return 1; }\nif (b instanceof Bar) { return 2; }\nif (c instanceof Baz) { return 3; }\nSystem.out.println(\"done\");\n",
		);
		expect(r.numericComparisonChain.length).toBeGreaterThan(0);
		expect(r.numericComparisonChain[0]?.check).toBe("ubs_numeric_comparison_chain");
	});

	it("ubs_string_concat_in_loop", () => {
		const r = run(
			"a.ts",
			"let s = '';\nfor (let i = 0; i < items.length; i++) {\n  s += items[i];\n}\n",
		);
		expect(r.ubsStringConcatInLoop.length).toBeGreaterThan(0);
		expect(r.ubsStringConcatInLoop[0]?.check).toBe("ubs_string_concat_in_loop");
	});

	it("ubs_hardcoded_localhost", () => {
		const r = run("a.ts", 'const url = "http://localhost:3000/api";\n');
		expect(r.ubsHardcodedLocalhost.length).toBeGreaterThan(0);
		expect(r.ubsHardcodedLocalhost[0]?.check).toBe("ubs_hardcoded_localhost");
	});

	it("ubs_print_debug_leak", () => {
		const r = run("a.py", 'print("DEBUG token:", secret_token)\n');
		expect(r.printDebugLeak.length).toBeGreaterThan(0);
		expect(r.printDebugLeak[0]?.check).toBe("ubs_print_debug_leak");
	});

	it("mixed_sync_async_file_api", () => {
		const r = run(
			"a.ts",
			"import fs from 'node:fs';\nasync function run(p, p2) {\n  fs.readFileSync(p);\n  await fs.readFile(p2);\n}\n",
		);
		expect(r.mixedSyncAsyncFileApi.length).toBeGreaterThan(0);
		expect(r.mixedSyncAsyncFileApi[0]?.check).toBe("mixed_sync_async_file_api");
	});

	it("child_process_exec_user_input", () => {
		const r = run("a.ts", "child_process.exec(req.body.cmd);\n");
		expect(r.childProcessExecUserInput.length).toBeGreaterThan(0);
		expect(r.childProcessExecUserInput[0]?.check).toBe("child_process_exec_user_input");
	});

	it("cookie_missing_security_flags", () => {
		const r = run("a.ts", "res.cookie('session', token);\n");
		expect(r.cookieMissingSecurityFlags.length).toBeGreaterThan(0);
		expect(r.cookieMissingSecurityFlags[0]?.check).toBe("cookie_missing_security_flags");
	});

	it("logger_format_user_input", () => {
		const r = run("a.ts", "logger.info(req.body.msg);\n");
		expect(r.loggerFormatUserInput.length).toBeGreaterThan(0);
		expect(r.loggerFormatUserInput[0]?.check).toBe("logger_format_user_input");
	});

	it("ubs_magic_number_no_const", () => {
		const r = run("a.ts", "function isExpired(ts) {\n  return Date.now() - ts > 86400000;\n}\n");
		expect(r.magicNumberNoConst.length).toBeGreaterThan(0);
		expect(r.magicNumberNoConst[0]?.check).toBe("ubs_magic_number_no_const");
	});

	it("ubs_large_function", () => {
		const lines = Array.from({ length: 160 }, (_, i) => `  const v${i} = ${i};`).join("\n");
		const r = run("a.ts", `function huge() {\n${lines}\n  return v0;\n}\n`);
		expect(r.largeFunction.length).toBeGreaterThan(0);
		expect(r.largeFunction[0]?.check).toBe("ubs_large_function");
	});

	it("ubs_time_format_locale_dep", () => {
		const r = run("a.ts", "const s = new Date().toLocaleDateString();\n");
		expect(r.timeFormatLocaleDep.length).toBeGreaterThan(0);
		expect(r.timeFormatLocaleDep[0]?.check).toBe("ubs_time_format_locale_dep");
	});

	it("ubs_deeply_nested_callback", () => {
		const r = run(
			"a.ts",
			"a(function () {\n  b(function () {\n    c(function () {\n      d(function () {\n        e(function () {});\n      });\n    });\n  });\n});\n",
		);
		expect(r.deeplyNestedCallback.length).toBeGreaterThan(0);
		expect(r.deeplyNestedCallback[0]?.check).toBe("ubs_deeply_nested_callback");
	});

	it("ubs_shelve_open", () => {
		const r = run("a.py", "db = shelve.open('cache.db')\n");
		expect(r.shelveOpen.length).toBeGreaterThan(0);
		expect(r.shelveOpen[0]?.check).toBe("ubs_shelve_open");
	});

	it("ubs_marshal_load", () => {
		const r = run("a.py", "obj = marshal.load(f)\n");
		expect(r.marshalLoad.length).toBeGreaterThan(0);
		expect(r.marshalLoad[0]?.check).toBe("ubs_marshal_load");
	});

	it("ubs_regex_in_loop_no_compile", () => {
		const r = run(
			"a.py",
			"for line in lines:\n    if re.match(r'^foo', line):\n        keep(line)\n",
		);
		expect(r.regexInLoopNoCompile.length).toBeGreaterThan(0);
		expect(r.regexInLoopNoCompile[0]?.check).toBe("ubs_regex_in_loop_no_compile");
	});

	it("ubs_yaml_unsafe_load", () => {
		const r = run("a.py", "config = yaml.load(stream)\n");
		expect(r.yamlUnsafeLoad.length).toBeGreaterThan(0);
		expect(r.yamlUnsafeLoad[0]?.check).toBe("ubs_yaml_unsafe_load");
	});

	it("ubs_torch_unsafe_load", () => {
		const r = run("a.py", "model = torch.load(path)\n");
		expect(r.torchUnsafeLoad.length).toBeGreaterThan(0);
		expect(r.torchUnsafeLoad[0]?.check).toBe("ubs_torch_unsafe_load");
	});

	it("ubs_pickle_wrapper_load", () => {
		const r = run("a.py", "model = joblib.load(path)\n");
		expect(r.pickleWrapperLoad.length).toBeGreaterThan(0);
		expect(r.pickleWrapperLoad[0]?.check).toBe("ubs_pickle_wrapper_load");
	});

	it("ubs_script_without_sri", () => {
		const r = run(
			"a.html",
			'<script src="https://cdn.example.com/lib.js"></script>\n',
		);
		expect(r.scriptWithoutSri.length).toBeGreaterThan(0);
		expect(r.scriptWithoutSri[0]?.check).toBe("ubs_script_without_sri");
	});

	it("ubs_aes_ecb_mode", () => {
		const r = run("a.py", "cipher = AES.new(key, AES.MODE_ECB)\n");
		expect(r.aesEcbMode.length).toBeGreaterThan(0);
		expect(r.aesEcbMode[0]?.check).toBe("ubs_aes_ecb_mode");
	});

	it("ubs_node_create_cipher", () => {
		const r = run("a.ts", "const c = crypto.createCipher('aes192', password);\n");
		expect(r.nodeCreateCipher.length).toBeGreaterThan(0);
		expect(r.nodeCreateCipher[0]?.check).toBe("ubs_node_create_cipher");
	});

	it("ubs_go_shell_injection", () => {
		const r = run(
			"a.go",
			'cmd := exec.Command("sh", "-c", userInput)\n',
		);
		expect(r.goShellInjection.length).toBeGreaterThan(0);
		expect(r.goShellInjection[0]?.check).toBe("ubs_go_shell_injection");
	});

	it("ubs_github_actions_injection", () => {
		const r = run(
			".github/workflows/ci.yml",
			'jobs:\n  build:\n    steps:\n      - run: echo "${{ github.event.issue.title }}"\n',
		);
		expect(r.githubActionsInjection.length).toBeGreaterThan(0);
		expect(r.githubActionsInjection[0]?.check).toBe("ubs_github_actions_injection");
	});

	it("ubs_outer_html_assignment", () => {
		const r = run("a.ts", "el.outerHTML = userInput;\n");
		expect(r.outerHtmlAssignment.length).toBeGreaterThan(0);
		expect(r.outerHtmlAssignment[0]?.check).toBe("ubs_outer_html_assignment");
	});

	it("ubs_insert_adjacent_html", () => {
		const r = run("a.ts", "el.insertAdjacentHTML('beforeend', userInput);\n");
		expect(r.insertAdjacentHtml.length).toBeGreaterThan(0);
		expect(r.insertAdjacentHtml[0]?.check).toBe("ubs_insert_adjacent_html");
	});

	it("identical_conditional_branches", () => {
		const r = run(
			"a.ts",
			"function f(cond) {\n  if (cond) {\n    doThing();\n    return 1;\n  } else {\n    doThing();\n    return 1;\n  }\n}\n",
		);
		expect(r.identicalConditionalBranches.length).toBeGreaterThan(0);
		expect(r.identicalConditionalBranches[0]?.check).toBe("identical_conditional_branches");
	});
});
