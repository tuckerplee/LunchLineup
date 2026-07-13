-- Add the time-card RBAC category before any migration inserts rows that use it.

ALTER TYPE "PermissionCategory" ADD VALUE IF NOT EXISTS 'TIME_CARDS';
