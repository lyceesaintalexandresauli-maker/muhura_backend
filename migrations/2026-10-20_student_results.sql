ALTER TABLE users
  DROP CONSTRAINT IF EXISTS users_role_check;

ALTER TABLE users
  ADD CONSTRAINT users_role_check
  CHECK (role IN ('admin', 'teacher', 'secretary', 'dos', 'parent'));

CREATE TABLE IF NOT EXISTS student_results (
  id SERIAL PRIMARY KEY,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  program_code VARCHAR(10) NOT NULL CHECK (program_code IN ('SWD', 'NIT', 'CSA', 'ACC', 'FAD')),
  academic_year VARCHAR(20) NOT NULL,
  term VARCHAR(30) NOT NULL,
  remarks TEXT,
  is_published BOOLEAN NOT NULL DEFAULT FALSE,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (student_id, program_code, academic_year, term)
);

CREATE TABLE IF NOT EXISTS student_result_subjects (
  id SERIAL PRIMARY KEY,
  result_id INTEGER NOT NULL REFERENCES student_results(id) ON DELETE CASCADE,
  subject_name VARCHAR(100) NOT NULL,
  score NUMERIC(7, 2) NOT NULL CHECK (score >= 0),
  max_score NUMERIC(7, 2) NOT NULL CHECK (max_score > 0 AND score <= max_score)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_student_result_subjects_unique_name
  ON student_result_subjects (result_id, LOWER(TRIM(subject_name)));
CREATE INDEX IF NOT EXISTS idx_student_results_lookup
  ON student_results (program_code, academic_year, term, is_published);
