ALTER TABLE examinations
  ADD COLUMN IF NOT EXISTS exam_date DATE;

ALTER TABLE examinations
  DROP CONSTRAINT IF EXISTS examinations_type_check;

ALTER TABLE examinations
  ADD CONSTRAINT examinations_type_check
  CHECK (type IN ('cat', 'practical', 'final', 'oral', 'supplementary', 'other'));
