// Corpus test for the shared destructive-command guard. This is the faithful-
// transcription net: `checkDestructiveCommand` was extracted from the inline
// regexes that used to live only in the .mjs template string, un-doubling one
// level of escaping in the move. A mis-escaped regex fails its case here.
//
// Also pins the `.toString()` codegen invariant: `DESTRUCTIVE_COMMAND_GUARD_SOURCE`
// must reconstruct, via `new Function`, into a working self-contained function —
// that is exactly how `guards-inline.ts` embeds it into the zero-import .mjs.

import { describe, expect, it } from "vitest";
import {
	checkDestructiveCommand,
	DESTRUCTIVE_COMMAND_GUARD_SOURCE,
} from "../destructive-command-guard.js";

describe("checkDestructiveCommand — blocks destructive commands", () => {
	// [command, substring the block reason must contain]. One+ per rule family.
	const blocked: Array<[string, string]> = [
		// shutdown / reboot (direct, piped, wrapped, quoted-shell)
		["shutdown -h now", "shutdown/reboot"],
		["sudo reboot", "shutdown/reboot"],
		["printf x | sudo reboot", "shutdown/reboot"],
		["env FOO=1 reboot", "shutdown/reboot"],
		['bash -c "reboot"', "shutdown/reboot"],
		// sleep
		["sleep 30", "wait_for_work"],
		// process killing
		["pkill -f node", "process-killing"],
		["killall node", "process-killing"],
		["skill -9 node", "process-killing"], // command-position skill (procps)
		["true; skill -KILL -u root", "process-killing"],
		["kill -9 1234", "termination signals"],
		["kill 100 200", "multiple PIDs"],
		["kill $(pgrep node)", "command substitution"],
		// `| xargs kill` is caught by the substitution/xargs rule, which sits
		// before the pgrep-specific rule — so the reason is that one.
		["pgrep node | xargs kill", "command substitution"],
		// filesystem destruction
		["rm -rf build", "Recursive force-delete"],
		["rm -r /usr", "root-level or wildcard"],
		["rm -r .wrangler", ".wrangler"],
		["rm -r node_modules", "node_modules"],
		["dd if=/dev/zero of=/dev/sda", "block devices"],
		// NOTE: the rule matches `mkfs ` (space), not `mkfs.ext4` — a real
		// pre-existing FN, kept as-is here since this change is a faithful
		// de-dup, not a rule edit.
		["mkfs /dev/sda1", "formatting/partitioning"],
		["chmod -R 777 /etc", "chmod 777"],
		["sudo rm /etc/hosts", "sudo rm"],
		// git destruction
		["git push --force origin main", "git push --force"],
		["git reset --hard HEAD~1", "git reset --hard"],
		["git clean -fd", "git clean -f"],
		["git checkout -- .", "git checkout"],
		["git restore --worktree src/foo.ts", "git restore --worktree"],
		["git branch -D feature", "git branch -D"],
		["git stash drop", "git stash"],
		["git restore .", "git restore ."],
		["git filter-branch --tree-filter x HEAD", "filter-branch"],
		["git rebase -i HEAD~3", "git rebase -i"],
		["git add -p", "git add -i"],
		// database destruction
		["psql -c 'DROP TABLE users'", "DROP/TRUNCATE"],
		["mysql -e 'DELETE FROM users;'", "without WHERE"],
		["mongo --eval 'db.dropDatabase()'", "MongoDB drop"],
		["redis-cli FLUSHALL", "FLUSHALL"],
		// container / orchestration
		["docker system prune", "docker prune"],
		["docker-compose down -v", "down -v"],
		["kubectl delete namespace prod", "kubectl mass deletion"],
		["kubectl drain node-1", "kubectl drain"],
		// infrastructure-as-code
		["terraform destroy", "terraform destroy"],
		["terraform apply -auto-approve", "auto-approve"],
		["pulumi destroy", "pulumi destroy"],
		// cloud provider
		["aws ec2 terminate-instances --instance-ids i-1", "AWS destructive"],
		["aws s3 rm s3://bucket --recursive", "Recursive S3"],
		["rsync -a --delete src/ dst/", "rsync --delete"],
		// system-level
		["lvremove /dev/vg/lv", "LVM removal"],
		// embedded destructive scripts
		['python -c "import shutil; shutil.rmtree(\'/\')"', "destructive file operations"],
	];

	for (const [command, reasonFragment] of blocked) {
		it(`blocks: ${command}`, () => {
			const verdict = checkDestructiveCommand(command);
			expect(verdict?.decision, command).toBe("block");
			expect(verdict?.reason, command).toContain(reasonFragment);
		});
	}
});

describe("checkDestructiveCommand — allows legitimate commands", () => {
	const allowed = [
		"ls -la",
		"git status",
		'git commit -m "fix the bug"',
		"npm test",
		"git push origin main",
		"git push --force-with-lease origin main",
		"rm file.txt",
		"rm -r src/old",
		"kill 1234",
		"git rebase main",
		"git add src/foo.ts",
		"git clean -n",
		// data-only references: a destructive string examined by grep/echo/cat
		// is not an executable destructive command.
		"echo 'DROP TABLE users'",
		"grep -rn 'rm -rf' src",
		"cat ./shutdown.log",
		"docker compose up -d",
		// the English word "skill" mid-command is prose, not procps skill —
		// this exact shape (a commit message mentioning a skill) was blocked
		// live on 2026-07-18.
		'git commit -m "docs: the enforce skill copy under .agents/"',
		"git add .agents/skills/enforce/SKILL.md",
		"npm run upskill",
	];

	for (const command of allowed) {
		it(`allows: ${command}`, () => {
			expect(checkDestructiveCommand(command), command).toBeNull();
		});
	}
});

describe("DESTRUCTIVE_COMMAND_GUARD_SOURCE — embeddable into the .mjs", () => {
	// `guards-inline.ts` splices the source as `const checkDestructiveCommand =
	// <SOURCE>;`. Reconstruct it the same way and confirm it parses, runs, and
	// has no external references — `Function.toString()` serializes only the
	// function's own body, so any module-scope reference would be undefined.
	function rebuildFromSource(): (cmd: string) => { decision: string; reason: string } | null {
		return new Function(
			`"use strict"; const checkDestructiveCommand = ${DESTRUCTIVE_COMMAND_GUARD_SOURCE}; return checkDestructiveCommand;`,
		)() as (cmd: string) => { decision: string; reason: string } | null;
	}

	it("reconstructs into a working self-contained function", () => {
		const rebuilt = rebuildFromSource();
		expect(rebuilt("rm -rf /")?.decision).toBe("block");
		expect(rebuilt("ls -la")).toBeNull();
	});

	it("the embedded copy agrees with the imported function", () => {
		const rebuilt = rebuildFromSource();
		const corpus = [
			"git push --force origin x",
			"sudo reboot",
			"kubectl drain node-1",
			"ls -la",
			"npm run build",
			"echo 'rm -rf /'",
		];
		for (const cmd of corpus) {
			expect(rebuilt(cmd), cmd).toEqual(checkDestructiveCommand(cmd));
		}
	});

	it("contains no backtick or `${` so it splices into any string context", () => {
		// The .mjs template is a backtick template literal. Keeping the source
		// free of backticks and `${` (maskInlineQuotedShell uses
		// String.fromCharCode(96), not a literal backtick) keeps the embedding
		// robust regardless of how guards-inline.ts assembles the chunk.
		expect(DESTRUCTIVE_COMMAND_GUARD_SOURCE).not.toContain("`");
		expect(DESTRUCTIVE_COMMAND_GUARD_SOURCE).not.toContain("${");
	});
});
