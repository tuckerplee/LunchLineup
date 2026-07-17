export type BillingOperationClassification = 'control' | 'recovery' | 'value';
export type BillingAccessPattern =
    | 'entitlement_only'
    | 'exact_credit'
    | 'custom_exact_credit'
    | 'permission_only';

export type BillingOperationPolicy = {
    classification: BillingOperationClassification;
    accessPattern: BillingAccessPattern;
    feature: 'scheduling' | 'lunch_breaks' | 'time_cards' | 'webhooks' | null;
    launchStatus: 'verified';
    rationale: string;
};

/**
 * Machine-readable classification for deliberate zero-settlement mutations and
 * the value-producing operations that own an exact positive-credit settlement.
 * New value operations must not be added as entitlement-only controls.
 */
export const BILLING_OPERATION_POLICY = {
    'schedules.demand_windows.replace': {
        classification: 'control', accessPattern: 'entitlement_only', feature: 'scheduling', launchStatus: 'verified',
        rationale: 'Edits solver input configuration but does not generate shifts or publish a schedule.',
    },
    'schedules.create': {
        classification: 'control', accessPattern: 'entitlement_only', feature: 'scheduling', launchStatus: 'verified',
        rationale: 'Creates an empty draft planning container; no generated or published output is produced.',
    },
    'schedules.delete_draft': {
        classification: 'control', accessPattern: 'entitlement_only', feature: 'scheduling', launchStatus: 'verified',
        rationale: 'Removes an unpublished draft and creates no customer value output.',
    },
    'schedules.reopen': {
        classification: 'recovery', accessPattern: 'entitlement_only', feature: 'scheduling', launchStatus: 'verified',
        rationale: 'Returns an existing publication to draft for correction without producing a new result.',
    },
    'schedules.shift.delete_draft': {
        classification: 'control', accessPattern: 'entitlement_only', feature: 'scheduling', launchStatus: 'verified',
        rationale: 'Edits a draft schedule and does not solve or publish it.',
    },
    'schedules.auto_schedule': {
        classification: 'value', accessPattern: 'custom_exact_credit', feature: 'scheduling', launchStatus: 'verified',
        rationale: 'Generates solved shifts and atomically reserves one immutable job-bound credit debit.',
    },
    'schedules.publish': {
        classification: 'value', accessPattern: 'exact_credit', feature: 'scheduling', launchStatus: 'verified',
        rationale: 'Publishes a usable schedule and settles the confirmed schedule and delivery costs exactly once.',
    },
    'shifts.create': {
        classification: 'value', accessPattern: 'exact_credit', feature: 'scheduling', launchStatus: 'verified',
        rationale: 'Creates a usable manual shift and settles the idempotent creation operation exactly once.',
    },
    'shifts.update': {
        classification: 'value', accessPattern: 'exact_credit', feature: 'scheduling', launchStatus: 'verified',
        rationale: 'Persists a material manual shift change and settles the idempotent update operation exactly once.',
    },
    'shifts.bulk_assign': {
        classification: 'value', accessPattern: 'exact_credit', feature: 'scheduling', launchStatus: 'verified',
        rationale: 'Persists a bulk assignment result and settles the idempotent assignment operation exactly once.',
    },
    'lunch_breaks.policy.update': {
        classification: 'control', accessPattern: 'entitlement_only', feature: 'lunch_breaks', launchStatus: 'verified',
        rationale: 'Changes policy configuration but does not generate or apply break output.',
    },
    'lunch_breaks.generate': {
        classification: 'value', accessPattern: 'exact_credit', feature: 'lunch_breaks', launchStatus: 'verified',
        rationale: 'Generates persisted break output and uses an operation-bound exact credit settlement.',
    },
    'lunch_breaks.setup_shifts': {
        classification: 'value', accessPattern: 'exact_credit', feature: 'scheduling', launchStatus: 'verified',
        rationale: 'Creates usable scheduling rows and settles each semantic request exactly once.',
    },
    'lunch_breaks.shift_breaks.replace': {
        classification: 'value', accessPattern: 'exact_credit', feature: 'lunch_breaks', launchStatus: 'verified',
        rationale: 'Persists replacement break output and settles the idempotent mutation exactly once.',
    },
    'webhooks.endpoint.create': {
        classification: 'control', accessPattern: 'entitlement_only', feature: 'webhooks', launchStatus: 'verified',
        rationale: 'Configures a destination; delivery is the separately charged value operation.',
    },
    'webhooks.endpoint.update': {
        classification: 'control', accessPattern: 'entitlement_only', feature: 'webhooks', launchStatus: 'verified',
        rationale: 'Changes destination configuration without sending an event.',
    },
    'webhooks.endpoint.rotate_secret': {
        classification: 'recovery', accessPattern: 'entitlement_only', feature: 'webhooks', launchStatus: 'verified',
        rationale: 'Rotates credentials without delivering an event.',
    },
    'webhooks.endpoint.delete': {
        classification: 'control', accessPattern: 'entitlement_only', feature: 'webhooks', launchStatus: 'verified',
        rationale: 'Disables a destination without producing outbound value.',
    },
    'webhooks.delivery': {
        classification: 'value', accessPattern: 'exact_credit', feature: 'webhooks', launchStatus: 'verified',
        rationale: 'Delivers an event and requires one exact negative debit before any send.',
    },
    'time_cards.clock_in': {
        classification: 'value', accessPattern: 'exact_credit', feature: 'time_cards', launchStatus: 'verified',
        rationale: 'Creates an open time card and settles the operation-bound clock-in debit exactly once.',
    },
    'availability_imports.create': {
        classification: 'value', accessPattern: 'exact_credit', feature: 'scheduling', launchStatus: 'verified',
        rationale: 'Creates a durable parsing job and settles its import-bound credit debit exactly once.',
    },
    'payroll.policy.update': {
        classification: 'control', accessPattern: 'permission_only', feature: null, launchStatus: 'verified',
        rationale: 'Maintains payroll policy source data and creates no calculated artifact.',
    },
    'payroll.period.create_adopt_review_decide_lock': {
        classification: 'control', accessPattern: 'permission_only', feature: null, launchStatus: 'verified',
        rationale: 'Maintains and freezes compliance records; lock aggregates evidence but does not create a customer export.',
    },
    'payroll.amend_and_decide': {
        classification: 'control', accessPattern: 'permission_only', feature: null, launchStatus: 'verified',
        rationale: 'Corrects and approves retained payroll evidence without producing an export.',
    },
    'payroll.reconciliation': {
        classification: 'recovery', accessPattern: 'permission_only', feature: null, launchStatus: 'verified',
        rationale: 'Reconciles an already charged export and must never charge again.',
    },
    'payroll.export.create': {
        classification: 'value', accessPattern: 'exact_credit', feature: 'time_cards', launchStatus: 'verified',
        rationale: 'Creates the calculated CSV artifact only after an enabled paid-and-credit gate and exact operation-bound debit.',
    },
    'staff.invitation_and_user_controls': {
        classification: 'control', accessPattern: 'permission_only', feature: null, launchStatus: 'verified',
        rationale: 'Manages identity, access, and delivery intent rather than billable work output.',
    },
} as const satisfies Record<string, BillingOperationPolicy>;
