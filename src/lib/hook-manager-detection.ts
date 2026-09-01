import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { JsonObject } from "./json-types.js";

export interface HookManagerInfo {
	name: string;
	detected_at: string;
}

interface PackageJsonShape {
	devDependencies: JsonObject;
	dependencies: JsonObject;
	scripts: JsonObject;
}

const EMPTY_PACKAGE_JSON: PackageJsonShape = {
	devDependencies: {},
	dependencies: {},
	scripts: {},
};

function isPlainObject(value: unknown): value is JsonObject {
	return value instanceof Object && !Array.isArray(value);
}

function isStringValue(value: unknown): value is string {
	return value === String(value);
}

/** Read package.json and project only the fields used for hook-manager
 * detection. Malformed or absent input behaves like an empty package. */
function readPackageJsonShape(cwd: string): PackageJsonShape {
	const pkgPath = join(cwd, "package.json");
	if (!existsSync(pkgPath)) return EMPTY_PACKAGE_JSON;
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(pkgPath, "utf-8"));
	} catch {
		return EMPTY_PACKAGE_JSON;
	}
	if (!isPlainObject(parsed)) return EMPTY_PACKAGE_JSON;
	return {
		devDependencies: isPlainObject(parsed.devDependencies) ? parsed.devDependencies : {},
		dependencies: isPlainObject(parsed.dependencies) ? parsed.dependencies : {},
		scripts: isPlainObject(parsed.scripts) ? parsed.scripts : {},
	};
}

function detectHusky(cwd: string, pkg: PackageJsonShape): HookManagerInfo | null {
	if (existsSync(join(cwd, ".husky"))) {
		return { name: "husky", detected_at: ".husky/" };
	}
	const prepareScript = pkg.scripts.prepare;
	const hasHuskyScript = isStringValue(prepareScript) && prepareScript.includes("husky");
	if (pkg.devDependencies.husky || pkg.dependencies.husky || hasHuskyScript) {
		return { name: "husky", detected_at: "package.json" };
	}
	return null;
}

function detectLefthook(cwd: string, pkg: PackageJsonShape): HookManagerInfo | null {
	const lefthookFiles = ["lefthook.yml", ".lefthook.yml", "lefthook.yaml", ".lefthook.yaml"];
	for (const file of lefthookFiles) {
		if (existsSync(join(cwd, file))) {
			return { name: "lefthook", detected_at: file };
		}
	}
	if (pkg.devDependencies.lefthook || pkg.dependencies.lefthook) {
		return { name: "lefthook", detected_at: "package.json" };
	}
	return null;
}

function detectOvercommit(cwd: string): HookManagerInfo | null {
	if (existsSync(join(cwd, ".overcommit.yml"))) {
		return { name: "overcommit", detected_at: ".overcommit.yml" };
	}
	return null;
}

/** Detect common Git hook managers in the project. */
export function detectHookManagers(cwd: string): HookManagerInfo[] {
	const pkg = readPackageJsonShape(cwd);
	const managers: HookManagerInfo[] = [];
	const husky = detectHusky(cwd, pkg);
	if (husky) managers.push(husky);
	const lefthook = detectLefthook(cwd, pkg);
	if (lefthook) managers.push(lefthook);
	const overcommit = detectOvercommit(cwd);
	if (overcommit) managers.push(overcommit);
	return managers;
}
