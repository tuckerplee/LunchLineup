import type {
  SessionIdentity,
  WorkspaceGeneralSettingsUpdate,
  WorkspaceSecuritySettingsUpdate,
  WorkspaceSettings,
  WorkspaceTeamSettingsUpdate,
} from '@lunchlineup/api-contract';
import type { Prisma } from '@prisma/client';
import type { ApiV2Config } from '../config';
import type { TenantDatabase, TenantTransaction } from '../platform/database';
import { ProblemError } from '../platform/problem';

const WORKSPACE_SETTINGS_KEY = 'workspace_settings';
const DEFAULT_TIME_ZONE = 'America/New_York';
const DEFAULT_SESSION_TIMEOUT_MINUTES = 480;
const MAX_OIDC_ISSUER_URL_LENGTH = 2_000;

type StoredWorkspaceSettings = {
  general?: { timezone?: unknown };
  team?: { defaultInviteRole?: unknown; shiftApprovalPolicy?: unknown };
  security?: {
    requireMfaForAll?: unknown;
    sessionTimeoutMinutes?: unknown;
    ssoOidcOnly?: unknown;
    oidcIssuerUrl?: unknown;
  };
};

type SecurityAuditValue = {
  requireMfaForAll: boolean;
  sessionTimeoutMinutes: number;
  ssoOidcOnly: boolean;
  oidcIssuerConfigured: boolean;
};

function invalidInput(detail: string, code = 'invalid_workspace_settings'): ProblemError {
  return new ProblemError(422, code, detail, 'Workspace settings validation failed');
}

function requiredText(value: unknown, field: string, maximum: number): string {
  if (typeof value !== 'string') throw invalidInput(`${field} must be a string.`);
  const normalized = value.trim();
  if (!normalized) throw invalidInput(`${field} is required.`);
  if (normalized.length > maximum) throw invalidInput(`${field} must be at most ${maximum} characters.`);
  return normalized;
}

function normalizeTimeZone(value: unknown): string {
  const timeZone = requiredText(value, 'timezone', 100);
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(0);
    return timeZone;
  } catch {
    throw invalidInput('timezone must be a valid IANA timezone.', 'invalid_timezone');
  }
}

function normalizeOidcIssuerUrl(value: unknown): string | null {
  if (value === null) return null;
  const raw = requiredText(value, 'oidcIssuerUrl', MAX_OIDC_ISSUER_URL_LENGTH);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw invalidInput('oidcIssuerUrl must be a valid HTTP(S) URL.');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw invalidInput('oidcIssuerUrl must be a valid HTTP(S) URL without embedded credentials.');
  }
  return raw;
}

function storedSettings(value: unknown): StoredWorkspaceSettings {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as StoredWorkspaceSettings
    : {};
}

function safeTimeZone(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 100) return DEFAULT_TIME_ZONE;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value.trim() }).format(0);
    return value.trim();
  } catch {
    return DEFAULT_TIME_ZONE;
  }
}

function safeOidcIssuerUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > MAX_OIDC_ISSUER_URL_LENGTH) return null;
  try {
    const url = new URL(value.trim());
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? value.trim() : null;
  } catch {
    return null;
  }
}

function normalizeStored(
  tenant: { name: string; slug: string },
  value: unknown,
): WorkspaceSettings {
  const stored = storedSettings(value);
  const timeout = stored.security?.sessionTimeoutMinutes;
  return {
    general: {
      name: tenant.name,
      slug: tenant.slug,
      timezone: safeTimeZone(stored.general?.timezone),
    },
    team: {
      defaultInviteRole: stored.team?.defaultInviteRole === 'MANAGER' ? 'MANAGER' : 'STAFF',
      shiftApprovalPolicy: stored.team?.shiftApprovalPolicy === 'AUTO_APPROVE'
        ? 'AUTO_APPROVE'
        : stored.team?.shiftApprovalPolicy === 'ADMIN_APPROVAL'
          ? 'ADMIN_APPROVAL'
          : 'MANAGER_APPROVAL',
    },
    security: {
      requireMfaForAll: stored.security?.requireMfaForAll === true,
      sessionTimeoutMinutes: typeof timeout === 'number'
        && Number.isInteger(timeout)
        && timeout >= 5
        && timeout <= 1_440
        ? timeout
        : DEFAULT_SESSION_TIMEOUT_MINUTES,
      ssoOidcOnly: stored.security?.ssoOidcOnly === true,
      oidcIssuerUrl: safeOidcIssuerUrl(stored.security?.oidcIssuerUrl),
    },
  };
}

function securityAuditValue(settings: WorkspaceSettings['security']): SecurityAuditValue {
  return {
    requireMfaForAll: settings.requireMfaForAll,
    sessionTimeoutMinutes: settings.sessionTimeoutMinutes,
    ssoOidcOnly: settings.ssoOidcOnly,
    oidcIssuerConfigured: settings.oidcIssuerUrl !== null,
  };
}

function changed(before: SecurityAuditValue, after: SecurityAuditValue): boolean {
  return before.requireMfaForAll !== after.requireMfaForAll
    || before.sessionTimeoutMinutes !== after.sessionTimeoutMinutes
    || before.ssoOidcOnly !== after.ssoOidcOnly
    || before.oidcIssuerConfigured !== after.oidcIssuerConfigured;
}

/**
 * Native API-02 workspace settings owner. Tenant identity comes solely from
 * the API-v2 session boundary; saved JSON never controls tenant targeting.
 */
export class WorkspaceSettingsService {
  constructor(
    private readonly database: Pick<TenantDatabase, 'withTenant'>,
    private readonly config: Pick<ApiV2Config, 'oidcSsoAvailable'>,
  ) {}

  async get(identity: SessionIdentity): Promise<WorkspaceSettings> {
    return this.database.withTenant(identity.tenantId, (transaction) => this.read(transaction, identity.tenantId));
  }

  async updateGeneral(
    identity: SessionIdentity,
    body: WorkspaceGeneralSettingsUpdate,
  ): Promise<WorkspaceSettings> {
    const name = body.name === undefined ? undefined : requiredText(body.name, 'name', 200);
    const slug = body.slug === undefined ? undefined : requiredText(body.slug, 'slug', 128).toLowerCase();
    const timezone = body.timezone === undefined ? undefined : normalizeTimeZone(body.timezone);
    return this.database.withTenant(identity.tenantId, async (transaction) => {
      const current = await this.read(transaction, identity.tenantId);
      const tenant = name === undefined && slug === undefined
        ? current.general
        : await transaction.tenant.update({
          where: { id: identity.tenantId },
          data: { ...(name === undefined ? {} : { name }), ...(slug === undefined ? {} : { slug }) },
          select: { name: true, slug: true },
        });
      const next: WorkspaceSettings = {
        general: { name: tenant.name, slug: tenant.slug, timezone: timezone ?? current.general.timezone },
        team: current.team,
        security: current.security,
      };
      await this.persist(transaction, identity.tenantId, next);
      return next;
    });
  }

  async updateTeam(
    identity: SessionIdentity,
    body: WorkspaceTeamSettingsUpdate,
  ): Promise<WorkspaceSettings> {
    return this.database.withTenant(identity.tenantId, async (transaction) => {
      const current = await this.read(transaction, identity.tenantId);
      const next: WorkspaceSettings = {
        general: current.general,
        team: {
          defaultInviteRole: body.defaultInviteRole ?? current.team.defaultInviteRole,
          shiftApprovalPolicy: body.shiftApprovalPolicy ?? current.team.shiftApprovalPolicy,
        },
        security: current.security,
      };
      await this.persist(transaction, identity.tenantId, next);
      return next;
    });
  }

  async updateSecurity(
    identity: SessionIdentity,
    body: WorkspaceSecuritySettingsUpdate,
  ): Promise<WorkspaceSettings> {
    const issuer = body.oidcIssuerUrl === undefined ? undefined : normalizeOidcIssuerUrl(body.oidcIssuerUrl);
    return this.database.withTenant(identity.tenantId, async (transaction) => {
      const current = await this.read(transaction, identity.tenantId);
      const next: WorkspaceSettings = {
        general: current.general,
        team: current.team,
        security: {
          requireMfaForAll: body.requireMfaForAll ?? current.security.requireMfaForAll,
          sessionTimeoutMinutes: body.sessionTimeoutMinutes ?? current.security.sessionTimeoutMinutes,
          ssoOidcOnly: body.ssoOidcOnly ?? current.security.ssoOidcOnly,
          oidcIssuerUrl: issuer === undefined ? current.security.oidcIssuerUrl : issuer,
        },
      };
      if (next.security.ssoOidcOnly && !this.config.oidcSsoAvailable) {
        throw invalidInput(
          'SSO-only login requires OIDC to be enabled and configured for the API and web.',
          'oidc_not_configured',
        );
      }
      await this.persist(transaction, identity.tenantId, next);
      const before = securityAuditValue(current.security);
      const after = securityAuditValue(next.security);
      if (changed(before, after)) {
        await transaction.auditLog.create({
          data: {
            tenantId: identity.tenantId,
            userId: identity.sub,
            actorUserId: identity.sub,
            actorTenantId: identity.tenantId,
            action: 'SECURITY_POLICY_UPDATED',
            resource: 'TenantSecurityPolicy',
            resourceId: identity.tenantId,
            oldValue: before as Prisma.InputJsonValue,
            newValue: after as Prisma.InputJsonValue,
          },
        });
      }
      return next;
    });
  }

  private async read(transaction: TenantTransaction, tenantId: string): Promise<WorkspaceSettings> {
    const [tenant, setting] = await Promise.all([
      transaction.tenant.findUnique({
        where: { id: tenantId },
        select: { name: true, slug: true },
      }),
      transaction.tenantSetting.findUnique({
        where: { tenantId_key: { tenantId, key: WORKSPACE_SETTINGS_KEY } },
        select: { value: true },
      }),
    ]);
    if (!tenant) {
      throw new ProblemError(404, 'tenant_not_found', 'The workspace no longer exists.', 'Not found');
    }
    return normalizeStored(tenant, setting?.value);
  }

  private async persist(
    transaction: TenantTransaction,
    tenantId: string,
    settings: WorkspaceSettings,
  ): Promise<void> {
    await transaction.tenantSetting.upsert({
      where: { tenantId_key: { tenantId, key: WORKSPACE_SETTINGS_KEY } },
      create: { tenantId, key: WORKSPACE_SETTINGS_KEY, value: settings as Prisma.InputJsonValue },
      update: { value: settings as Prisma.InputJsonValue },
    });
  }
}
