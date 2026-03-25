SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS=0;

DROP TABLE IF EXISTS
  login_attempts,
  password_resets,
  mail_queue,
  settings,
  audit_logs,
  chore_required_skills,
  chore_excluded_positions,
  chore_allowed_positions,
  chores,
  shifts,
  staff,
  user_store_roles,
  user_company_roles,
  role_permissions,
  roles,
  users,
  stores,
  companies,
  break_templates,
  schedule_templates;

SET FOREIGN_KEY_CHECKS=1;

CREATE TABLE companies (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE break_templates (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  company_id INT UNSIGNED DEFAULT NULL,
  name VARCHAR(255) NOT NULL,
  break1_offset TINYINT UNSIGNED NOT NULL,
  break1_duration TINYINT UNSIGNED NOT NULL,
  lunch_offset TINYINT UNSIGNED NOT NULL,
  lunch_duration TINYINT UNSIGNED NOT NULL,
  break2_offset TINYINT UNSIGNED NOT NULL,
  break2_duration TINYINT UNSIGNED NOT NULL,
  UNIQUE KEY uniq_break_templates_company_name (company_id, name),
  INDEX idx_break_templates_company (company_id),
  CONSTRAINT fk_break_templates_company
    FOREIGN KEY (company_id) REFERENCES companies(id)
    ON UPDATE CASCADE ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO break_templates (
  company_id, name, break1_offset, break1_duration,
  lunch_offset, lunch_duration, break2_offset, break2_duration
) VALUES (
  NULL, 'Default', 2, 10, 4, 60, 2, 10
);

CREATE TABLE stores (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  company_id INT UNSIGNED NOT NULL,
  name VARCHAR(255) NOT NULL,
  location VARCHAR(255),
  INDEX idx_store_company (company_id),
  CONSTRAINT fk_stores_company
    FOREIGN KEY (company_id) REFERENCES companies(id)
    ON UPDATE CASCADE ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE users (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  company_id INT UNSIGNED NOT NULL,
  username VARCHAR(512) NOT NULL UNIQUE,
  usernameHash CHAR(64) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  locked_until TIMESTAMP NULL DEFAULT NULL,
  home_store_id INT UNSIGNED NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_users_company (company_id),
  INDEX idx_users_home_store (home_store_id),
  CONSTRAINT fk_users_store
    FOREIGN KEY (home_store_id) REFERENCES stores(id)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT fk_users_company
    FOREIGN KEY (company_id) REFERENCES companies(id)
    ON UPDATE CASCADE ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE roles (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(50) NOT NULL UNIQUE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE role_permissions (
  role_id INT UNSIGNED NOT NULL,
  permission VARCHAR(50) NOT NULL,
  PRIMARY KEY (role_id, permission),
  CONSTRAINT fk_role_permissions_role
    FOREIGN KEY (role_id) REFERENCES roles(id)
    ON UPDATE CASCADE ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE user_company_roles (
  user_id INT UNSIGNED NOT NULL,
  company_id INT UNSIGNED NOT NULL,
  role VARCHAR(50) NOT NULL,
  PRIMARY KEY (user_id, company_id, role),
  INDEX idx_ucr_company (company_id),
  CONSTRAINT fk_ucr_user
    FOREIGN KEY (user_id) REFERENCES users(id)
    ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT fk_ucr_company
    FOREIGN KEY (company_id) REFERENCES companies(id)
    ON UPDATE CASCADE ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE user_store_roles (
  user_id INT UNSIGNED NOT NULL,
  store_id INT UNSIGNED NOT NULL,
  role VARCHAR(50) NOT NULL,
  PRIMARY KEY (user_id, store_id, role),
  INDEX idx_usr_store (store_id),
  CONSTRAINT fk_usr_user
    FOREIGN KEY (user_id) REFERENCES users(id)
    ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT fk_usr_store
    FOREIGN KEY (store_id) REFERENCES stores(id)
    ON UPDATE CASCADE ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE staff (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  store_id INT UNSIGNED NULL,
  company_id INT UNSIGNED NOT NULL,
  name VARCHAR(512) NOT NULL,
  lunch_duration INT DEFAULT 30,
  pos VARCHAR(255),
  tasks TEXT,
  is_admin TINYINT(1) DEFAULT 0,
  INDEX idx_staff_store (store_id),
  INDEX idx_staff_company (company_id),
  CONSTRAINT fk_staff_store
    FOREIGN KEY (store_id) REFERENCES stores(id)
    ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT fk_staff_company
    FOREIGN KEY (company_id) REFERENCES companies(id)
    ON UPDATE CASCADE ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE shifts (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  staff_id INT UNSIGNED NULL,
  store_id INT UNSIGNED NOT NULL,
  date DATE NOT NULL,
  shift_hours VARCHAR(255),
  pos VARCHAR(255),
  break1 VARCHAR(255),
  break1_duration VARCHAR(255),
  lunch VARCHAR(255),
  lunch_duration VARCHAR(255),
  break2 VARCHAR(255),
  break2_duration VARCHAR(255),
  breaks JSON,
  tasks TEXT,
  sign_off VARCHAR(255),
  INDEX idx_shifts_staff (staff_id),
  INDEX idx_shifts_store (store_id),
  INDEX idx_shifts_date (date),
  CONSTRAINT fk_shifts_staff
    FOREIGN KEY (staff_id) REFERENCES staff(id)
    ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT fk_shifts_store
    FOREIGN KEY (store_id) REFERENCES stores(id)
    ON UPDATE CASCADE ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE chores (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  store_id INT UNSIGNED NOT NULL,
  name VARCHAR(255) NOT NULL DEFAULT '',
  instructions TEXT,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  priority INT NOT NULL DEFAULT 0,
  auto_assign_enabled TINYINT(1) NOT NULL DEFAULT 1,
  frequency ENUM('once', 'daily', 'weekly', 'monthly', 'per_shift') NOT NULL DEFAULT 'daily',
  recurrence_interval SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  active_days SET('sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat') DEFAULT NULL,
  window_start TIME DEFAULT NULL,
  window_end TIME DEFAULT NULL,
  daypart ENUM('open', 'mid', 'close', 'custom') DEFAULT NULL,
  exclude_closer TINYINT(1) NOT NULL DEFAULT 0,
  exclude_opener TINYINT(1) NOT NULL DEFAULT 0,
  lead_time_minutes SMALLINT UNSIGNED DEFAULT NULL,
  deadline_time TIME DEFAULT NULL,
  allow_multiple_assignees TINYINT(1) NOT NULL DEFAULT 0,
  max_per_day SMALLINT UNSIGNED DEFAULT NULL,
  max_per_shift SMALLINT UNSIGNED DEFAULT NULL,
  max_per_employee_per_day SMALLINT UNSIGNED DEFAULT NULL,
  min_staff_level SMALLINT UNSIGNED DEFAULT NULL,
  estimated_duration_minutes SMALLINT UNSIGNED DEFAULT NULL,
  created_by INT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  assigned_to INT UNSIGNED NULL,
  INDEX idx_chores_store (store_id),
  INDEX idx_chores_assigned_to (assigned_to),
  INDEX idx_chores_active (store_id, is_active),
  INDEX idx_chores_frequency (frequency),
  CONSTRAINT fk_chores_store
    FOREIGN KEY (store_id) REFERENCES stores(id)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT fk_chores_assigned
    FOREIGN KEY (assigned_to) REFERENCES staff(id)
    ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT fk_chores_created_by
    FOREIGN KEY (created_by) REFERENCES users(id)
    ON UPDATE CASCADE ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE audit_logs (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNSIGNED DEFAULT NULL,
  company_id INT UNSIGNED NOT NULL,
  action VARCHAR(50) NOT NULL,
  entity VARCHAR(50) NOT NULL,
  entity_id INT UNSIGNED,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_audit_company (company_id),
  INDEX idx_audit_user (user_id),
  CONSTRAINT fk_audit_user
    FOREIGN KEY (user_id) REFERENCES users(id)
    ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT fk_audit_company
    FOREIGN KEY (company_id) REFERENCES companies(id)
    ON UPDATE CASCADE ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE settings (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  scope ENUM('global','company','store') NOT NULL,
  store_id INT UNSIGNED DEFAULT NULL,
  company_id INT UNSIGNED DEFAULT NULL,
  name VARCHAR(50) NOT NULL,
  value TEXT,
  UNIQUE KEY uniq_settings_scope_company_store_name (scope, company_id, store_id, name),
  INDEX idx_settings_company (company_id),
  INDEX idx_settings_store (store_id),
  CONSTRAINT fk_settings_store
    FOREIGN KEY (store_id) REFERENCES stores(id)
    ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT fk_settings_company
    FOREIGN KEY (company_id) REFERENCES companies(id)
    ON UPDATE CASCADE ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE mail_queue (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(255) NOT NULL,
  store_id INT UNSIGNED NOT NULL,
  role VARCHAR(50) NOT NULL,
  template VARCHAR(100) NOT NULL DEFAULT 'invitation.txt',
  status ENUM('pending','sent','canceled') NOT NULL DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_mail_queue_store (store_id),
  CONSTRAINT fk_mail_queue_store
    FOREIGN KEY (store_id) REFERENCES stores(id)
    ON UPDATE CASCADE ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE password_resets (
  user_id INT UNSIGNED NOT NULL,
  token VARCHAR(64) NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  PRIMARY KEY (token),
  INDEX idx_password_resets_user (user_id),
  CONSTRAINT fk_password_resets_user
    FOREIGN KEY (user_id) REFERENCES users(id)
    ON UPDATE CASCADE ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE login_attempts (
  user_id INT UNSIGNED NOT NULL,
  ip VARCHAR(45) NOT NULL,
  attempts INT NOT NULL DEFAULT 0,
  last_attempt TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, ip),
  CONSTRAINT fk_login_attempts_user
    FOREIGN KEY (user_id) REFERENCES users(id)
    ON UPDATE CASCADE ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE schedule_templates (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL UNIQUE,
  payload TEXT NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT IGNORE INTO roles (name) VALUES
  ('super_admin'), ('company_admin'), ('store'),
  ('staff'), ('schedule'), ('chores');
