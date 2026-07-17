import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { buildRawMigrationInventory } from '../../scripts/raw-migration-inventory.mjs';
import { RawMigrationLedgerSession } from '../../scripts/raw-migration-ledger.mjs';

const baselineSha = 'a'.repeat(40);
const sourceSha = 'b'.repeat(40);
const digest = 'c'.repeat(64);

function policy(historicalMigrations = {}) {
  return {
    version: 2,
    historicalBaselineSourceSha: baselineSha,
    historicalMigrations,
  };
}

function migration(overrides = {}) {
  return {
    bytes: 10,
    phase: 'post',
    relativePath: 'packages/db/prisma/migrations/20260717_test.sql',
    sha256: digest,
    sql: 'SELECT 42 /* migration-body */;',
    ...overrides,
  };
}

class FakeClient {
  constructor(state, options = {}) {
    this.state = state;
    this.options = { ...options };
    this.pending = null;
    this.ended = false;
  }

  async connect() {
    this.state.connects += 1;
  }

  async end() {
    this.ended = true;
    this.state.ends += 1;
  }

  async query(text, values = []) {
    const sql = String(text).replace(/\s+/g, ' ').trim();
    this.state.queries.push({ sql, values });

    if (sql === 'BEGIN') {
      this.pending = new Map(this.state.receipts);
      return { rows: [] };
    }
    if (sql === 'ROLLBACK') {
      this.pending = null;
      return { rows: [] };
    }
    if (sql === 'COMMIT') {
      const pending = this.pending;
      this.pending = null;
      const commitFailure = this.options.commitFailure;
      if (commitFailure) {
        this.options.commitFailure = null;
        if (commitFailure.committed && pending) this.state.receipts = pending;
        const error = new Error('connection lost while acknowledging COMMIT');
        error.code = 'ECONNRESET';
        throw error;
      }
      if (pending) this.state.receipts = pending;
      return { rows: [] };
    }
    if (sql.includes('COUNT(*)::integer AS count')) {
      return { rows: [{ count: this.state.receipts.size }] };
    }
    if (sql.includes('WHERE path = $1')) {
      const receipt = this.state.receipts.get(values[0]);
      return { rows: receipt ? [{ ...receipt }] : [] };
    }
    if (sql.startsWith('INSERT INTO lunchlineup_migrations.raw_migration_ledger')) {
      const [path, sha256, bytes, phase, recordedSourceSha] = values;
      const target = this.pending ?? this.state.receipts;
      target.set(path, {
        bytes,
        execution_mode: sql.includes("'BASELINED'") ? 'BASELINED' : 'APPLIED',
        path,
        phase,
        sha256,
        source_sha: recordedSourceSha,
      });
      return { rows: [] };
    }
    if (sql.includes('migration-body')) {
      this.state.bodyExecutions += 1;
      return { rows: [{ '?column?': 42 }] };
    }
    return { rows: [] };
  }
}

function fakeState(receipts = []) {
  return {
    bodyExecutions: 0,
    connects: 0,
    ends: 0,
    queries: [],
    receipts: new Map(receipts.map((receipt) => [receipt.path, receipt])),
  };
}

function directSession(state, clients = [new FakeClient(state)]) {
  const queue = [...clients];
  const session = new RawMigrationLedgerSession({
    baselineSourceSha: null,
    clientFactory: () => queue.shift(),
    databaseUrl: 'postgresql://unused',
    deploymentTarget: 'test',
    freshProductionConfirm: null,
    inventory: { all: [], post: [], pre: [] },
    policy: policy(),
    sourceSha,
  });
  session.client = queue.shift() ?? clients[0];
  return session;
}

test('matching receipts skip raw SQL and checksum drift fails before mutation', async () => {
  const entry = migration();
  const matching = {
    bytes: entry.bytes,
    execution_mode: 'APPLIED',
    path: entry.relativePath,
    phase: entry.phase,
    sha256: entry.sha256,
    source_sha: sourceSha,
  };
  const matchingState = fakeState([matching]);
  const matchingClient = new FakeClient(matchingState);
  const matchingSession = directSession(matchingState, [matchingClient]);
  assert.deepEqual(await matchingSession.applyOne(entry), {
    path: entry.relativePath,
    status: 'skipped',
  });
  assert.equal(matchingState.bodyExecutions, 0);

  const driftState = fakeState([{ ...matching, sha256: 'd'.repeat(64) }]);
  const driftClient = new FakeClient(driftState);
  const driftSession = directSession(driftState, [driftClient]);
  await assert.rejects(
    driftSession.applyOne(entry),
    /Raw migration checksum ledger mismatch/,
  );
  assert.equal(driftState.bodyExecutions, 0);
});

test('new raw SQL and its receipt commit atomically once', async () => {
  const state = fakeState();
  const client = new FakeClient(state);
  const session = directSession(state, [client]);
  const entry = migration();

  assert.deepEqual(await session.applyOne(entry), {
    path: entry.relativePath,
    status: 'applied',
  });
  assert.equal(state.bodyExecutions, 1);
  assert.deepEqual(state.receipts.get(entry.relativePath), {
    bytes: entry.bytes,
    execution_mode: 'APPLIED',
    path: entry.relativePath,
    phase: entry.phase,
    sha256: entry.sha256,
    source_sha: sourceSha,
  });
  assert.equal(state.queries.filter(({ sql }) => sql === 'COMMIT').length, 1);
});

test('unknown COMMIT acknowledgement reconnects and accepts only an exact receipt', async () => {
  const state = fakeState();
  const first = new FakeClient(state, { commitFailure: { committed: true } });
  const second = new FakeClient(state);
  const session = directSession(state, [first, second]);
  const entry = migration();

  assert.deepEqual(await session.applyOne(entry), {
    path: entry.relativePath,
    reconciled: true,
    status: 'applied',
  });
  assert.equal(state.bodyExecutions, 1);
  assert.equal(state.connects, 1);
  assert.equal(first.ended, true);
  assert.equal(state.receipts.get(entry.relativePath)?.sha256, entry.sha256);
});

test('unknown uncommitted outcome retries only after receipt absence is read back', async () => {
  const state = fakeState();
  const first = new FakeClient(state, { commitFailure: { committed: false } });
  const second = new FakeClient(state);
  const session = directSession(state, [first, second]);
  const entry = migration();

  assert.deepEqual(await session.applyOne(entry), {
    path: entry.relativePath,
    status: 'applied',
  });
  assert.equal(state.bodyExecutions, 2);
  const receiptReads = state.queries.filter(({ sql }) => sql.includes('WHERE path = $1'));
  assert.equal(receiptReads.length, 2);
  assert.equal(state.receipts.get(entry.relativePath)?.sha256, entry.sha256);
});

test('authenticated historical baseline records exact receipts without replaying SQL', async () => {
  const entry = migration({
    relativePath: 'packages/db/prisma/migrations/20260301_historical.sql',
  });
  const state = fakeState();
  const client = new FakeClient(state);
  const session = await RawMigrationLedgerSession.open({
    baselineSourceSha: baselineSha,
    clientFactory: () => client,
    databaseUrl: 'postgresql://unused',
    deploymentTarget: 'production',
    freshProductionConfirm: null,
    inventory: { all: [entry], post: [entry], pre: [] },
    policy: policy({ [entry.relativePath]: entry.sha256 }),
    sourceSha,
  });
  try {
    assert.equal(state.bodyExecutions, 0);
    assert.deepEqual(state.receipts.get(entry.relativePath), {
      bytes: entry.bytes,
      execution_mode: 'BASELINED',
      path: entry.relativePath,
      phase: entry.phase,
      sha256: entry.sha256,
      source_sha: baselineSha,
    });
  } finally {
    await session.close();
  }
});

test('empty production ledger requires an authenticated baseline or explicit fresh initialization', async () => {
  const state = fakeState();
  const client = new FakeClient(state);
  await assert.rejects(
    RawMigrationLedgerSession.open({
      baselineSourceSha: null,
      clientFactory: () => client,
      databaseUrl: 'postgresql://unused',
      deploymentTarget: 'production',
      freshProductionConfirm: null,
      inventory: { all: [], post: [], pre: [] },
      policy: policy(),
      sourceSha,
    }),
    /MIGRATION_FRESH_DATABASE_CONFIRM=initialize-fresh-production-ledger/,
  );
  assert.equal(client.ended, true);
});

test('inventory rejects migration-owned transaction boundaries before database access', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'lunchlineup-ledger-inventory-'));
  const migrationsRoot = join(scratch, 'packages/db/prisma/migrations');
  try {
    mkdirSync(migrationsRoot, { recursive: true });
    writeFileSync(join(migrationsRoot, '20260717_unsafe.sql'), 'BEGIN;\nSELECT 1;\nCOMMIT;\n');
    assert.throws(
      () => buildRawMigrationInventory(scratch, migrationsRoot),
      /top-level transaction control owned by the ledger runner/,
    );
  } finally {
    rmSync(scratch, { force: true, recursive: true });
  }
});
