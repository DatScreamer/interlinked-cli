import { randomUUID } from "node:crypto";
import {
	chmodSync,
	closeSync,
	constants,
	fsyncSync,
	fstatSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	realpathSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";

const MUTATION_STATE_DIRECTORY = ".interlinked";

function secureStateDirectory(root: string): string {
	const canonicalRoot = realpathSync(resolve(root));
	const directory = join(canonicalRoot, MUTATION_STATE_DIRECTORY);
	let state = lstatSync(directory, { throwIfNoEntry: false });
	if (state === undefined) {
		mkdirSync(directory, { mode: 0o700 });
		state = lstatSync(directory);
	}
	if (state.isSymbolicLink() || !state.isDirectory()) {
		throw new Error(`mutation state directory must be a real directory: ${directory}`);
	}
	if (realpathSync(directory) !== directory) {
		throw new Error(`mutation state directory escapes the repository: ${directory}`);
	}
	return directory;
}

/** Resolve one local mutation-state file without following repository links. */
export function secureMutationStateFilePath(root: string, name: string): string {
	if (name.length === 0 || basename(name) !== name) {
		throw new Error(`invalid mutation state filename: ${name}`);
	}
	const path = join(secureStateDirectory(root), name);
	const state = lstatSync(path, { throwIfNoEntry: false });
	if (state?.isSymbolicLink()) {
		throw new Error(`mutation state file must not be a symbolic link: ${path}`);
	}
	if (state !== undefined && !state.isFile()) {
		throw new Error(`mutation state path must be a regular file or missing: ${path}`);
	}
	return path;
}

/** Read a bounded regular state file through O_NOFOLLOW. */
export function readMutationStateFile(
	root: string,
	name: string,
	maxBytes: number,
): string | null {
	const path = secureMutationStateFilePath(root, name);
	const state = lstatSync(path, { throwIfNoEntry: false });
	if (state === undefined) return null;
	const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const opened = fstatSync(fd);
		if (!opened.isFile() || opened.size > maxBytes) {
			throw new Error(`mutation state file is not a bounded regular file: ${path}`);
		}
		return readFileSync(fd, "utf8");
	} finally {
		closeSync(fd);
	}
}

/** Publish private state with a same-directory temp file and atomic rename. */
export function writeMutationStateFileAtomic(root: string, name: string, content: string): void {
	const path = secureMutationStateFilePath(root, name);
	const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
	let fd: number | null = null;
	try {
		fd = openSync(
			temporary,
			constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
			0o600,
		);
		writeFileSync(fd, content, "utf8");
		fsyncSync(fd);
		closeSync(fd);
		fd = null;
		renameSync(temporary, path);
		chmodSync(path, 0o600);
	} finally {
		if (fd !== null) closeSync(fd);
		try {
			unlinkSync(temporary);
		} catch {
			// Successful rename or a failed create leaves no temporary file.
		}
	}
}
