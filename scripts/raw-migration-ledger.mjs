import pg from 'pg';

const { Client } = pg;

const LEDGER_LOCK_NAME = 'lunchlineup:raw-migration-ledger:v1';
const LEDGER_SCHEMA = 'lunchlineup_migrations';
const LEDGER_TABLE = 'raw_migration_ledger';
const DEFAULT_SOURCE_SHA = '0'.repeat(40);
const SOURCE_SHA_PATTERN = /^[a-f0-9]{40}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const CONNECTION_TIMEOUT_MS = 15_000;
const QUERY_TIMEOUT_MS = 610_000;
const STATEMENT_TIMEOUT_MS = 600_000;

function validateSourceSha(value, label, { required = false } = {}) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized && !required) return DEFAULT_SOURCE_SHA;
  if (!SOURCE_SHA_PATTERN.test(normalized)) {
    throw new Error(`${label} must be a full 40-character Git SHA.`);
  }
  return normalized;
}

function validateHistoricalPolicy(policy) {
  if (
    !policy
    || policy.version !== 2
    || !SOURCE_SHA_PATTERN.test(policy.historicalBaselineSourceSha ?? '')
    || !policy.historicalMigrations
    || typeof policy.historicalMigrations !== 'object'
    || Array.isArray(policy.historicalMigrations)
  ) {
    throw new Error('Raw migration policy must include a version 2 historical digest inventory.');
  }
  for (const [path, digest] of Object.entries(policy.historicalMigrations)) {
    if (!path.startsWith('packages/db/prisma/migrations/') || !SHA256_PATTERN.test(digest)) {
      throw new Error(`Raw migration policy historical digest is invalid: ${path}`);
    }
  }
  return policy;
}

function isConnectionFailure(error) {
  const code = String(error?.code ?? '');
  return code.startsWith('08')
    || ['57P01', '57P02', '57P03', 'ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT'].includes(code);
}

function exactReceipt(row, migration) {
  return row
    && row.path === migration.relativePath
    && row.sha256 === migration.sha256
    && Number(row.bytes) === migration.bytes;
}

export class RawMigrationLedgerSession {
  constructor({
    baselineSourceSha,
    clientFactory,
    databaseUrl,
    deploymentTarget,
    freshProductionConfirm,
    inventory,
    policy,
    sourceSha,
  }) {
    this.baselineSourceSha = baselineSourceSha
      ? validateSourceSha(baselineSourceSha, 'MIGRATION_BASELINE_SOURCE_SHA', { required: true })
      : null;
    this.clientFactory = clientFactory;
    this.databaseUrl = databaseUrl;
    this.deploymentTarget = deploymentTarget;
    this.freshProductionConfirm = freshProductionConfirm;
    this.inventory = inventory;
    this.policy = validateHistoricalPolicy(policy);
    this.sourceSha = validateSourceSha(sourceSha, 'MIGRATION_SOURCE_SHA', {
      required: deploymentTarget === 'production',
    });
    this.client = null;
  }

  static async open(options) {
    const session = new RawMigrationLedgerSession({
      ...options,
      clientFactory: options.clientFactory ?? (() => new Client({
        application_name: 'lunchlineup_raw_migration_ledger',
        connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
        connectionString: options.databaseUrl,
        query_timeout: QUERY_TIMEOUT_MS,
        statement_timeout: STATEMENT_TIMEOUT_MS,
      })),
    });
    try {
      await session.connectAndLock();
      await session.ensureLedger();
      await session.bootstrapHistoricalReceipts();
      return session;
    } catch (error) {
      await session.close().catch(() => undefined);
      throw error;
    }
  }

  async connectAndLock() {
    const client = this.clientFactory();
    await client.connect();
    this.client = client;
    await client.query(`SET statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
    await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [LEDGER_LOCK_NAME]);
  }

  async ensureLedger() {
    await this.client.query('BEGIN');
    try {
      await this.client.query(`CREATE SCHEMA IF NOT EXISTS ${LEDGER_SCHEMA}`);
      await this.client.query(`REVOKE ALL ON SCHEMA ${LEDGER_SCHEMA} FROM PUBLIC`);
      await this.client.query(`
        CREATE TABLE IF NOT EXISTS ${LEDGER_SCHEMA}.${LEDGER_TABLE} (
          path TEXT PRIMARY KEY,
          sha256 CHAR(64) NOT NULL,
          bytes INTEGER NOT NULL CHECK (bytes >= 0),
          phase TEXT NOT NULL CHECK (phase IN ('pre', 'post')),
          execution_mode TEXT NOT NULL CHECK (execution_mode IN ('APPLIED', 'BASELINED')),
          source_sha CHAR(40) NOT NULL,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);
      await this.client.query(`REVOKE ALL ON TABLE ${LEDGER_SCHEMA}.${LEDGER_TABLE} FROM PUBLIC`);
      await this.client.query('COMMIT');
    } catch (error) {
      await this.client.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  }

  async bootstrapHistoricalReceipts() {
    const countResult = await this.client.query(
      `SELECT COUNT(*)::integer AS count FROM ${LEDGER_SCHEMA}.${LEDGER_TABLE}`,
    );
    if (Number(countResult.rows[0]?.count ?? 0) > 0) return;

    if (!this.baselineSourceSha) {
      if (
        this.deploymentTarget === 'production'
        && this.freshProductionConfirm !== 'initialize-fresh-production-ledger'
      ) {
        throw new Error(
          'An empty production migration ledger requires MIGRATION_BASELINE_SOURCE_SHA or '
          + 'MIGRATION_FRESH_DATABASE_CONFIRM=initialize-fresh-production-ledger.',
        );
      }
      return;
    }

    if (this.baselineSourceSha !== this.policy.historicalBaselineSourceSha) {
      throw new Error(
        'MIGRATION_BASELINE_SOURCE_SHA does not match the checked-in historical migration baseline.',
      );
    }

    const historical = this.inventory.all.filter((migration) => {
      const baselineDigest = this.policy.historicalMigrations[migration.relativePath];
      if (!baselineDigest) return false;
      if (baselineDigest !== migration.sha256) {
        throw new Error(`Historical raw migration bytes drifted: ${migration.relativePath}`);
      }
      return true;
    });

    await this.client.query('BEGIN');
    try {
      for (const migration of historical) {
        await this.client.query(
          `INSERT INTO ${LEDGER_SCHEMA}.${LEDGER_TABLE}
            (path, sha256, bytes, phase, execution_mode, source_sha)
           VALUES ($1, $2, $3, $4, 'BASELINED', $5)`,
          [
            migration.relativePath,
            migration.sha256,
            migration.bytes,
            migration.phase,
            this.baselineSourceSha,
          ],
        );
      }
      await this.client.query('COMMIT');
    } catch (error) {
      await this.client.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  }

  async readReceipt(migration, client = this.client) {
    const result = await client.query(
      `SELECT path, sha256, bytes, phase, execution_mode, source_sha
       FROM ${LEDGER_SCHEMA}.${LEDGER_TABLE}
       WHERE path = $1`,
      [migration.relativePath],
    );
    return result.rows[0] ?? null;
  }

  assertReceipt(receipt, migration) {
    if (exactReceipt(receipt, migration)) return;
    throw new Error(`Raw migration checksum ledger mismatch: ${migration.relativePath}`);
  }

  async recoverAfterUnknownOutcome(migration) {
    await this.client?.end().catch(() => undefined);
    this.client = null;
    await this.connectAndLock();
    await this.ensureLedger();
    const receipt = await this.readReceipt(migration);
    if (receipt) this.assertReceipt(receipt, migration);
    return Boolean(receipt);
  }

  async applyOne(migration) {
    const existing = await this.readReceipt(migration);
    if (existing) {
      this.assertReceipt(existing, migration);
      return { path: migration.relativePath, status: 'skipped' };
    }

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      let stage = 'begin';
      try {
        await this.client.query('BEGIN');
        stage = 'sql';
        await this.client.query(migration.sql);
        stage = 'receipt';
        await this.client.query(
          `INSERT INTO ${LEDGER_SCHEMA}.${LEDGER_TABLE}
            (path, sha256, bytes, phase, execution_mode, source_sha)
           VALUES ($1, $2, $3, $4, 'APPLIED', $5)`,
          [
            migration.relativePath,
            migration.sha256,
            migration.bytes,
            migration.phase,
            this.sourceSha,
          ],
        );
        stage = 'commit';
        await this.client.query('COMMIT');
        return { path: migration.relativePath, status: 'applied' };
      } catch (error) {
        await this.client?.query('ROLLBACK').catch(() => undefined);
        if (stage !== 'commit' && !isConnectionFailure(error)) throw error;
        const committed = await this.recoverAfterUnknownOutcome(migration);
        if (committed) {
          return { path: migration.relativePath, reconciled: true, status: 'applied' };
        }
        if (attempt === 2) throw error;
      }
    }
    throw new Error(`Raw migration did not reach a terminal ledger state: ${migration.relativePath}`);
  }

  async applyAll(migrations) {
    const outcomes = [];
    for (const migration of migrations) outcomes.push(await this.applyOne(migration));
    return outcomes;
  }

  async close() {
    if (!this.client) return;
    try {
      await this.client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [LEDGER_LOCK_NAME]);
    } finally {
      await this.client.end();
      this.client = null;
    }
  }
}
