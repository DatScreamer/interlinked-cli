// interlinked-tdd: exempt
// Second half of UBS_ENTRIES (crypto / unpickle-wrapper / external-script-SRI /
// Go shell-injection / GitHub-Actions injection / DOM-XSS pre_warn detectors).
// Split out of ubs-checks.ts to stay under the per-file line cap; spread back into
// UBS_ENTRIES there. Moving code, no logic change.

import {
	checkAesEcbMode,
	checkArchiveExtractTraversal,
	checkCAssertSideEffects,
	checkDocumentWrite,
	checkGithubActionsInjection,
	checkGoShellInjection,
	checkInsertAdjacentHtml,
	checkJavaAssertSideEffects,
	checkNaiveDatetime,
	checkNodeCreateCipher,
	checkOuterHtmlAssignment,
	checkPickleWrapperLoad,
	checkPythonAssertSideEffects,
	checkRedosCatastrophic,
	checkRustTestDeterminism,
	checkRustUncheckedCastSlice,
	checkScriptWithoutSri,
	checkTorchUnsafeLoad,
	checkUnalignedReinterpret,
	checkWeakRandom,
} from "../../generic-checks.js";
import type { CheckRegistration } from "../types.js";

export const UBS_ENTRIES_EXTRA: CheckRegistration[] = [
	{
		// DW test-adoption P0.4 (2026-07-17): the RUST half of the determinism
		// ban-list (JS/TS `test_nondeterminism` already ships). post/warning —
		// heuristic span detection, so not a block.
		id: "rust_test_nondeterminism",
		phase: "post",
		name: "Rust test nondeterminism",
		description:
			"Detects `thread_rng()` / `Uuid::new_v4()` inside a Rust test span (a `tests/` file or a `#[cfg(test)]` module) — OS-entropy sources make tests flaky and non-replayable. Production randomness outside test spans is not flagged.",
		tier: 2,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Seed the RNG deterministically in tests: `StdRng::seed_from_u64(SEED)` instead of `thread_rng()`, and a fixed/derived id instead of `Uuid::new_v4()`. A seeded test fails reproducibly and replays.",
		fn: checkRustTestDeterminism,
		resultsPropName: "rustTestNondeterminism",
		content_keywords: ["thread_rng", "new_v4"],
	},
	{
		// DW class-breadth (2026-07-17): temporal-correctness class — a NEW class
		// beyond the security-focused UBS detectors. Heuristic (naive now() has
		// legit uses) → advisory. utcnow/utcfromtimestamp are naive AND deprecated.
		id: "ubs_naive_datetime",
		phase: "post",
		name: "Timezone-naive datetime",
		description:
			"Detects `datetime.utcnow()` / `datetime.utcfromtimestamp()` (naive AND deprecated since 3.12) and `datetime.now()` with no tz argument (naive local time) — the classic 'wrong in prod / wrong for other users' bug class. `datetime.now(tz)` is not flagged.",
		tier: 2,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Use timezone-aware datetimes: `datetime.now(timezone.utc)` instead of `datetime.utcnow()` / `datetime.now()`, and pass `tz=` to `fromtimestamp`. Store and compare in UTC; convert to local only for display.",
		fn: checkNaiveDatetime,
		resultsPropName: "naiveDatetime",
		content_keywords: ["utcnow", "utcfromtimestamp", "datetime.now"],
	},
	{
		// DW class-breadth (2026-07-17): algorithmic-complexity / DoS class. A
		// quantified group whose body is also quantified — (a+)+ — backtracks
		// exponentially. Body-extracted (not raw code) → no arithmetic FP.
		id: "redos_catastrophic",
		phase: "post",
		name: "Catastrophic regex backtracking (ReDoS)",
		description:
			"Detects a nested-quantifier regex — `(a+)+`, `(\\d*)*`, `([a-z]+)*` — in a JS regex literal / `new RegExp(...)` or a Python `re.<fn>(...)`. Adversarial input makes it match in exponential time (a DoS vector). Only the extracted regex body is tested, so arithmetic like `(x+1)*2` is not flagged.",
		tier: 2,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Remove the nested quantifier: rewrite `(a+)+` as `a+`, bound the inner repetition, or use a possessive quantifier / atomic group (or a linear-time engine like RE2). Validate against a pathological input in a test.",
		fn: checkRedosCatastrophic,
		resultsPropName: "redosCatastrophic",
		content_keywords: ["+)+", "*)*", "+)*", "*)+"],
	},
	{
		// DW test-adoption P0.5 class-breadth (2026-07-17): zip-slip / CVE-2007-4559.
		// pre_warn/error — the unguarded extractall/extract call is the smell (low FP);
		// warn not block, since extracting a TRUSTED archive is legitimate.
		id: "ubs_archive_extract_traversal",
		phase: "pre_warn",
		name: "Unsanitized archive extraction (zip-slip)",
		description:
			"Detects an archive extracted without member-path validation: Python `.extractall()` with no `filter=` (3.12+ sanitizer), Node `tar.x`/`tar.extract`, adm-zip `.extractAllTo()`. A crafted `../` entry writes outside the target dir (CVE-2007-4559).",
		tier: 1,
		determinism: "fully_deterministic",
		severity: "error",
		pipeline: "agent_safety",
		fix_instruction:
			"Validate every member path before writing. Python 3.12+: pass `filter='data'` (or `tarfile.data_filter`) to `extractall`. Otherwise resolve each entry against the target dir and reject any that escapes it (`os.path.realpath`/`path.resolve` + a `startsWith(targetDir)` check). Node: use `tar`'s `filter`/`onentry` guard or validate `entry.path` before extraction.",
		fn: checkArchiveExtractTraversal,
		resultsPropName: "archiveExtractTraversal",
		content_keywords: ["extractall", "extractAllTo", "tar.x", "tar.extract"],
	},
	{
		id: "ubs_aes_ecb_mode",
		phase: "pre_warn",
		name: "AES in ECB mode",
		description:
			"Detects AES used in ECB mode (Python `AES.MODE_ECB`, `cryptography` `modes.ECB`, Node `\"aes-N-ecb\"`, Go `cipher.NewECBEncrypter`). ECB leaks plaintext structure: identical blocks encrypt to identical ciphertext.",
		tier: 1,
		determinism: "fully_deterministic",
		severity: "error",
		pipeline: "agent_safety",
		fix_instruction:
			"Use AES-GCM (authenticated encryption — provides confidentiality AND integrity) or AES-CBC with a separately-derived HMAC. ECB is unsafe for any data larger than one block because identical plaintext blocks produce identical ciphertext, leaking the plaintext's structure to an attacker.",
		fn: checkAesEcbMode,
		resultsPropName: "aesEcbMode",
		content_keywords: ["ECB", "ecb"],
	},
	{
		// DW test-adoption P0.5 flagship (2026-07-17): the weak-RANDOM crypto class,
		// the gap alongside our weak-HASH + AES-ECB. PYTHON scope — the JS
		// `Math.random()` case is owned by the A3 content-quality write-guard, so
		// matching it here too would double-warn. security-context-gated (fires
		// only when a `random.<fn>()` call shares a line with a secret/token/nonce/
		// key term) to keep FP low. Promote toward pre_block later (the path
		// ubs_hardcoded_localhost took) once a calibration run confirms the FP floor.
		id: "ubs_weak_random_security",
		phase: "post",
		name: "Weak Random for Security",
		description:
			"Detects Python's `random.<fn>()` PRNG generating a security-bearing value — token / key / nonce / salt / password / OTP / IV. The Mersenne-Twister PRNG is predictable, so an attacker who observes a few outputs can predict the rest. (JS `Math.random()` is covered by the A3 content-quality write-guard.)",
		tier: 2,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Use a cryptographically-secure RNG for security values: `crypto.randomBytes` / `crypto.getRandomValues` (JS) or the `secrets` module (Python). `Math.random()` and `random.*` are seeded from predictable state and must not back tokens, keys, nonces, salts, passwords, OTPs, or IVs.",
		fn: checkWeakRandom,
		resultsPropName: "weakRandom",
		content_keywords: ["random"],
	},
	{
		id: "ubs_torch_unsafe_load",
		phase: "pre_warn",
		name: "PyTorch unsafe load",
		description:
			"Detects `torch.load(...)` without an explicit `weights_only=True` argument. Older torch defaults `weights_only=False`, which unpickles arbitrary Python objects — a documented supply-chain RCE vector against model checkpoints.",
		tier: 1,
		determinism: "fully_deterministic",
		severity: "error",
		pipeline: "agent_safety",
		fix_instruction:
			"Pass `weights_only=True` to `torch.load(...)`. This limits deserialization to plain tensor data and rejects pickled Python objects. If you genuinely need to load a non-tensor object from a checkpoint, you must trust the source — document that decision in a comment next to the call.",
		fn: checkTorchUnsafeLoad,
		resultsPropName: "torchUnsafeLoad",
		content_keywords: ["torch.load"],
	},
	{
		id: "ubs_pickle_wrapper_load",
		phase: "pre_warn",
		name: "Pickle wrapper load (joblib / pandas / numpy)",
		description:
			"Detects libraries that unpickle data without the word `pickle` in the call site: `joblib.load(...)`, `pandas.read_pickle(...)`, `numpy.load(..., allow_pickle=True)`. All execute attacker-controlled `__reduce__` code on untrusted input.",
		tier: 1,
		determinism: "fully_deterministic",
		severity: "error",
		pipeline: "agent_safety",
		fix_instruction:
			"Treat any input passed to these APIs as code, not data. If the file is trusted (your own pipeline writes it), document that trust boundary in a comment. If the file comes from outside your trust boundary, switch to a schema-validated format (JSON, msgspec, protobuf). For numpy specifically: drop `allow_pickle=True` — the safe `.npy` format works without it.",
		fn: checkPickleWrapperLoad,
		resultsPropName: "pickleWrapperLoad",
		content_keywords: ["joblib", "read_pickle", "allow_pickle"],
	},
	{
		id: "ubs_node_create_cipher",
		phase: "pre_warn",
		name: "Node deprecated createCipher (no IV)",
		description:
			"Detects Node `crypto.createCipher(...)` / `createDecipher(...)` — derives the key via an MD5-based KDF with no IV. Removed entirely in Node 22; pre-22 code using it has a predictable, attacker-recoverable key schedule.",
		tier: 1,
		determinism: "fully_deterministic",
		severity: "error",
		pipeline: "agent_safety",
		fix_instruction:
			"Replace with `crypto.createCipheriv(algorithm, key, iv)` / `createDecipheriv(...)`. Generate a fresh random IV per encryption with `crypto.randomBytes(16)` and store the IV alongside the ciphertext (the IV does not need to be secret, just unique).",
		fn: checkNodeCreateCipher,
		resultsPropName: "nodeCreateCipher",
		content_keywords: ["createCipher", "createDecipher"],
	},
	{
		id: "ubs_script_without_sri",
		phase: "pre_warn",
		name: "External script without Subresource Integrity",
		description:
			"Detects `<script src=\"https://...\">` referencing an external URL without an `integrity=\"sha...\"` attribute. If the CDN is compromised or substituted, the loaded code runs with full page privileges.",
		tier: 1,
		determinism: "fully_deterministic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Add `integrity=\"sha384-...\" crossorigin=\"anonymous\"` to the script tag. SRI ties the script content to a known hash, so a swapped file at the CDN fails to load instead of executing silently. Most CDNs (cdnjs, unpkg, jsDelivr) publish SRI hashes alongside their URLs.",
		fn: checkScriptWithoutSri,
		resultsPropName: "scriptWithoutSri",
		content_keywords: ["<script", "src="],
	},
	{
		id: "ubs_go_shell_injection",
		phase: "pre_warn",
		name: "Go exec.Command shell invocation",
		description:
			"Detects Go `exec.Command(\"sh\", \"-c\", ...)` / `exec.Command(\"bash\", ...)` (and the `/bin/sh` / `/bin/bash` forms). Routing the remaining arguments through a shell interpreter exposes command-injection on any user-input concatenated into the command string.",
		tier: 1,
		determinism: "fully_deterministic",
		severity: "error",
		pipeline: "agent_safety",
		fix_instruction:
			"Pass the program and its arguments directly: `exec.Command(\"ping\", \"-c\", \"1\", host)`. With no shell in the pipeline, shell metacharacters in arguments are not interpreted, so command injection is eliminated entirely. Validate user input separately (parse to int, normalize file path, ParseIP for hostnames) — type-checking is cheap.",
		fn: checkGoShellInjection,
		resultsPropName: "goShellInjection",
		content_keywords: ["exec.Command"],
	},
	{
		id: "ubs_github_actions_injection",
		phase: "pre_warn",
		name: "GitHub Actions workflow injection",
		description:
			"Detects interpolation of attacker-controllable GitHub-event fields (PR title, issue body, commit message, head ref, `client_payload.*`) directly into workflow expressions. Inside a `run:` block this is direct command injection at the workflow's privilege level.",
		tier: 1,
		determinism: "fully_deterministic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Use env-var indirection: declare `env: TITLE: ${{ github.event.pull_request.title }}` at the step, then reference `$TITLE` inside `run:`. The shell quotes the variable expansion, so attacker-controlled text becomes data, not code. The unsafe pattern is direct interpolation `run: echo \"${{ github.event.* }}\"` — that text is parsed by the shell.",
		fn: checkGithubActionsInjection,
		resultsPropName: "githubActionsInjection",
		content_keywords: ["github.event", "github.head_ref"],
	},
	{
		id: "ubs_document_write",
		phase: "pre_warn",
		name: "document.write XSS",
		description:
			"Detects `document.write(...)` / `document.writeln(...)`. Both are XSS sinks when any part of the written content is attacker-controlled, and both block rendering as a side effect.",
		tier: 1,
		determinism: "fully_deterministic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Build DOM nodes with `document.createElement`/`appendChild` for structured content, or set `textContent` for plain text. If you need to inject HTML and the source is trusted, use a sanitizer like DOMPurify and assign to `innerHTML` of a newly-created container — never `document.write`, which has no safe form.",
		fn: checkDocumentWrite,
		resultsPropName: "documentWrite",
		content_keywords: ["document.write"],
	},
	{
		id: "ubs_outer_html_assignment",
		phase: "pre_warn",
		name: "outerHTML assignment XSS",
		description:
			"Detects `<expr>.outerHTML = <value>`. Equivalent XSS sink to `.innerHTML =`, but replaces the element itself rather than its children.",
		tier: 1,
		determinism: "fully_deterministic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"For plain text replacement, build a text node with `document.createTextNode(value)` and call `element.replaceWith(textNode)`. For HTML replacement, sanitize first (DOMPurify) and only then assign — or build the replacement DOM tree explicitly with `createElement`.",
		fn: checkOuterHtmlAssignment,
		resultsPropName: "outerHtmlAssignment",
		content_keywords: ["outerHTML"],
	},
	{
		id: "ubs_insert_adjacent_html",
		phase: "pre_warn",
		name: "insertAdjacentHTML XSS",
		description:
			"Detects `.insertAdjacentHTML(position, htmlString)`. The second argument is parsed as HTML, so any attacker-controlled fragment in the string becomes a live DOM node with script-execution potential.",
		tier: 1,
		determinism: "fully_deterministic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"For plain text, use `insertAdjacentText(position, text)` — the text is inserted as a text node, not parsed. For HTML, sanitize the string with DOMPurify before insertion, or build the DOM tree explicitly with `createElement` + `insertAdjacentElement`.",
		fn: checkInsertAdjacentHtml,
		resultsPropName: "insertAdjacentHtml",
		content_keywords: ["insertAdjacentHTML"],
	},
	// ---- Bun-regression detector pack (2026-07-20): C/Python/Java assert-erasure
	// siblings of ubs_rust_debug_assert_side_effect + the reinterpret-alignment
	// pair (Bun #31188). All post/warning; 1–5 heuristic. ----
	{
		id: "ubs_c_assert_side_effect",
		phase: "post",
		name: "C assert side effect",
		description:
			"Detects C/C++ `assert(...)` arguments containing an assignment, increment/decrement, or mutating-looking call. Compiling with `-DNDEBUG` (the standard release configuration) erases the macro AND its argument, so the work silently disappears in release — the C sibling of the Bun `insert_stale`-inside-`debug_assert!` regression.",
		tier: 1,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Move the side effect out of `assert(...)`. Under `-DNDEBUG` the <assert.h> macro compiles to nothing — the argument is never evaluated — so a mutating call like `queue_push(...)` or an assignment inside it never runs in release builds. Compute the value on its own statement first, then assert on the already-computed result.",
		fn: checkCAssertSideEffects,
		resultsPropName: "cAssertSideEffect",
		content_keywords: ["assert"],
	},
	{
		id: "ubs_python_assert_side_effect",
		phase: "post",
		name: "Python assert side effect",
		description:
			"Detects Python `assert` operands containing a walrus binding (`:=`) or a mutating-looking call. Running with `python -O` / `-OO` strips assert statements entirely — the operand is never evaluated — so the work silently disappears in optimized mode; the Python sibling of the Bun debug_assert erasure class.",
		tier: 1,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Move the side effect out of the `assert`. Under `python -O` the interpreter strips assert statements (operand and message both), so a mutating call like `cache.insert_stale(key)` inside one never runs in optimized mode. Perform the mutation on its own line, then assert on the result.",
		fn: checkPythonAssertSideEffects,
		resultsPropName: "pythonAssertSideEffect",
		content_keywords: ["assert"],
	},
	{
		id: "ubs_java_assert_side_effect",
		phase: "post",
		name: "Java assert side effect",
		description:
			"Detects Java `assert` conditions (and `: message` operands) containing an assignment, increment/decrement, or mutating-looking call. JVM assertions are OFF by default — without `-ea` the condition never evaluates — so the work silently disappears on every standard run; the Java sibling of the Bun debug_assert erasure class.",
		tier: 1,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Move the side effect out of the `assert`. The JVM ships with assertions DISABLED; unless every launch passes `-ea`, the condition (and its `: message` operand) is never evaluated, so `assert list.add(x);` adds nothing in production. Perform the mutation on its own statement, then assert on the already-computed result.",
		fn: checkJavaAssertSideEffects,
		resultsPropName: "javaAssertSideEffect",
		content_keywords: ["assert"],
	},
	{
		id: "ubs_rust_unchecked_cast_slice",
		phase: "post",
		name: "Rust unchecked cast_slice",
		description:
			"Detects Rust byte-buffer reinterpretation to a wider element type (`bytemuck::cast_slice`, `from_raw_parts`, `transmute`) with no length/alignment proof nearby. `bytemuck::cast_slice` PANICS when `len % size_of::<T>() != 0` (or the pointer is misaligned) — the Bun #31188 `Blob.text()` UTF-16 odd-byte-count panic class.",
		tier: 1,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Prove the length (and alignment) before reinterpreting. Mask the byte slice to a multiple of the element size first — e.g. `&buf[..buf.len() & !1]` for u16 (the actual Bun #31188 fix) — or use `chunks_exact(size_of::<T>())` / `bytemuck::try_cast_slice` and handle the remainder explicitly instead of letting `cast_slice` panic on odd-length input.",
		fn: checkRustUncheckedCastSlice,
		resultsPropName: "rustUncheckedCastSlice",
		content_keywords: ["cast_slice", "from_raw_parts", "transmute"],
	},
	{
		id: "unaligned_reinterpret",
		phase: "post",
		name: "Unaligned buffer reinterpret",
		description:
			"Detects JS/TS typed-array views over an existing ArrayBuffer (`new Uint16Array(buf.buffer)`, DataView multi-byte reads) with no `byteLength % BYTES_PER_ELEMENT` / offset-alignment guard nearby. The constructor THROWS when the buffer length is not a multiple of the element size — the same odd-byte-count class as Bun #31188's `bytemuck::cast_slice` panic, in JS clothing.",
		tier: 1,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Guard the view construction: check `buf.byteLength % TheView.BYTES_PER_ELEMENT === 0` (and byteOffset alignment when slicing) before `new Uint16Array(buffer)`, or truncate to an even length first (`buffer.slice(0, byteLength & ~1)`). External input with an odd byte count otherwise throws a RangeError at runtime — the Bun #31188 class.",
		fn: checkUnalignedReinterpret,
		resultsPropName: "unalignedReinterpret",
		content_keywords: [
			"Uint16Array",
			"Uint32Array",
			"Int16Array",
			"Int32Array",
			"Float32Array",
			"Float64Array",
			"BigInt64Array",
			"BigUint64Array",
			"DataView",
		],
	},
];
