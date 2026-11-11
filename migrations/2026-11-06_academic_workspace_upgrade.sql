-- Academic workspace upgrade (safe / additive).
-- Expands marks workflow: draft → submitted → under_review → returned | approved → generated → published
-- Preserves all existing academic_modules, academic_marks, students, users, and published results.

-- Expand status values on academic_modules
ALTER TABLE academic_modules DROP CONSTRAINT IF EXISTS academic_modules_status_check;
ALTER TABLE academic_modules
  ADD CONSTRAINT academic_modules_status_check
  CHECK (status IN (
    'draft',
    'submitted',
    'under_review',
    'returned',
    'approved',
    'generated',
    'locked',
    'published'
  ));

-- Optional review notes when admin returns a sheet
ALTER TABLE academic_modules
  ADD COLUMN IF NOT EXISTS review_notes TEXT,
  ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS approved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS returned_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS returned_by INTEGER REFERENCES users(id) ON DELETE SET NULL;

-- Audit log for academic changes
CREATE TABLE IF NOT EXISTS academic_audit_logs (
  id SERIAL PRIMARY KEY,
  actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action VARCHAR(80) NOT NULL,
  entity_type VARCHAR(60) NOT NULL,
  entity_id INTEGER,
  details JSONB,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_academic_audit_created
  ON academic_audit_logs (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_academic_modules_status
  ON academic_modules (status, is_active);

-- Levels catalogue (optional management UI; class_level codes remain the source of truth on students)
CREATE TABLE IF NOT EXISTS academic_levels (
  id SERIAL PRIMARY KEY,
  code VARCHAR(30) UNIQUE NOT NULL,
  name VARCHAR(120) NOT NULL,
  program_code VARCHAR(10) NOT NULL CHECK (program_code IN ('SWD', 'NIT', 'CSA', 'ACC', 'FAD')),
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO academic_levels (code, name, program_code, sort_order) VALUES
  ('L3SWD', 'L3 Software Development', 'SWD', 10),
  ('L4SWDA', 'L4 Software Development A', 'SWD', 20),
  ('L4SWDB', 'L4 Software Development B', 'SWD', 21),
  ('L5SWD', 'L5 Software Development', 'SWD', 30),
  ('L3NIT', 'L3 Networking & Internet Technology', 'NIT', 40),
  ('L4NITA', 'L4 Networking & Internet Technology A', 'NIT', 50),
  ('L4NITB', 'L4 Networking & Internet Technology B', 'NIT', 51),
  ('L5NIT', 'L5 Networking & Internet Technology', 'NIT', 60),
  ('L3CSA', 'L3 Computer Systems & Architecture', 'CSA', 70),
  ('L4CSA', 'L4 Computer Systems & Architecture', 'CSA', 80),
  ('L5CSA', 'L5 Computer Systems & Architecture', 'CSA', 90),
  ('L3FAD', 'L3 Fashion Design', 'FAD', 100),
  ('L4FAD', 'L4 Fashion Design', 'FAD', 110),
  ('L5FAD', 'L5 Fashion Design', 'FAD', 120),
  ('S4ACC', 'S4 Accounting', 'ACC', 130),
  ('S5ACC', 'S5 Accounting', 'ACC', 140),
  ('S6ACC', 'S6 Accounting', 'ACC', 150)
ON CONFLICT (code) DO NOTHING;
