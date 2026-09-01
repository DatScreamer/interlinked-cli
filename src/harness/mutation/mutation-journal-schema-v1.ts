// Initial durable mutation-journal schema. Later migrations live in
// mutation-journal-schema.ts so upgrade ordering remains visible there.
export const MUTATION_JOURNAL_V1_SQL = `
CREATE TABLE IF NOT EXISTS mutation_jobs (
    job_id TEXT PRIMARY KEY,
    remote_job_id TEXT NOT NULL,
    acceptance_receipt_hash TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'evaluated', 'acked')),
    expected_job_json TEXT NOT NULL,
    expected_admission_json TEXT NOT NULL,
    target_bytes BLOB NOT NULL,
    target_sha256 TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    lease_owner TEXT,
    lease_token TEXT,
    lease_expires_at_ms INTEGER,
    claim_count INTEGER NOT NULL DEFAULT 0,
    acknowledged_at_ms INTEGER,
    CHECK (
        (lease_owner IS NULL AND lease_token IS NULL AND lease_expires_at_ms IS NULL)
        OR
        (lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_expires_at_ms IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS mutation_jobs_claimable
ON mutation_jobs(status, lease_expires_at_ms, created_at_ms);

CREATE TABLE IF NOT EXISTS mutation_evaluations (
    evaluation_id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL REFERENCES mutation_jobs(job_id),
    acceptance_receipt_hash TEXT NOT NULL,
    result_hash TEXT NOT NULL,
    authenticated_evidence_hash TEXT NOT NULL,
    evaluator_policy_version TEXT NOT NULL,
    evaluation_json TEXT NOT NULL,
    decision_json TEXT NOT NULL,
    committed_at_ms INTEGER NOT NULL,
    UNIQUE(acceptance_receipt_hash, result_hash, evaluator_policy_version),
    UNIQUE(job_id, result_hash, evaluator_policy_version)
);

CREATE TABLE IF NOT EXISTS mutation_manifest_snapshots (
    evaluation_id INTEGER PRIMARY KEY REFERENCES mutation_evaluations(evaluation_id) ON DELETE CASCADE,
    snapshot_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mutation_receipts (
    evaluation_id INTEGER PRIMARY KEY REFERENCES mutation_evaluations(evaluation_id) ON DELETE CASCADE,
    receipt_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mutation_run_rows (
    evaluation_id INTEGER PRIMARY KEY REFERENCES mutation_evaluations(evaluation_id) ON DELETE CASCADE,
    run_row_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mutation_findings (
    evaluation_id INTEGER NOT NULL REFERENCES mutation_evaluations(evaluation_id) ON DELETE CASCADE,
    finding_id TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    PRIMARY KEY(evaluation_id, finding_id)
);

CREATE TABLE IF NOT EXISTS mutation_outbox (
    outbox_id TEXT PRIMARY KEY,
    evaluation_id INTEGER NOT NULL REFERENCES mutation_evaluations(evaluation_id) ON DELETE CASCADE,
    topic TEXT NOT NULL CHECK (topic = 'mutation.finding'),
    payload_json TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending', 'delivered')),
    created_at_ms INTEGER NOT NULL,
    delivered_at_ms INTEGER,
	    delivered_lease_token TEXT,
    lease_owner TEXT,
    lease_token TEXT,
    lease_expires_at_ms INTEGER,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    UNIQUE(evaluation_id, outbox_id),
    CHECK (
        (lease_owner IS NULL AND lease_token IS NULL AND lease_expires_at_ms IS NULL)
        OR
        (lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_expires_at_ms IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS mutation_outbox_claimable
ON mutation_outbox(state, lease_expires_at_ms, created_at_ms);

CREATE TABLE IF NOT EXISTS mutation_legacy_imports (
    source_id TEXT PRIMARY KEY,
    captured_at_ms INTEGER NOT NULL,
    payload_json TEXT NOT NULL,
    imported_at_ms INTEGER NOT NULL
);
`;
