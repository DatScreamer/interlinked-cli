// ===========================================
// interlinked completions — Shell completion scripts
// ===========================================
// Emits bash / zsh / fish completion scripts for the current top-level
// command surface. The COMMANDS and SUBCOMMANDS tables below are the
// single source of truth; anytime a new command is wired in index.ts,
// mirror it here. Drift is visible in `interlinked verify` via the
// docs-freshness tests.

const COMMANDS = [
	"activity",
	"attach",
	"check",
	"checkpoint",
	"clean",
	"completions",
	"context",
	"coverage",
	"daemons",
	"disable",
	"doctor",
	"enable",
	"env",
	"explain",
	"git",
	"guard",
	"handoff",
	"harness",
	"inbox",
	"init",
	"install-hooks",
	"login",
	"logout",
	"logs",
	"mode",
	"multi-edit",
	"mutation",
	"reminder",
	"reset",
	"resume",
	"rewind",
	"search",
	"send",
	"setup",
	"status",
	"structure",
	"sync",
	"tasks",
	"telemetry",
	"trace",
	"uninstall-hooks",
	"update",
	"verify",
	"version",
	"watch",
	"workspace",
	"write",
];

// Subcommand tables — keep in sync with src/index.ts groups.
const SUBCOMMANDS: Record<string, string> = {
	checkpoint: "list show compare prune archive",
	completions: "bash zsh fish",
	coverage: "check baseline",
	git: "context link-checkpoint",
	guard: "install check status uninstall",
	harness: "start stop restart status test",
	mutation: "check baseline",
	reminder: "add list remove",
	structure: "init scan status accept doctor baseline",
	tasks: "list create show claim complete",
	trace: "export import",
	workspace: "list switch",
};

const GLOBAL_OPTIONS = ["--json", "--short", "--full", "--help"];

export async function completionsCommand(shell: string): Promise<void> {
	switch (shell.toLowerCase()) {
		case "bash":
			console.log(generateBashCompletions());
			break;
		case "zsh":
			console.log(generateZshCompletions());
			break;
		case "fish":
			console.log(generateFishCompletions());
			break;
		default:
			console.error(`Unknown shell: ${shell}. Supported: bash, zsh, fish`);
			process.exitCode = 1;
	}
}

function generateBashCompletions(): string {
	const caseBlocks = Object.entries(SUBCOMMANDS)
		.map(
			([cmd, subs]) => `        ${cmd})
            COMPREPLY=( $(compgen -W "${subs}" -- "\${cur}") )
            ;;`,
		)
		.join("\n");

	return `# interlinked bash completion
# Add to ~/.bashrc: eval "$(interlinked completions bash)"
_interlinked_completions() {
    local cur prev commands
    COMPREPLY=()
    cur="\${COMP_WORDS[COMP_CWORD]}"
    prev="\${COMP_WORDS[COMP_CWORD-1]}"
    commands="${COMMANDS.join(" ")}"

    if [[ \${COMP_CWORD} -eq 1 ]]; then
        COMPREPLY=( $(compgen -W "\${commands}" -- "\${cur}") )
        return 0
    fi

    case "\${prev}" in
${caseBlocks}
        *)
            COMPREPLY=( $(compgen -W "${GLOBAL_OPTIONS.join(" ")}" -- "\${cur}") )
            ;;
    esac
    return 0
}
complete -F _interlinked_completions interlinked
`;
}

function generateZshCompletions(): string {
	const caseBlocks = Object.entries(SUBCOMMANDS)
		.map(
			([cmd, subs]) => `                ${cmd})
                    _values 'subcommand' ${subs}
                    ;;`,
		)
		.join("\n");

	return `#compdef interlinked
# interlinked zsh completion
# Add to ~/.zshrc: eval "$(interlinked completions zsh)"

_interlinked() {
    local -a commands
    commands=(
${COMMANDS.map((c) => `        '${c}:${c} command'`).join("\n")}
    )

    _arguments -C \\
        '1:command:->cmd' \\
        '*::arg:->args'

    case $state in
        cmd)
            _describe -t commands 'interlinked commands' commands
            ;;
        args)
            case $words[1] in
${caseBlocks}
                *)
                    _arguments \\
                        '--json[Machine-readable output]' \\
                        '--short[One-line summary]' \\
                        '--full[Detailed output]'
                    ;;
            esac
            ;;
    esac
}

_interlinked "$@"
`;
}

function generateFishCompletions(): string {
	const lines = [
		"# interlinked fish completion",
		"# Add to config: interlinked completions fish | source",
		"",
		"# Disable file completions for interlinked",
		"complete -c interlinked -f",
		"",
		"# Main commands",
	];

	for (const cmd of COMMANDS) {
		lines.push(`complete -c interlinked -n '__fish_use_subcommand' -a '${cmd}' -d '${cmd}'`);
	}

	lines.push("");
	lines.push("# Subcommands");
	for (const [cmd, subs] of Object.entries(SUBCOMMANDS)) {
		lines.push(`complete -c interlinked -n '__fish_seen_subcommand_from ${cmd}' -a '${subs}'`);
	}

	lines.push("");
	lines.push("# Global options");
	lines.push("complete -c interlinked -l json -d 'Machine-readable output'");
	lines.push("complete -c interlinked -l short -d 'One-line summary'");
	lines.push("complete -c interlinked -l full -d 'Detailed output'");

	return `${lines.join("\n")}\n`;
}
