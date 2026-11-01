ALTER TABLE users
  DROP CONSTRAINT IF EXISTS users_role_check;

ALTER TABLE users
  ADD CONSTRAINT users_role_check
  CHECK (role IN ('admin', 'teacher', 'secretary', 'dos', 'parent', 'student'));

ALTER TABLE students
  ADD COLUMN IF NOT EXISTS academic_class_id INTEGER REFERENCES academic_classes(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS admission_date DATE,
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMP;

CREATE TABLE IF NOT EXISTS student_user_links (
  id SERIAL PRIMARY KEY,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  relationship VARCHAR(30) NOT NULL DEFAULT 'parent',
  can_view_results BOOLEAN NOT NULL DEFAULT TRUE,
  can_view_attendance BOOLEAN NOT NULL DEFAULT TRUE,
  is_primary BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (student_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_student_user_links_user ON student_user_links(user_id);

CREATE TABLE IF NOT EXISTS student_enrollments (
  id SERIAL PRIMARY KEY,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE RESTRICT,
  academic_year_id INTEGER NOT NULL REFERENCES academic_years(id) ON DELETE RESTRICT,
  class_id INTEGER NOT NULL REFERENCES academic_classes(id) ON DELETE RESTRICT,
  status VARCHAR(20) NOT NULL DEFAULT 'enrolled'
    CHECK (status IN ('enrolled', 'promoted', 'repeated', 'transferred', 'graduated', 'withdrawn')),
  start_date DATE NOT NULL DEFAULT CURRENT_DATE,
  end_date DATE,
  notes TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (end_date IS NULL OR end_date >= start_date)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_student_enrollments_one_open
  ON student_enrollments(student_id)
  WHERE end_date IS NULL;
CREATE INDEX IF NOT EXISTS idx_student_enrollments_class_year
  ON student_enrollments(class_id, academic_year_id, status);

CREATE TABLE IF NOT EXISTS attendance_sessions (
  id SERIAL PRIMARY KEY,
  class_id INTEGER NOT NULL REFERENCES academic_classes(id) ON DELETE RESTRICT,
  class_subject_id INTEGER REFERENCES class_subjects(id) ON DELETE SET NULL,
  attendance_date DATE NOT NULL,
  session_label VARCHAR(80),
  status VARCHAR(20) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'submitted', 'approved')),
  recorded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_attendance_sessions_unique
  ON attendance_sessions(class_id, COALESCE(class_subject_id, 0), attendance_date, COALESCE(session_label, ''));

CREATE TABLE IF NOT EXISTS attendance_records (
  id SERIAL PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES attendance_sessions(id) ON DELETE CASCADE,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE RESTRICT,
  status VARCHAR(20) NOT NULL CHECK (status IN ('present', 'absent', 'late', 'excused')),
  note VARCHAR(500),
  recorded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (session_id, student_id)
);

CREATE INDEX IF NOT EXISTS idx_attendance_records_student ON attendance_records(student_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS discipline_records (
  id SERIAL PRIMARY KEY,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE RESTRICT,
  incident_date DATE NOT NULL DEFAULT CURRENT_DATE,
  category VARCHAR(60) NOT NULL,
  severity VARCHAR(20) NOT NULL DEFAULT 'low' CHECK (severity IN ('low', 'medium', 'high')),
  description TEXT NOT NULL,
  action_taken TEXT,
  follow_up_date DATE,
  status VARCHAR(20) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'dismissed')),
  reported_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_discipline_records_student ON discipline_records(student_id, incident_date DESC);

CREATE TABLE IF NOT EXISTS student_transitions (
  id SERIAL PRIMARY KEY,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE RESTRICT,
  from_class_id INTEGER REFERENCES academic_classes(id) ON DELETE SET NULL,
  to_class_id INTEGER REFERENCES academic_classes(id) ON DELETE SET NULL,
  academic_year_id INTEGER REFERENCES academic_years(id) ON DELETE SET NULL,
  transition_type VARCHAR(20) NOT NULL
    CHECK (transition_type IN ('promoted', 'repeated', 'transferred', 'graduated', 'withdrawn', 'archived')),
  effective_date DATE NOT NULL DEFAULT CURRENT_DATE,
  reason TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_student_transitions_student ON student_transitions(student_id, effective_date DESC);

CREATE TABLE IF NOT EXISTS graduation_records (
  id SERIAL PRIMARY KEY,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE RESTRICT,
  academic_year_id INTEGER NOT NULL REFERENCES academic_years(id) ON DELETE RESTRICT,
  program_id INTEGER REFERENCES academic_programs(id) ON DELETE SET NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'eligible' CHECK (status IN ('eligible', 'completed', 'withheld')),
  graduation_date DATE,
  certificate_number VARCHAR(80) UNIQUE,
  remarks TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (student_id, academic_year_id)
);

CREATE TABLE IF NOT EXISTS student_documents (
  id SERIAL PRIMARY KEY,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  document_type VARCHAR(30) NOT NULL CHECK (document_type IN ('report_card', 'transcript', 'certificate')),
  academic_year_id INTEGER REFERENCES academic_years(id) ON DELETE SET NULL,
  term_id INTEGER REFERENCES academic_terms(id) ON DELETE SET NULL,
  file_path VARCHAR(1000) NOT NULL,
  content BYTEA,
  issued_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  issued_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_student_documents_student ON student_documents(student_id, issued_at DESC);

CREATE TABLE IF NOT EXISTS grade_scale (
  id SERIAL PRIMARY KEY,
  grade VARCHAR(10) NOT NULL UNIQUE,
  minimum_percentage NUMERIC(5, 2) NOT NULL CHECK (minimum_percentage >= 0 AND minimum_percentage <= 100),
  maximum_percentage NUMERIC(5, 2) NOT NULL CHECK (maximum_percentage >= 0 AND maximum_percentage <= 100),
  remark VARCHAR(80),
  is_passing BOOLEAN NOT NULL DEFAULT FALSE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  CHECK (minimum_percentage <= maximum_percentage)
);

INSERT INTO grade_scale (grade, minimum_percentage, maximum_percentage, remark, is_passing, sort_order)
VALUES
  ('A', 90, 100, 'Excellent', TRUE, 1),
  ('B', 80, 89.99, 'Very good', TRUE, 2),
  ('C', 70, 79.99, 'Good', TRUE, 3),
  ('D', 60, 69.99, 'Satisfactory', TRUE, 4),
  ('E', 50, 59.99, 'Pass', TRUE, 5),
  ('F', 0, 49.99, 'Fail', FALSE, 6)
ON CONFLICT (grade) DO NOTHING;

CREATE TABLE IF NOT EXISTS role_permissions (
  id SERIAL PRIMARY KEY,
  role VARCHAR(20) NOT NULL CHECK (role IN ('admin', 'teacher', 'secretary', 'dos', 'parent', 'student')),
  permission_key VARCHAR(100) NOT NULL,
  is_allowed BOOLEAN NOT NULL DEFAULT FALSE,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (role, permission_key)
);

CREATE TABLE IF NOT EXISTS school_admin_settings (
  key VARCHAR(100) PRIMARY KEY,
  value JSONB NOT NULL,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO school_admin_settings (key, value)
VALUES
  ('grading', '{"pass_percentage":50,"maximum_mark":100}'::jsonb),
  ('report_cards', '{"show_rank":true,"show_attendance":true,"show_remarks":true}'::jsonb),
  ('academic_rules', '{"allow_mark_edits_after_submission":false,"require_approval_before_publication":true}'::jsonb)
ON CONFLICT (key) DO NOTHING;

CREATE TABLE IF NOT EXISTS admin_audit_logs (
  id BIGSERIAL PRIMARY KEY,
  actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  actor_role VARCHAR(20),
  action VARCHAR(20) NOT NULL,
  resource VARCHAR(120) NOT NULL,
  resource_id VARCHAR(120),
  status_code INTEGER,
  request_id VARCHAR(100),
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_logs_created ON admin_audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_audit_logs_actor ON admin_audit_logs(actor_id, created_at DESC);

CREATE TABLE IF NOT EXISTS admin_backup_exports (
  id BIGSERIAL PRIMARY KEY,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  format VARCHAR(20) NOT NULL CHECK (format IN ('json')),
  record_counts JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
