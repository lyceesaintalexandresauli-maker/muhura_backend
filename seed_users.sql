-- Demo staff profiles for Supabase Auth migration.
-- Create the matching users in Supabase Auth first, using the same email addresses.
-- On first authenticated request, the backend will link auth_user_id automatically by matching email.

BEGIN;

INSERT INTO users (username, email, role, is_active)
VALUES
  ('cadeau', 'jirasubiza1@gmail.com', 'admin', TRUE),
  ('teacher', 'teacher@gmail.com', 'teacher', TRUE)
ON CONFLICT (email)
DO UPDATE
SET
  username = EXCLUDED.username,
  role = EXCLUDED.role,
  is_active = EXCLUDED.is_active;

DELETE FROM users WHERE role NOT IN ('admin', 'teacher');

COMMIT;
