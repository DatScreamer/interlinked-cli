// Bounded newest-first JSONL line reader.

import { closeSync, openSync, readSync, statSync } from "node:fs";
import { MAX_CAPTURED_JSONL_LINE_BYTES } from "./bounded-file-io.js";

interface ReverseLineState {
	/** null means the current line exceeded the capture ceiling and is skipped. */
	carry: Buffer | null;
	lines: string[];
	capturedBytes: number;
	budgetExhausted: boolean;
}

/** Bound retained decoded lines even when a caller requests an enormous count. */
const MAX_RECENT_LINES_TOTAL_BYTES = 8 * 1024 * 1024;

function prependRecentBytes(piece: Buffer, carry: Buffer | null): Buffer | null {
	if (carry === null) return null;
	if (piece.length + carry.length > MAX_CAPTURED_JSONL_LINE_BYTES) return null;
	if (piece.length === 0) return carry;
	return Buffer.concat([piece, carry], piece.length + carry.length);
}

function finishRecentLine(state: ReverseLineState): void {
	if (state.carry !== null) {
		if (state.capturedBytes + state.carry.length > MAX_RECENT_LINES_TOTAL_BYTES) {
			state.budgetExhausted = true;
			state.carry = Buffer.alloc(0);
			return;
		}
		const text = state.carry.toString("utf8").trim();
		if (text) {
			state.lines.push(text);
			state.capturedBytes += state.carry.length;
		}
	}
	state.carry = Buffer.alloc(0);
}

/** Consume one earlier byte chunk while retaining undecoded bytes at its seam. */
function consumeReverseChunk(
	buffer: Buffer,
	state: ReverseLineState,
	maxLines: number,
): void {
	let segmentEnd = buffer.length;
	for (
		let i = buffer.length - 1;
		i >= 0 && state.lines.length < maxLines && !state.budgetExhausted;
		i--
	) {
		if (buffer[i] !== 0x0a) continue;
		state.carry = prependRecentBytes(buffer.subarray(i + 1, segmentEnd), state.carry);
		finishRecentLine(state);
		segmentEnd = i;
	}
	if (state.lines.length < maxLines && !state.budgetExhausted) {
		state.carry = prependRecentBytes(buffer.subarray(0, segmentEnd), state.carry);
	}
}

/**
 * Read the newest complete lines without loading the whole file. Raw bytes are
 * retained across chunk seams so multi-byte UTF-8 is decoded only after a full
 * line has been assembled. A single oversized line is skipped rather than
 * allowing the carry buffer to grow without bound.
 */
export function readRecentLines(
	path: string,
	maxLines: number,
	maxBytes: number = Number.POSITIVE_INFINITY,
): string[] {
	if (maxLines <= 0 || maxBytes <= 0) return [];

	const fileSize = statSync(path).size;
	if (fileSize <= 0) return [];

	const fd = openSync(path, "r");
	const chunkSize = 64 * 1024;
	let position = fileSize;
	let bytesRemaining = Math.min(fileSize, Math.floor(maxBytes));
	const state: ReverseLineState = {
		carry: Buffer.alloc(0),
		lines: [],
		capturedBytes: 0,
		budgetExhausted: false,
	};

	try {
		while (
			position > 0 &&
			bytesRemaining > 0 &&
			state.lines.length < maxLines &&
			!state.budgetExhausted
		) {
			const readSize = Math.min(chunkSize, position, bytesRemaining);
			position -= readSize;
			bytesRemaining -= readSize;

			const buffer = Buffer.alloc(readSize);
			readSync(fd, buffer, 0, readSize, position);
			consumeReverseChunk(buffer, state, maxLines);
		}

		// Only the file's actual first line is complete without a preceding
		// newline. A byte-budget stop leaves an incomplete oldest prefix.
		if (position === 0 && state.lines.length < maxLines && !state.budgetExhausted) {
			finishRecentLine(state);
		}
		return state.lines;
	} finally {
		closeSync(fd);
	}
}
