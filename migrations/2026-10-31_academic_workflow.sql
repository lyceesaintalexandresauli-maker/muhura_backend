-- Academic module allocation and teacher marks workflow.
-- Safe additive migration: existing users, students, and published results are preserved.

CREATE TABLE IF NOT EXISTS academic_modules (
  id SERIAL PRIMARY KEY,
  module_code VARCHAR(30) NOT NULL,
  module_name VARCHAR(120) NOT NULL,
  program_code VARCHAR(10) NOT NULL CHECK (program_code IN ('SWD', 'NIT', 'CSA', 'ACC', 'FAD')),
  class_level VARCHAR(30) NOT NULL,
  teacher_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  academic_year VARCHAR(20) NOT NULL,
  term VARCHAR(30) NOT NULL,
  cat_weight NUMERIC(5,2) NOT NULL DEFAULT 30 CHECK (cat_weight >= 0 AND cat_weight <= 100),
  practical_weight NUMERIC(5,2) NOT NULL DEFAULT 20 CHECK (practical_weight >= 0 AND practical_weight <= 100),
  exam_weight NUMERIC(5,2) NOT NULL DEFAULT 50 CHECK (exam_weight >= 0 AND exam_weight <= 100),
  status VARCHAR(20) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted', 'generated')),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT academic_modules_weights_total CHECK (cat_weight + practical_weight + exam_weight = 100)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_academic_modules_code_class_term
  ON academic_modules (UPPER(TRIM(module_code)), class_level, academic_year, term);

CREATE UNIQUE INDEX IF NOT EXISTS idx_academic_modules_name_class_term
  ON academic_modules (LOWER(TRIM(module_name)), class_level, academic_year, term);

CREATE INDEX IF NOT EXISTS idx_academic_modules_teacher
  ON academic_modules (teacher_id, is_active, academic_year, term);

CREATE TABLE IF NOT EXISTS academic_marks (
  id SERIAL PRIMARY KEY,
  module_id INTEGER NOT NULL REFERENCES academic_modules(id) ON DELETE CASCADE,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  cat_score NUMERIC(6,2),
  practical_score NUMERIC(6,2),
  exam_score NUMERIC(6,2),
  final_score NUMERIC(7,2),
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (module_id, student_id),
  CHECK (cat_score IS NULL OR (cat_score >= 0 AND cat_score <= 100)),
  CHECK (practical_score IS NULL OR (practical_score >= 0 AND practical_score <= 100)),
  CHECK (exam_score IS NULL OR (exam_score >= 0 AND exam_score <= 100)),
  CHECK (final_score IS NULL OR (final_score >= 0 AND final_score <= 100))
);

CREATE INDEX IF NOT EXISTS idx_academic_marks_student ON academic_marks (student_id);
