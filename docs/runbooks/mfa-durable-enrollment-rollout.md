# Durable MFA enrollment rollout and qualification

This source is prepared locally. It has not been migrated, deployed, admitted
to native QA or approved for launch. VM4014 is excluded from all work; VM107
remains stopped with its launch hold, hook and onboot policy intact. Native QA
requires the protected VM218 integration receipt and fresh exclusive QA lease,
fresh bounded backing/parent capacity checks and one retained environment owner.

## Authority and lifecycle

Both retained enrollment route families (`/auth/mfa/enroll` and
`/auth/mfa/enrollment`, including confirmation aliases) delegate to the same
AuthService. It now uses Tenant → User → exact Session → current RBAC locks
and ReadCommitted for reads after waits. The challenge is an authenticated
`enc:v2` managed-key or configured legacy `enc:v1` envelope on that Session;
its randomized ciphertext identifies the generation. A paired UTC timestamp
provides its original 600-second deadline. Begin replaces the generation only
after current authorization and sets the deadline with the statement clock.
Confirmation rereads the current generation on every retry, binds the exact
ciphertext and deadline in a one-row consume, and commits proof, consume,
encrypted account secret, backup hashes and redacted audit together. Fresh UTC
statement-clock and session/TOTP checks after waits cause rollback on expiry.
These are source contracts, not native lock or commit-lifetime proof.

The new Session trigger clears the pair on retained revocation and rejects
session ID/user rebinding. It composes with existing User deletion/suspension
revocation triggers and runtime anonymizers. The User trigger clears every
pending generation on MFA enabled/secret or tenant changes, including other
active sessions; physical Session deletion removes the pair. Same-session
refresh does not extend the enrollment deadline. Neither trigger acquires a
User/Tenant lock from a Session lock. Native contention and trigger/RLS behavior
still require explicit isolated qualification.

`applyDormantSessionRetention` calls the separate pending-only sweep even when
no dormant Session is eligible. Its `pendingEnrollmentRetention` receipt reports
separate eligible/cleared counts; existing dormant deletion counts/grace remain.
The capability-gated SQL sweep counts in dry-run, clears at most the approved
batch of expired pairs with SKIP LOCKED, rechecks the current cutoff and leaves
refresh credentials and otherwise active Sessions intact. A clamped UTC cutoff
prevents future cleanup from clearing fresh challenges. Existing scheduler
cadence and missed-run recovery must be measured before launch; this change
installs no timer or background job and promises no ten-minute physical erasure.

## Coherent upgrade requirements

1. In an admitted isolated target, verify backups/restore and the exact reviewed
   source, raw migration inventory, role grants and key configuration. Preserve
   current key plus deliberate previous/legacy decrypt overlap. Enrollment
   requires an encrypted write key even in development; previous-only reads
   cannot authorize a plaintext account write.
2. Quiesce both retained enrollment route families and all replicas of their
   AuthService owner. Upgrade the additive schema/migration and retained owner,
   along with the retention owner, as one coordinated change. Old code tolerates
   nullable columns but still trusts Redis and is unsafe in a mixed fleet. New
   code on old schema fails rather than reverting to Redis. Generated Prisma
   must be reconciled in the later authorized build; local source uses typed raw
   SQL for the new fields and does not generate dependencies here.
3. Old Redis-only pending challenges cannot be confirmed by the new owner.
   Testers must restart enrollment. The owner has no pending Redis GET/SET/DEL
   fallback; do not reuse old pending material. Ordinary Redis `session_mfa`
   markers remain separate best-effort postcommit authorization observations.
   A failed marker preserves the committed backup-code response but does not
   prove a verified protected-route session.
4. Verify the same complete candidate through both aliases and API-v2 forwarding,
   with the native controls below, before admitting private testers. A failed
   qualification retains the hold. A rollback must quiesce enrollment and retain
   the additive schema; restoring Redis-only enrollment reopens the known race
   and is not an acceptable security rollback.

## Required native evidence

Use independent DB readback with real restricted roles and non-UTC connection
timezone: new schema and already-populated migration, pair/encryption/revoked
constraints, exact immutable ownership, capability denial, trigger grants/RLS,
true Tenant/User/Session/RBAC contention and bounded conflict retry. Exercise
begin A → waiting confirm A → begin B; neither A nor stale retries may consume B.
Cross deadline equality during locks, proof, CAS, enable, audit and commit delay;
validate statement UTC clocks, rollback and pending/active ciphertext secrecy.
Test current session/PIN/account/tenant/role denial and both encrypted key formats,
rotation overlap, previous-only refusal and unreadable ciphertext.

Exercise every connected retained revocation/deletion/recovery/role/tenant owner
and other-session invalidation, refresh lifetime preservation, physical deletion,
active expired-pair cleanup, dry-run counts, batch limits, locked-row skipping,
replacement-generation survival and unauthorized sweep refusal. Verify no
Session→User/Tenant lock reversal with actual concurrent writers. Qualify key
custody, backups/restore, migration compatibility, timer cadence/alerts, response
loss and one-time backup-code custody in a real browser. Controlled local ledger
adapters do not prove PostgreSQL, Redis, provider or browser behavior. All full
acceptance actions and months of private testing remain required.
