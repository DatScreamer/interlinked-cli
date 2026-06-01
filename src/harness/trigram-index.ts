// ===========================================
// Trigram Index v2 — Fast regex search via inverted index
// ===========================================
// Indexes a codebase by breaking file content into overlapping 3-character
// sequences (trigrams) and building an inverted index: trigram → file IDs.
// At query time, decompose a search pattern into trigrams, intersect posting
// lists, and return only the files that could possibly match — typically
// reducing a full-repo grep to scanning a handful of files.
//
// v2 enhancements (inspired by Cursor's fast regex search blog post):
//   - Probabilistic masks: locMask (position bloom) + nextMask (next-char bloom)
//     per posting entry for adjacency verification and 3.5-gram selectivity
//   - Two-file layout: trigram.lookup (header + lookup table) + trigram.postings
//     (sequential posting data) for future lazy/mmap loading
//   - Hash-based keys: FNV-1a hashes in on-disk lookup table for binary search
//   - Early termination: stop intersection when candidate set is small enough
//   - Adjacency filtering: verify consecutive query trigrams are adjacent in files
//
// Design decisions:
//   - Lowercase all trigrams (case-insensitive index, never misses a match)
//   - Skip binary files (null byte in first 8KB)
//   - Skip oversized files (configurable, default 1MB)
//   - Filter "stop trigrams" that appear in > 40% of files (useless for filtering)
//   - Dirty layer for in-memory updates without full rebuild
//
// Primitives (encoding, extraction, binary detection, skip rules, on-disk
// format constants, bit helpers) live in ./trigram-primitives.ts. Git-based
// file discovery lives in ./trigram-git.ts. This file holds the TrigramIndex
// class — build/query/dirty-layer/serialization — that composes them.

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getChangedFilesSince, getHeadCommit, getTrackedFiles } from "./trigram-git.js";
import {
	binarySearchU32,
	DEFAULT_MAX_FILE_SIZE,
	DEFAULT_STOP_THRESHOLD,
	EARLY_TERMINATION_THRESHOLD,
	extractTrigrams,
	extractTrigramsWithMasks,
	FLAG_LOWERCASE,
	FLAG_MASKS,
	fnv1a,
	type IndexBuildOptions,
	type IndexStats,
	INDEX_DIR_NAME,
	isBinaryContent,
	LEGACY_INDEX_FILE_NAME,
	LOOKUP_FILE_NAME,
	MAGIC_LOOKUP,
	META_FILE_NAME,
	nextCharBit,
	popcount8,
	type PostingList,
	POSTINGS_FILE_NAME,
	shouldSkipFile,
	VERSION,
} from "./trigram-primitives.js";

// Re-export the primitives so existing importers of ./trigram-index.js keep
// working unchanged (public API is preserved across the decomposition).
export {
	extractTrigrams,
	isBinaryContent,
	isControlChar,
	packTrigram,
	type PostingList,
	shouldSkipFile,
	trigramToString,
	unpackTrigram,
} from "./trigram-primitives.js";

// ===========================================
// TrigramIndex Class
// ===========================================

export class TrigramIndex {
	/** File paths indexed by file ID (array index = file ID) */
	readonly files: string[];
	/** Reverse lookup: path → file ID */
	private fileToId: Map<string, number>;
	/** Inverted index: trigram → posting list with masks */
	private postings: Map<number, PostingList>;
	/** Trigrams too common to be useful for filtering */
	private stopTrigrams: Set<number>;
	/** Git commit the index was built from */
	baseCommit: string;
	/** When the index was built */
	builtAt: string;
	/** Working directory */
	readonly cwd: string;

	// --- Dirty layer ---
	/** Files with overridden trigram sets (fileId → trigrams, null = deleted) */
	private dirtyOverrides: Map<number, Set<number> | null>;
	/** New files added since base index (path → { id, trigrams }) */
	private dirtyNewFiles: Map<string, { id: number; trigrams: Set<number> }>;
	/** Next file ID for dirty new files */
	private nextFileId: number;

	constructor(
		files: string[],
		postings: Map<number, PostingList>,
		stopTrigrams: Set<number>,
		baseCommit: string,
		cwd: string,
		builtAt?: string,
	) {
		this.files = files;
		this.fileToId = new Map();
		for (let i = 0; i < files.length; i++) {
			this.fileToId.set(files[i], i);
		}
		this.postings = postings;
		this.stopTrigrams = stopTrigrams;
		this.baseCommit = baseCommit;
		this.cwd = cwd;
		this.builtAt = builtAt || new Date().toISOString();

		// Dirty layer
		this.dirtyOverrides = new Map();
		this.dirtyNewFiles = new Map();
		this.nextFileId = files.length;
	}

	// ===========================================
	// Building
	// ===========================================

	/**
	 * Build a full index from the working directory.
	 * Uses `git ls-files` for file discovery (respects .gitignore).
	 */
	static build(options: IndexBuildOptions = {}): TrigramIndex {
		const cwd = resolve(options.cwd || process.cwd());
		const maxFileSize = options.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;
		const stopThreshold = options.stopThreshold ?? DEFAULT_STOP_THRESHOLD;

		// Get file list
		const filePaths = getTrackedFiles(cwd);
		const totalFiles = filePaths.length;

		// Extract trigrams per file (with masks for enhanced postings)
		const fileEntries: Array<{
			path: string;
			masks: Map<number, { locMask: number; nextMask: number }>;
		}> = [];
		const trigramCounts = new Map<number, number>(); // trigram → number of files containing it

		for (let i = 0; i < filePaths.length; i++) {
			const relPath = filePaths[i];
			if (shouldSkipFile(relPath)) continue;

			const absPath = join(cwd, relPath);
			let content: string;
			try {
				const stat = readFileSync(absPath);
				if (stat.length > maxFileSize) continue;
				if (isBinaryContent(stat)) continue;
				content = stat.toString("utf-8");
			} catch {
				continue; // unreadable file, skip
			}

			const masks = extractTrigramsWithMasks(content);
			if (masks.size === 0) continue;

			fileEntries.push({ path: relPath, masks });

			// Count how many files each trigram appears in
			for (const tri of masks.keys()) {
				trigramCounts.set(tri, (trigramCounts.get(tri) || 0) + 1);
			}

			if (options.onProgress) {
				options.onProgress(fileEntries.length, totalFiles);
			}
		}

		// Determine stop trigrams
		const fileCount = fileEntries.length;
		const stopCutoff = Math.floor(fileCount * stopThreshold);
		const stopTrigrams = new Set<number>();
		for (const [tri, count] of trigramCounts) {
			if (count > stopCutoff) {
				stopTrigrams.add(tri);
			}
		}

		// Build inverted index with masks (excluding stop trigrams)
		const postingsBuilder = new Map<
			number,
			{ fileIds: number[]; locMasks: number[]; nextMasks: number[] }
		>();
		const files: string[] = [];

		for (let fileId = 0; fileId < fileEntries.length; fileId++) {
			const { path, masks } = fileEntries[fileId];
			files.push(path);

			for (const [tri, m] of masks) {
				if (stopTrigrams.has(tri)) continue;
				let entry = postingsBuilder.get(tri);
				if (!entry) {
					entry = { fileIds: [], locMasks: [], nextMasks: [] };
					postingsBuilder.set(tri, entry);
				}
				entry.fileIds.push(fileId);
				entry.locMasks.push(m.locMask);
				entry.nextMasks.push(m.nextMask);
			}
		}

		// Convert to typed arrays for compactness
		const postings = new Map<number, PostingList>();
		for (const [tri, data] of postingsBuilder) {
			postings.set(tri, {
				fileIds: new Uint32Array(data.fileIds),
				locMasks: new Uint8Array(data.locMasks),
				nextMasks: new Uint8Array(data.nextMasks),
			});
		}

		// Get base commit
		const baseCommit = getHeadCommit(cwd);

		return new TrigramIndex(files, postings, stopTrigrams, baseCommit, cwd);
	}

	// ===========================================
	// Querying
	// ===========================================

	/**
	 * Query the index with a set of required trigrams.
	 * Returns file IDs that contain ALL non-stop trigrams.
	 * If all trigrams are stop trigrams or none provided, returns all files.
	 *
	 * @param requiredTrigrams - Trigrams that must all appear in matching files
	 * @param trigramSequences - Ordered sequences of consecutive trigrams for adjacency checking
	 */
	query(requiredTrigrams: number[], trigramSequences?: number[][]): Set<number> {
		// Filter out stop trigrams — they match too many files to be useful
		const usable = requiredTrigrams.filter((t) => !this.stopTrigrams.has(t));

		if (usable.length === 0) {
			// No usable trigrams — every file is a candidate
			return this.getAllFileIds();
		}

		// Sort by posting list size (smallest first) for fastest intersection
		usable.sort((a, b) => this.getPostingSize(a) - this.getPostingSize(b));

		let result: Set<number> | null = null;

		for (const tri of usable) {
			const candidates = this.getCandidatesForTrigram(tri);

			if (candidates.size === 0) {
				return new Set(); // definitive miss — no file has this trigram
			}

			if (result === null) {
				result = candidates;
			} else {
				// Intersect: keep only IDs in both sets
				for (const id of result) {
					if (!candidates.has(id)) {
						result.delete(id);
					}
				}
			}

			if (result.size === 0) return result; // early exit

			// Early termination: candidate set small enough, further intersection unlikely to help
			if (result.size <= EARLY_TERMINATION_THRESHOLD) break;
		}

		result = result ?? this.getAllFileIds();

		// Adjacency filtering using probabilistic masks
		if (trigramSequences && trigramSequences.length > 0 && result.size > 0) {
			const filtered = this.filterByAdjacency(result, trigramSequences);
			// Only use filtered result if it's non-empty (avoid false-negative wipeout)
			if (filtered.size > 0) {
				result = filtered;
			}
		}

		return result;
	}

	/**
	 * Query and return candidate file paths (relative to cwd).
	 */
	queryCandidatePaths(requiredTrigrams: number[], trigramSequences?: number[][]): string[] {
		const ids = this.query(requiredTrigrams, trigramSequences);
		const paths: string[] = [];
		for (const id of ids) {
			const p = this.getFilePath(id);
			if (p) paths.push(p);
		}
		return paths;
	}

	/** Get the total number of indexed files (base + dirty new) */
	get totalFiles(): number {
		return this.files.length + this.dirtyNewFiles.size;
	}

	// ===========================================
	// Adjacency Filtering
	// ===========================================

	/**
	 * Filter candidates by verifying that consecutive trigrams in query sequences
	 * are actually adjacent in the file (using locMask and nextMask bloom filters).
	 */
	private filterByAdjacency(candidates: Set<number>, sequences: number[][]): Set<number> {
		const filtered = new Set<number>();
		for (const fileId of candidates) {
			if (this.passesAdjacencyCheck(fileId, sequences)) {
				filtered.add(fileId);
			}
		}
		return filtered;
	}

	private passesAdjacencyCheck(fileId: number, sequences: number[][]): boolean {
		for (const seq of sequences) {
			if (seq.length < 2) continue; // single trigram, no adjacency to check

			for (let i = 0; i < seq.length - 1; i++) {
				const triA = seq[i];
				const triB = seq[i + 1];

				// Skip check for stop trigrams (no masks available)
				if (this.stopTrigrams.has(triA) || this.stopTrigrams.has(triB)) continue;

				const masksA = this.getMasksForFile(triA, fileId);
				const masksB = this.getMasksForFile(triB, fileId);
				if (!masksA || !masksB) continue; // not in base postings, skip

				// Position adjacency: rotate A's locMask left by 1, must overlap with B's
				const rotated = ((masksA.locMask << 1) | (masksA.locMask >>> 7)) & 0xff;
				if ((rotated & masksB.locMask) === 0) return false;

				// Next-char check: the 3rd char of triB should be in A's nextMask
				const thirdCharOfB = triB & 0xff; // lowest byte = 3rd character
				if ((masksA.nextMask & nextCharBit(thirdCharOfB)) === 0) return false;
			}
		}
		return true;
	}

	/**
	 * Look up the locMask and nextMask for a specific (trigram, fileId) pair.
	 * Returns null if the trigram is not in the base postings for this file.
	 */
	private getMasksForFile(
		trigram: number,
		fileId: number,
	): { locMask: number; nextMask: number } | null {
		// Check dirty override first
		if (this.dirtyOverrides.has(fileId)) {
			// Dirty files don't have masks — skip adjacency for them
			return null;
		}

		// Check dirty new files
		for (const entry of this.dirtyNewFiles.values()) {
			if (entry.id === fileId) return null; // dirty new file, no masks
		}

		// Check base postings
		const posting = this.postings.get(trigram);
		if (!posting) return null;

		const idx = binarySearchU32(posting.fileIds, fileId);
		if (idx < 0) return null;

		return { locMask: posting.locMasks[idx], nextMask: posting.nextMasks[idx] };
	}

	// ===========================================
	// Private Query Helpers
	// ===========================================

	/** Get file path for a file ID */
	private getFilePath(id: number): string | undefined {
		if (id < this.files.length) {
			return this.files[id];
		}
		// Check dirty new files
		for (const [path, entry] of this.dirtyNewFiles) {
			if (entry.id === id) return path;
		}
		return undefined;
	}

	/** Get all file IDs (base + dirty, excluding deleted) */
	private getAllFileIds(): Set<number> {
		const ids = new Set<number>();
		for (let i = 0; i < this.files.length; i++) {
			if (this.dirtyOverrides.get(i) !== null || !this.dirtyOverrides.has(i)) {
				ids.add(i);
			}
		}
		for (const entry of this.dirtyNewFiles.values()) {
			ids.add(entry.id);
		}
		return ids;
	}

	/** Get candidates for a single trigram, merging base + dirty */
	private getCandidatesForTrigram(trigram: number): Set<number> {
		const candidates = new Set<number>();

		// Add from base posting list (skipping overridden files)
		const basePostings = this.postings.get(trigram);
		if (basePostings) {
			for (const id of basePostings.fileIds) {
				if (this.dirtyOverrides.has(id)) continue; // handled below
				candidates.add(id);
			}
		}

		// Handle dirty overrides: files whose trigrams have been recomputed
		for (const [id, trigrams] of this.dirtyOverrides) {
			if (trigrams === null) continue; // deleted file
			if (trigrams.has(trigram)) candidates.add(id);
		}

		// Handle dirty new files
		for (const entry of this.dirtyNewFiles.values()) {
			if (entry.trigrams.has(trigram)) candidates.add(entry.id);
		}

		return candidates;
	}

	/** Get posting list size (for sort order optimization) */
	private getPostingSize(trigram: number): number {
		const base = this.postings.get(trigram);
		return base ? base.fileIds.length : 0;
	}

	// ===========================================
	// Dirty Layer
	// ===========================================

	/**
	 * Update the index for a single file (in-memory dirty layer).
	 * Pass null content to mark a file as deleted.
	 */
	updateFile(relPath: string, content: string | null): void {
		const existingId = this.fileToId.get(relPath);
		const dirtyNew = this.dirtyNewFiles.get(relPath);

		if (content === null) {
			// File deleted
			if (existingId !== undefined) {
				this.dirtyOverrides.set(existingId, null);
			}
			if (dirtyNew) {
				this.dirtyNewFiles.delete(relPath);
			}
			return;
		}

		// Extract new trigrams
		const trigrams = isBinaryContent(content) ? new Set<number>() : extractTrigrams(content);

		if (existingId !== undefined) {
			// Override existing file
			this.dirtyOverrides.set(existingId, trigrams);
		} else if (dirtyNew) {
			// Update an already-dirty new file
			dirtyNew.trigrams = trigrams;
		} else {
			// Brand new file
			const id = this.nextFileId++;
			this.dirtyNewFiles.set(relPath, { id, trigrams });
		}
	}

	/** Get the number of dirty (modified/added/deleted) files */
	get dirtyFileCount(): number {
		return this.dirtyOverrides.size + this.dirtyNewFiles.size;
	}

	/** Check if the index has any dirty state */
	get isDirty(): boolean {
		return this.dirtyOverrides.size > 0 || this.dirtyNewFiles.size > 0;
	}

	/** Clear all dirty state (e.g., after saving to disk) */
	clearDirty(): void {
		this.dirtyOverrides.clear();
		this.dirtyNewFiles.clear();
	}

	/**
	 * Merge dirty layer into the base index so save() writes a complete snapshot.
	 * After merging, dirty state is cleared and the base index reflects all edits.
	 * Re-reads files from disk to compute proper masks for merged entries.
	 */
	mergeDirty(): void {
		if (!this.isDirty) return;

		// 1. Rebuild postings as mutable arrays
		const newPostings = new Map<
			number,
			{ fileIds: number[]; locMasks: number[]; nextMasks: number[] }
		>();
		for (const [tri, posting] of this.postings) {
			newPostings.set(tri, {
				fileIds: [...posting.fileIds],
				locMasks: [...posting.locMasks],
				nextMasks: [...posting.nextMasks],
			});
		}

		// 2. Apply overrides (modified/deleted base files)
		for (const [fileId, trigrams] of this.dirtyOverrides) {
			// Remove this fileId from all existing postings
			for (const [, data] of newPostings) {
				const idx = data.fileIds.indexOf(fileId);
				if (idx >= 0) {
					data.fileIds.splice(idx, 1);
					data.locMasks.splice(idx, 1);
					data.nextMasks.splice(idx, 1);
				}
			}
			// Re-add with new trigrams (null = deleted, skip)
			if (trigrams) {
				// Try to get proper masks from disk
				let masks: Map<number, { locMask: number; nextMask: number }> | null = null;
				if (fileId < this.files.length) {
					try {
						const absPath = join(this.cwd, this.files[fileId]);
						if (existsSync(absPath)) {
							const content = readFileSync(absPath, "utf-8");
							masks = extractTrigramsWithMasks(content);
						}
					} catch (err) {
						void err; /* intentional: fall back to zero masks if file can't be read */
					}
				}

				for (const tri of trigrams) {
					let data = newPostings.get(tri);
					if (!data) {
						data = { fileIds: [], locMasks: [], nextMasks: [] };
						newPostings.set(tri, data);
					}
					const m = masks?.get(tri);
					data.fileIds.push(fileId);
					data.locMasks.push(m?.locMask ?? 0);
					data.nextMasks.push(m?.nextMask ?? 0);
				}
			}
		}

		// 3. Apply new files (assign permanent IDs starting from files.length)
		for (const [path, entry] of this.dirtyNewFiles) {
			const newId = this.files.length;
			this.files.push(path);
			this.fileToId.set(path, newId);

			// Try to get proper masks from disk
			let masks: Map<number, { locMask: number; nextMask: number }> | null = null;
			try {
				const absPath = join(this.cwd, path);
				if (existsSync(absPath)) {
					const content = readFileSync(absPath, "utf-8");
					masks = extractTrigramsWithMasks(content);
				}
			} catch (err) {
				void err; /* intentional: fall back to zero masks if file can't be read */
			}

			for (const tri of entry.trigrams) {
				let data = newPostings.get(tri);
				if (!data) {
					data = { fileIds: [], locMasks: [], nextMasks: [] };
					newPostings.set(tri, data);
				}
				const m = masks?.get(tri);
				data.fileIds.push(newId);
				data.locMasks.push(m?.locMask ?? 0);
				data.nextMasks.push(m?.nextMask ?? 0);
			}
		}

		// 4. Convert back to PostingList, remove empty postings
		this.postings.clear();
		for (const [tri, data] of newPostings) {
			if (data.fileIds.length > 0) {
				// Sort by fileId for binary search
				const indices = data.fileIds.map((_, i) => i);
				indices.sort((a, b) => data.fileIds[a] - data.fileIds[b]);
				this.postings.set(tri, {
					fileIds: new Uint32Array(indices.map((i) => data.fileIds[i])),
					locMasks: new Uint8Array(indices.map((i) => data.locMasks[i])),
					nextMasks: new Uint8Array(indices.map((i) => data.nextMasks[i])),
				});
			}
		}

		// 5. Recompute stop trigrams (>40% of files)
		const threshold = Math.floor(this.files.length * 0.4);
		this.stopTrigrams.clear();
		for (const [tri, posting] of this.postings) {
			if (posting.fileIds.length > threshold) this.stopTrigrams.add(tri);
		}

		// 6. Reset dirty state
		this.nextFileId = this.files.length;
		this.clearDirty();
	}

	// ===========================================
	// Incremental Update
	// ===========================================

	/**
	 * Incrementally update the index from git changes since baseCommit.
	 * Reads changed files from disk and updates the dirty layer.
	 * Returns the number of files updated.
	 */
	incrementalUpdate(): number {
		const currentCommit = getHeadCommit(this.cwd);
		if (currentCommit === this.baseCommit) return 0;

		// If diff fails (e.g., base commit no longer exists), return 0 —
		// a full rebuild would be needed.
		const changedFiles = getChangedFilesSince(this.cwd, this.baseCommit);
		if (changedFiles === null) return 0;

		let updated = 0;
		for (const relPath of changedFiles) {
			if (shouldSkipFile(relPath)) continue;
			const absPath = join(this.cwd, relPath);
			try {
				if (!existsSync(absPath)) {
					this.updateFile(relPath, null);
					updated++;
					continue;
				}
				const buf = readFileSync(absPath);
				if (buf.length > DEFAULT_MAX_FILE_SIZE || isBinaryContent(buf)) {
					this.updateFile(relPath, null);
				} else {
					this.updateFile(relPath, buf.toString("utf-8"));
				}
				updated++;
			} catch (err) {
				void err; /* intentional: skip unreadable files during incremental rebuild */
			}
		}

		this.baseCommit = currentCommit;
		return updated;
	}

	// ===========================================
	// Serialization — Two-File v2 Format
	// ===========================================

	/**
	 * Save the index to disk in .interlinked/index/.
	 *
	 * Two-file format:
	 *   trigram.lookup  — header, file table, stop trigrams, sorted lookup entries
	 *   trigram.postings — sequential posting entries (6 bytes each)
	 *   meta.json — quick-access statistics
	 */
	save(interlinkedDir?: string): void {
		// Merge dirty layer into base index so we save a complete snapshot
		this.mergeDirty();

		const dir = interlinkedDir || join(this.cwd, ".interlinked");
		const indexDir = join(dir, INDEX_DIR_NAME);
		if (!existsSync(indexDir)) mkdirSync(indexDir, { recursive: true });

		// Sort trigrams by FNV-1a hash for lookup table
		const sortedEntries: Array<{
			packed: number;
			hash: number;
			posting: PostingList;
		}> = [];
		for (const [packed, posting] of this.postings) {
			sortedEntries.push({ packed, hash: fnv1a(packed), posting });
		}
		sortedEntries.sort((a, b) => {
			if (a.hash < b.hash) return -1;
			if (a.hash > b.hash) return 1;
			return 0;
		});

		// --- Build postings file ---
		const postingsChunks: Buffer[] = [];
		let totalPostings = 0;
		let currentOffset = 0;
		const lookupData: Array<{
			hash: number;
			packed: number;
			offset: number;
			count: number;
		}> = [];

		for (const entry of sortedEntries) {
			const count = entry.posting.fileIds.length;
			const entryBuf = Buffer.alloc(count * 6);
			for (let i = 0; i < count; i++) {
				entryBuf.writeUInt32LE(entry.posting.fileIds[i], i * 6);
				entryBuf.writeUInt8(entry.posting.locMasks[i], i * 6 + 4);
				entryBuf.writeUInt8(entry.posting.nextMasks[i], i * 6 + 5);
			}
			postingsChunks.push(entryBuf);

			lookupData.push({
				hash: entry.hash,
				packed: entry.packed,
				offset: currentOffset,
				count,
			});
			currentOffset += count * 6;
			totalPostings += count;
		}

		const postingsBuf = Buffer.concat(postingsChunks);
		writeFileSync(join(indexDir, POSTINGS_FILE_NAME), postingsBuf);

		// --- Build lookup file ---
		const lookupChunks: Buffer[] = [];

		// Header (28 bytes)
		const header = Buffer.alloc(28);
		header.writeUInt32LE(MAGIC_LOOKUP, 0);
		header.writeUInt32LE(VERSION, 4);
		header.writeUInt32LE(FLAG_LOWERCASE | FLAG_MASKS, 8);
		header.writeUInt32LE(this.files.length, 12);
		header.writeUInt32LE(this.postings.size, 16);
		header.writeUInt32LE(this.stopTrigrams.size, 20);
		header.writeUInt32LE(0, 24); // reserved
		lookupChunks.push(header);

		// Meta: base commit + builtAt
		const commitBuf = Buffer.from(this.baseCommit, "utf-8");
		const builtAtBuf = Buffer.from(this.builtAt, "utf-8");
		const metaBuf = Buffer.alloc(2 + commitBuf.length + builtAtBuf.length);
		metaBuf.writeUInt8(commitBuf.length, 0);
		commitBuf.copy(metaBuf, 1);
		metaBuf.writeUInt8(builtAtBuf.length, 1 + commitBuf.length);
		builtAtBuf.copy(metaBuf, 2 + commitBuf.length);
		lookupChunks.push(metaBuf);

		// File table
		for (const filePath of this.files) {
			const pathBuf = Buffer.from(filePath, "utf-8");
			const entry = Buffer.alloc(2 + pathBuf.length);
			entry.writeUInt16LE(pathBuf.length, 0);
			pathBuf.copy(entry, 2);
			lookupChunks.push(entry);
		}

		// Stop trigrams (sorted for deterministic output)
		const sortedStops = [...this.stopTrigrams].sort((a, b) => a - b);
		const stopBuf = Buffer.alloc(sortedStops.length * 4);
		for (let i = 0; i < sortedStops.length; i++) {
			stopBuf.writeUInt32LE(sortedStops[i], i * 4);
		}
		lookupChunks.push(stopBuf);

		// Lookup table entries (sorted by hash): [hash(4) + packed(4) + offset(4) + count(4)]
		const lookupTableBuf = Buffer.alloc(lookupData.length * 16);
		for (let i = 0; i < lookupData.length; i++) {
			const e = lookupData[i];
			lookupTableBuf.writeUInt32LE(e.hash, i * 16);
			lookupTableBuf.writeUInt32LE(e.packed, i * 16 + 4);
			lookupTableBuf.writeUInt32LE(e.offset, i * 16 + 8);
			lookupTableBuf.writeUInt32LE(e.count, i * 16 + 12);
		}
		lookupChunks.push(lookupTableBuf);

		const lookupBuf = Buffer.concat(lookupChunks);
		writeFileSync(join(indexDir, LOOKUP_FILE_NAME), lookupBuf);

		// --- Metadata JSON ---
		// Compute average mask saturation
		let totalLocBits = 0;
		let totalNextBits = 0;
		for (const posting of this.postings.values()) {
			for (let i = 0; i < posting.locMasks.length; i++) {
				totalLocBits += popcount8(posting.locMasks[i]);
				totalNextBits += popcount8(posting.nextMasks[i]);
			}
		}

		const meta: IndexStats = {
			fileCount: this.files.length,
			trigramCount: this.postings.size,
			stopTrigramCount: this.stopTrigrams.size,
			baseCommit: this.baseCommit,
			indexSizeBytes: lookupBuf.length + postingsBuf.length,
			builtAt: this.builtAt,
			lookupSizeBytes: lookupBuf.length,
			postingsSizeBytes: postingsBuf.length,
			avgLocMaskBits: totalPostings > 0 ? totalLocBits / totalPostings : 0,
			avgNextMaskBits: totalPostings > 0 ? totalNextBits / totalPostings : 0,
		};
		writeFileSync(join(indexDir, META_FILE_NAME), JSON.stringify(meta, null, 2));

		// Clean up legacy v1 file
		try {
			const legacyPath = join(indexDir, LEGACY_INDEX_FILE_NAME);
			if (existsSync(legacyPath)) {
				unlinkSync(legacyPath);
			}
		} catch (err) {
			void err; /* intentional: legacy file cleanup is non-fatal */
		}
	}

	/**
	 * Load an index from disk.
	 * Reads the v2 two-file format (trigram.lookup + trigram.postings).
	 * Returns null if no v2 index found.
	 */
	static load(cwd: string, interlinkedDir?: string): TrigramIndex | null {
		const dir = interlinkedDir || join(cwd, ".interlinked");
		const lookupPath = join(dir, INDEX_DIR_NAME, LOOKUP_FILE_NAME);
		const postingsPath = join(dir, INDEX_DIR_NAME, POSTINGS_FILE_NAME);

		if (!existsSync(lookupPath) || !existsSync(postingsPath)) return null;

		let lookupBuf: Buffer;
		let postingsBuf: Buffer;
		try {
			lookupBuf = readFileSync(lookupPath);
			postingsBuf = readFileSync(postingsPath);
		} catch {
			return null;
		}

		if (lookupBuf.length < 28) return null;

		let offset = 0;

		// Header
		const magic = lookupBuf.readUInt32LE(offset);
		offset += 4;
		if (magic !== MAGIC_LOOKUP) return null;

		const version = lookupBuf.readUInt32LE(offset);
		offset += 4;
		if (version !== VERSION) return null;

		const _flags = lookupBuf.readUInt32LE(offset);
		offset += 4;

		const fileCount = lookupBuf.readUInt32LE(offset);
		offset += 4;

		const trigramCount = lookupBuf.readUInt32LE(offset);
		offset += 4;

		const stopCount = lookupBuf.readUInt32LE(offset);
		offset += 4;

		const _reserved = lookupBuf.readUInt32LE(offset);
		offset += 4;

		// Meta: base commit + builtAt
		if (offset >= lookupBuf.length) return null;
		const commitLen = lookupBuf.readUInt8(offset);
		offset += 1;
		if (offset + commitLen > lookupBuf.length) return null;
		const baseCommit = lookupBuf.toString("utf-8", offset, offset + commitLen);
		offset += commitLen;

		let builtAt = new Date().toISOString();
		if (offset < lookupBuf.length) {
			const builtAtLen = lookupBuf.readUInt8(offset);
			offset += 1;
			if (offset + builtAtLen <= lookupBuf.length) {
				builtAt = lookupBuf.toString("utf-8", offset, offset + builtAtLen);
				offset += builtAtLen;
			}
		}

		// File table
		const files: string[] = [];
		for (let i = 0; i < fileCount; i++) {
			if (offset + 2 > lookupBuf.length) return null;
			const pathLen = lookupBuf.readUInt16LE(offset);
			offset += 2;
			if (offset + pathLen > lookupBuf.length) return null;
			files.push(lookupBuf.toString("utf-8", offset, offset + pathLen));
			offset += pathLen;
		}

		// Stop trigrams
		const stopTrigrams = new Set<number>();
		for (let i = 0; i < stopCount; i++) {
			if (offset + 4 > lookupBuf.length) return null;
			stopTrigrams.add(lookupBuf.readUInt32LE(offset));
			offset += 4;
		}

		// Lookup table entries → reconstruct postings from postings file
		const postings = new Map<number, PostingList>();
		for (let i = 0; i < trigramCount; i++) {
			if (offset + 16 > lookupBuf.length) return null;
			const _hash = lookupBuf.readUInt32LE(offset);
			offset += 4;
			const packed = lookupBuf.readUInt32LE(offset);
			offset += 4;
			const postingOffset = lookupBuf.readUInt32LE(offset);
			offset += 4;
			const count = lookupBuf.readUInt32LE(offset);
			offset += 4;

			// Read posting entries from postings file
			if (postingOffset + count * 6 > postingsBuf.length) return null;
			const fileIds = new Uint32Array(count);
			const locMasks = new Uint8Array(count);
			const nextMasks = new Uint8Array(count);
			for (let j = 0; j < count; j++) {
				const entryOffset = postingOffset + j * 6;
				fileIds[j] = postingsBuf.readUInt32LE(entryOffset);
				locMasks[j] = postingsBuf.readUInt8(entryOffset + 4);
				nextMasks[j] = postingsBuf.readUInt8(entryOffset + 5);
			}
			postings.set(packed, { fileIds, locMasks, nextMasks });
		}

		return new TrigramIndex(files, postings, stopTrigrams, baseCommit, cwd, builtAt);
	}

	/**
	 * Load just the metadata without parsing the full index.
	 */
	static loadMeta(cwd: string, interlinkedDir?: string): IndexStats | null {
		const dir = interlinkedDir || join(cwd, ".interlinked");
		const metaPath = join(dir, INDEX_DIR_NAME, META_FILE_NAME);
		try {
			return JSON.parse(readFileSync(metaPath, "utf-8"));
		} catch {
			return null;
		}
	}

	/** Get index statistics */
	stats(): IndexStats {
		let lookupSizeBytes = 28; // header
		for (const f of this.files) lookupSizeBytes += 2 + Buffer.byteLength(f);
		lookupSizeBytes += this.stopTrigrams.size * 4;
		lookupSizeBytes += this.postings.size * 16; // lookup table entries

		let postingsSizeBytes = 0;
		let totalPostings = 0;
		let totalLocBits = 0;
		let totalNextBits = 0;
		for (const posting of this.postings.values()) {
			postingsSizeBytes += posting.fileIds.length * 6;
			totalPostings += posting.fileIds.length;
			for (let i = 0; i < posting.locMasks.length; i++) {
				totalLocBits += popcount8(posting.locMasks[i]);
				totalNextBits += popcount8(posting.nextMasks[i]);
			}
		}

		return {
			fileCount: this.files.length,
			trigramCount: this.postings.size,
			stopTrigramCount: this.stopTrigrams.size,
			baseCommit: this.baseCommit,
			indexSizeBytes: lookupSizeBytes + postingsSizeBytes,
			builtAt: this.builtAt,
			lookupSizeBytes,
			postingsSizeBytes,
			avgLocMaskBits: totalPostings > 0 ? totalLocBits / totalPostings : 0,
			avgNextMaskBits: totalPostings > 0 ? totalNextBits / totalPostings : 0,
		};
	}
}
