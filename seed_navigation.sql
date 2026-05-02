-- Seed navigation and shared site settings from old HTML site
BEGIN;

TRUNCATE TABLE navigation_items RESTART IDENTITY CASCADE;

INSERT INTO navigation_items (id, parent_id, label, href, sort_order, is_active) VALUES
  (1, NULL, 'Home', '/index', 1, TRUE),
  (2, NULL, 'About', '/about', 2, TRUE),
  (3, NULL, 'Academic', '/academic', 3, TRUE),
  (4, NULL, 'Staff', '/trainers', 4, TRUE),
  (5, NULL, 'Events', '/events', 5, TRUE),
  (6, NULL, 'Announcements', '/anouncement', 6, TRUE),
  (7, NULL, 'Departments', NULL, 7, TRUE),
  (8, 7, 'Fashion Design (FAD)', '/fad', 1, TRUE),
  (9, 7, 'Accounting', '/acc', 2, TRUE),
  (10, 7, 'ICT', NULL, 3, TRUE),
  (11, 10, 'Software Development (SOD)', '/sod', 1, TRUE),
  (12, 10, 'Computer Systems & Architecture (CSA)', '/csa', 2, TRUE),
  (13, 10, 'Networking & Internet Technology (NIT)', '/nit', 3, TRUE),
  (14, NULL, 'Contact', '/contact', 8, TRUE),
  (15, NULL, 'Login', '/login', 9, TRUE);

SELECT setval('navigation_items_id_seq', (SELECT MAX(id) FROM navigation_items));

INSERT INTO site_settings (key, value, updated_at) VALUES
  ('school_name', 'Lycee St Alexandre Sauli De Muhura', CURRENT_TIMESTAMP),
  ('school_subtitle', 'Peres Barnabites', CURRENT_TIMESTAMP),
  ('logo_path', '/assets/img/logo1.jpg', CURRENT_TIMESTAMP),
  ('primary_email', 'lycemuhur@gmail.com', CURRENT_TIMESTAMP),
  ('address', 'Rwanda, Eastern Province, Gatsibo District, Muhura Sector, Taba Cell, Kanyinya Village', CURRENT_TIMESTAMP),
  ('login_path', '/login', CURRENT_TIMESTAMP)
ON CONFLICT (key)
DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP;

COMMIT;