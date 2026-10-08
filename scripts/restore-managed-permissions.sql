-- Logical archives omit role-specific ACLs to allow a different runtime role.
-- Reapply migration-defined PUBLIC restrictions in the restore transaction.
-- Missing routines are allowed for older archives; do not replay migrations.
DO $restore_managed_permissions$
DECLARE
  signature TEXT;
  target REGPROCEDURE;
BEGIN
  FOREACH signature IN ARRAY ARRAY[
    'public.audit_actor_pseudonym(text, text)',
    'public.block_audit_actor_identity_modification()',
    'public.block_deleted_user_session_auth()',
    'public.block_suspended_user_session_auth()',
    'public.block_user_deletion_with_live_availability_imports()',
    'public.cancel_tenant_staff_invitation_outbox()',
    'public.cancel_user_staff_invitation_outbox()',
    'public.cleanup_deleted_user_notification_outbox()',
    'public.clear_expired_mfa_enrollments(timestamp without time zone, integer, boolean)',
    'public.enforce_availability_import_final_handoff()',
    'public.enforce_tenant_export_artifact_cleanup()',
    'public.fence_session_mfa_enrollment()',
    'public.invalidate_deleted_user_auth_artifacts()',
    'public.invalidate_user_mfa_enrollments()',
    'public.purge_dormant_sessions(timestamp without time zone, integer)',
    'public.purge_expired_audit_logs(text)',
    'public.purge_expired_onboarding_signup_attempts(timestamp without time zone)',
    'public.purge_expired_password_reset_tokens(timestamp without time zone, integer)',
    'public.purge_expired_payroll_records(text)',
    'public.purge_payroll_operational_time_cards(text)',
    'public.purge_staff_invitation_outbox_diagnostics(timestamp without time zone, integer)',
    'public.redact_deleted_user_audit_records(text, text)',
    'public.redact_retained_tenant_audit_logs(text)',
    'public.revoke_suspended_user_sessions()',
    'public.scrub_deleted_user_row()',
    'public.set_audit_log_user_redaction_tenant(text)',
    'public.set_current_platform_admin(boolean, text)'
  ] LOOP
    target := to_regprocedure(signature);
    IF target IS NOT NULL THEN
      EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', target);
      IF EXISTS (
        SELECT 1 FROM pg_proc p,
          LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) acl
        WHERE p.oid = target AND acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
      ) THEN
        RAISE EXCEPTION 'Recovery did not restrict PUBLIC execution of %', signature;
      END IF;
    END IF;
  END LOOP;
  -- The legacy-import migration restricts every routine in its private schema.
  IF to_regnamespace('legacy_import') IS NOT NULL THEN
    REVOKE ALL ON ALL FUNCTIONS IN SCHEMA legacy_import FROM PUBLIC;
  END IF;
END;
$restore_managed_permissions$;
