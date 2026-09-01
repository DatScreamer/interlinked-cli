// Shared OpenCode v1 vs v2 process detection. Both adapters and (as a
// copied snippet) the generated plugins use the same rules so v1 never
// claims an opencode2 process and the two plugins never double-gate.

export function isOpenCodeV2Env(env: NodeJS.ProcessEnv = process.env): boolean {
	if (env.OPENCODE2) return true;
	if (env.INTERLINKED_CLIENT === "opencode2") return true;
	const xdg = env.XDG_CONFIG_HOME ?? "";
	return xdg.includes("opencode-v2");
}
