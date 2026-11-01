CREATE TABLE IF NOT EXISTS academic_years (
  id SERIAL PRIMARY KEY,
  name VARCHAR(20) NOT NULL UNIQUE,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  is_current BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (start_date <= end_date)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_academic_years_single_current
  ON academic_years (is_current)
  WHERE is_current = TRUE;

CREATE TABLE IF NOT EXISTS academic_terms (
  id SERIAL PRIMARY KEY,
  academic_year_id INTEGER NOT NULL REFERENCES academic_years(id) ON DELETE CASCADE,
  name VARCHAR(40) NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'upcoming')),
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (academic_year_id, name),
  CHECK (start_date <= end_date)
);

CREATE TABLE IF NOT EXISTS academic_programs (
  id SERIAL PRIMARY KEY,
  code VARCHAR(10) NOT NULL UNIQUE,
  name VARCHAR(100) NOT NULL,
  description TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS academic_classes (
  id SERIAL PRIMARY KEY,
  program_id INTEGER NOT NULL REFERENCES academic_programs(id) ON DELETE RESTRICT,
  name VARCHAR(100) NOT NULL,
  level VARCHAR(50) NOT NULL,
  section VARCHAR(30),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (program_id, level, section)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_academic_classes_unique_section
  ON academic_classes (program_id, level, COALESCE(section, ''));

CREATE TABLE IF NOT EXISTS academic_subjects (
  id SERIAL PRIMARY KEY,
  code VARCHAR(20) NOT NULL UNIQUE,
  name VARCHAR(100) NOT NULL,
  max_score NUMERIC(7, 2) NOT NULL DEFAULT 100 CHECK (max_score > 0),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS class_subjects (
  id SERIAL PRIMARY KEY,
  class_id INTEGER NOT NULL REFERENCES academic_classes(id) ON DELETE RESTRICT,
  subject_id INTEGER NOT NULL REFERENCES academic_subjects(id) ON DELETE RESTRICT,
  academic_year_id INTEGER NOT NULL REFERENCES academic_years(id) ON DELETE RESTRICT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (class_id, subject_id, academic_year_id)
);

CREATE TABLE IF NOT EXISTS teacher_assignments (
  id SERIAL PRIMARY KEY,
  teacher_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  class_subject_id INTEGER NOT NULL REFERENCES class_subjects(id) ON DELETE CASCADE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (teacher_id, class_subject_id)
);

CREATE TABLE IF NOT EXISTS examinations (
  id SERIAL PRIMARY KEY,
  class_subject_id INTEGER NOT NULL REFERENCES class_subjects(id) ON DELETE RESTRICT,
  term_id INTEGER NOT NULL REFERENCES academic_terms(id) ON DELETE RESTRICT,
  title VARCHAR(120) NOT NULL,
  type VARCHAR(20) NOT NULL CHECK (type IN ('cat', 'practical', 'final', 'other')),
  weight NUMERIC(5, 2) NOT NULL CHECK (weight > 0 AND weight <= 100),
  max_score NUMERIC(7, 2) NOT NULL CHECK (max_score > 0),
  status VARCHAR(20) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'submitted', 'approved', 'published')),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (class_subject_id, term_id, title)
);

CREATE TABLE IF NOT EXISTS examination_marks (
  id SERIAL PRIMARY KEY,
  examination_id INTEGER NOT NULL REFERENCES examinations(id) ON DELETE CASCADE,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  score NUMERIC(7, 2),
  is_absent BOOLEAN NOT NULL DEFAULT FALSE,
  status VARCHAR(20) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted', 'approved', 'published')),
  entered_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  approved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  approved_at TIMESTAMP,
  published_at TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (examination_id, student_id),
  CHECK (
    (is_absent = TRUE AND score IS NULL)
    OR (is_absent = FALSE AND score IS NOT NULL AND score >= 0)
  )
);

CREATE INDEX IF NOT EXISTS idx_academic_terms_year ON academic_terms(academic_year_id);
CREATE INDEX IF NOT EXISTS idx_class_subjects_year ON class_subjects(academic_year_id);
CREATE INDEX IF NOT EXISTS idx_teacher_assignments_teacher ON teacher_assignments(teacher_id);
CREATE INDEX IF NOT EXISTS idx_examinations_subject_term ON examinations(class_subject_id, term_id);
CREATE INDEX IF NOT EXISTS idx_examination_marks_exam_status ON examination_marks(examination_id, status);
