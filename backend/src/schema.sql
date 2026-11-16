CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  employee_id TEXT UNIQUE NOT NULL DEFAULT ('EMP' || nextval('employee_number')),
  name VARCHAR(100) NOT NULL,
  email VARCHAR(254) UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  company VARCHAR(100) DEFAULT '',
  role VARCHAR(20) NOT NULL DEFAULT 'user',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS helpdesk_tickets (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title VARCHAR(150) NOT NULL,
  description TEXT NOT NULL,
  category VARCHAR(50) NOT NULL,
  priority VARCHAR(20) NOT NULL DEFAULT 'Medium',
  status VARCHAR(20) NOT NULL DEFAULT 'Open',
  attachment JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ticket_updates (
  id SERIAL PRIMARY KEY,
  ticket_id INTEGER NOT NULL REFERENCES helpdesk_tickets(id) ON DELETE CASCADE,
  author_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  message TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- New: departments
CREATE TABLE IF NOT EXISTS departments (
  name VARCHAR(50) PRIMARY KEY,
  sort_order INTEGER NOT NULL
);
INSERT INTO departments(name, sort_order) VALUES
  ('HR Department', 1),
  ('MERN Stack', 2),
  ('QA Testing', 3),
  ('AI Team', 4),
  ('DevOps', 5),
  ('BDE', 6),
  ('Customer Support', 7),
  ('Finance and Accounting', 8)
ON CONFLICT (name) DO UPDATE SET sort_order = EXCLUDED.sort_order;

ALTER TABLE users ADD COLUMN IF NOT EXISTS department VARCHAR(50) REFERENCES departments(name) ON UPDATE CASCADE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE helpdesk_tickets ADD COLUMN IF NOT EXISTS department VARCHAR(50) REFERENCES departments(name) ON UPDATE CASCADE;

-- New: each session belongs to one panel, so user and admin logins are independent
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS panel VARCHAR(10) NOT NULL DEFAULT 'user';

-- Existing tickets inherit their owner's department once it is known
UPDATE helpdesk_tickets t SET department = u.department
  FROM users u WHERE u.id = t.user_id AND t.department IS NULL AND u.department IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_tickets_user ON helpdesk_tickets(user_id);
CREATE INDEX IF NOT EXISTS idx_tickets_department ON helpdesk_tickets(department);
CREATE INDEX IF NOT EXISTS idx_updates_ticket ON ticket_updates(ticket_id);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);


-- Account verification and password recovery.
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT true;
CREATE TABLE IF NOT EXISTS email_verification_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_password_reset_user ON password_reset_tokens(user_id);

-- Persisted admin notifications for new employee tickets.
CREATE TABLE IF NOT EXISTS admin_notifications (
  id BIGSERIAL PRIMARY KEY,
  ticket_id INTEGER NOT NULL REFERENCES helpdesk_tickets(id) ON DELETE CASCADE,
  employee_name VARCHAR(100) NOT NULL,
  ticket_title VARCHAR(150) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_admin_notifications_created ON admin_notifications(created_at DESC);

-- Admin asset register and application settings.
CREATE TABLE IF NOT EXISTS assets (
  id BIGSERIAL PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  asset_tag VARCHAR(60) UNIQUE NOT NULL,
  category VARCHAR(60) NOT NULL,
  assigned_to VARCHAR(254),
  status VARCHAR(30) NOT NULL DEFAULT 'Available',
  notes TEXT DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS app_settings (
  setting_key VARCHAR(80) PRIMARY KEY,
  setting_value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO app_settings(setting_key,setting_value) VALUES
 ('notification_email_enabled','false'),
 ('system_name','IT Support Portal')
ON CONFLICT(setting_key) DO NOTHING;

-- Assets are assigned to an employee (name, Employee ID, department).
ALTER TABLE assets ADD COLUMN IF NOT EXISTS employee_name VARCHAR(100);
ALTER TABLE assets ADD COLUMN IF NOT EXISTS employee_id VARCHAR(30);
ALTER TABLE assets ADD COLUMN IF NOT EXISTS department VARCHAR(50);

-- Employee profiles created by the administrator.
CREATE TABLE IF NOT EXISTS employee_profiles (
  id BIGSERIAL PRIMARY KEY,
  employee_id VARCHAR(30) UNIQUE NOT NULL,
  name VARCHAR(100) NOT NULL,
  department VARCHAR(50) NOT NULL REFERENCES departments(name) ON UPDATE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Profile photo (small JPEG/PNG/WebP data URL).
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar TEXT;

-- Employee invitations: the admin registers an employee's email; only invited
-- emails can create an account in the Employee Panel.
ALTER TABLE employee_profiles ADD COLUMN IF NOT EXISTS email VARCHAR(254);
ALTER TABLE employee_profiles ADD COLUMN IF NOT EXISTS invite_token_hash TEXT;
ALTER TABLE employee_profiles ADD COLUMN IF NOT EXISTS invite_expires_at TIMESTAMPTZ;
ALTER TABLE employee_profiles ADD COLUMN IF NOT EXISTS invited_at TIMESTAMPTZ;
ALTER TABLE employee_profiles ADD COLUMN IF NOT EXISTS registered_at TIMESTAMPTZ;
ALTER TABLE employee_profiles ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_employee_profiles_email ON employee_profiles(lower(email)) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_employee_profiles_invite ON employee_profiles(invite_token_hash) WHERE invite_token_hash IS NOT NULL;

-- Fast lookup of the assets assigned to one employee (Employee Panel "My assets").
CREATE INDEX IF NOT EXISTS idx_assets_employee ON assets(upper(employee_id));

CREATE INDEX IF NOT EXISTS idx_assets_employee_norm ON assets(regexp_replace(upper(employee_id),'[^A-Z0-9]','','g'));
