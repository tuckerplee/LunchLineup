# Chore Templates

Chore definitions graduated from plain text rows to structured templates so
managers can tune automation without re-entering tasks. The `scripts/schema.sql`
installer creates the following tables:

## `chores`

| Column | Type | Notes |
| ------ | ---- | ----- |
| `id` | `INT UNSIGNED` | Primary key. |
| `store_id` | `INT UNSIGNED` | Store that owns the template. |
| `name` | `VARCHAR(255)` | Display name for the chore. Defaults to an empty string for legacy inserts. |
| `instructions` | `TEXT` | Long-form guidance for staff completing the task. |
| `is_active` | `TINYINT(1)` | Soft-delete flag so templates can be archived. |
| `priority` | `INT` | Higher values float the chore earlier in auto-assign. |
| `auto_assign_enabled` | `TINYINT(1)` | Disable to keep a task manual even when auto-assign runs. |
| `frequency` | `ENUM('once','daily','weekly','monthly','per_shift')` | Base recurrence rule. |
| `recurrence_interval` | `SMALLINT UNSIGNED` | Multiplier for the frequency (e.g. every 2 weeks). |
| `active_days` | `SET('sun','mon','tue','wed','thu','fri','sat')` | Weekday filter for recurring chores. |
| `window_start` | `TIME` | Earliest time the chore can start. |
| `window_end` | `TIME` | Latest finishing time. |
| `daypart` | `ENUM('open','mid','close','custom')` | Named window used by the UI. |
| `exclude_closer` | `TINYINT(1)` | Skip staff tagged as closers when auto-assigning. |
| `exclude_opener` | `TINYINT(1)` | Skip staff tagged as openers when auto-assigning. |
| `lead_time_minutes` | `SMALLINT UNSIGNED` | Buffer required before the deadline. |
| `deadline_time` | `TIME` | Cut-off the chore must meet. |
| `allow_multiple_assignees` | `TINYINT(1)` | Whether multiple people can share the task. |
| `max_per_day` | `SMALLINT UNSIGNED` | Hard limit on daily occurrences. |
| `max_per_shift` | `SMALLINT UNSIGNED` | Limit within a single shift block. |
| `max_per_employee_per_day` | `SMALLINT UNSIGNED` | Cap on repeat assignments to the same worker. |
| `min_staff_level` | `SMALLINT UNSIGNED` | Minimum number of on-duty staff required before assigning. |
| `estimated_duration_minutes` | `SMALLINT UNSIGNED` | Used to budget workload. |
| `created_by` | `INT UNSIGNED` | Optional reference to the user who created the template. |
| `created_at` | `TIMESTAMP` | Auto-filled when inserted. |
| `updated_at` | `TIMESTAMP` | Auto-updated on change. |
| `assigned_to` | `INT UNSIGNED` | Legacy column retained until the assignment workflow is refactored. |
