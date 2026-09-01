// Outbox leasing and delivery acknowledgements for the mutation journal.
import { randomUUID } from "node:crypto";
import {
	asRow,
	changes,
	inTransaction,
	leaseExpiry,
	numberField,
	parsedJson,
	requireString,
	requireTimestamp,
	stringField,
} from "./mutation-journal-codec.js";
import type { SqliteDatabase } from "./mutation-journal-driver.js";
import type {
	ClaimedOutboxEntry,
	OutboxLeaseRef,
	RenewOutboxLease,
} from "./mutation-journal-types.js";

export function claimMutationOutbox(
	db: SqliteDatabase,
	owner: string,
	nowMs: number,
	leaseMs: number,
): ClaimedOutboxEntry | null {
	requireString(owner, "owner");
	const expires = leaseExpiry(nowMs, leaseMs);
	return inTransaction(db, () => {
		const found = db.prepare(`SELECT * FROM mutation_outbox
            WHERE state = 'pending' AND (lease_token IS NULL OR lease_expires_at_ms <= ?)
            ORDER BY created_at_ms, outbox_id LIMIT 1`).get(nowMs);
		if (found === undefined) return null;
		const row = asRow(found, "outbox");
		const outboxId = stringField(row, "outbox_id");
		const token = randomUUID();
		db.prepare(`UPDATE mutation_outbox SET lease_owner = ?, lease_token = ?,
                lease_expires_at_ms = ?, attempt_count = attempt_count + 1
            WHERE outbox_id = ?`).run(owner, token, expires, outboxId);
		return {
			outboxId,
			evaluationId: numberField(row, "evaluation_id"),
			topic: "mutation.finding",
			payload: parsedJson(row.payload_json),
			leaseToken: token,
			leaseExpiresAtMs: expires,
			attemptCount: numberField(row, "attempt_count") + 1,
		};
	});
}

export function renewMutationOutbox(db: SqliteDatabase, input: RenewOutboxLease): boolean {
	const expires = leaseExpiry(input.nowMs, input.leaseMs);
	const result = db.prepare(`UPDATE mutation_outbox SET lease_expires_at_ms = ?
        WHERE outbox_id = ? AND lease_token = ? AND state = 'pending'
		  AND lease_expires_at_ms > ?`).run(
		expires,
		input.outboxId,
		input.leaseToken,
		input.nowMs,
	);
	return changes(result) === 1;
}

export function releaseMutationOutbox(db: SqliteDatabase, input: OutboxLeaseRef): boolean {
	requireTimestamp(input.nowMs, "nowMs");
	const result = db.prepare(`UPDATE mutation_outbox SET lease_owner = NULL,
        lease_token = NULL, lease_expires_at_ms = NULL
		WHERE outbox_id = ? AND lease_token = ? AND state = 'pending'`).run(
		input.outboxId,
		input.leaseToken,
	);
	return changes(result) === 1;
}

export function acknowledgeMutationOutbox(db: SqliteDatabase, input: OutboxLeaseRef): boolean {
	requireTimestamp(input.nowMs, "deliveredAtMs");
	return inTransaction(db, () => {
		const found = db.prepare(`SELECT state, lease_token, delivered_lease_token
			FROM mutation_outbox WHERE outbox_id = ?`).get(input.outboxId);
		if (found === undefined) return false;
		const row = asRow(found, "outbox acknowledgement");
		if (row.state === "delivered") return row.delivered_lease_token === input.leaseToken;
		if (row.state !== "pending" || row.lease_token !== input.leaseToken) return false;
		const result = db.prepare(`UPDATE mutation_outbox SET state = 'delivered',
				delivered_at_ms = ?, delivered_lease_token = ?, lease_owner = NULL,
				lease_token = NULL, lease_expires_at_ms = NULL
			WHERE outbox_id = ? AND lease_token = ? AND state = 'pending'`)
			.run(input.nowMs, input.leaseToken, input.outboxId, input.leaseToken);
		return changes(result) === 1;
	});
}
