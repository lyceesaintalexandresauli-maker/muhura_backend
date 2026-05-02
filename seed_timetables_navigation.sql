-- Add Time Tables navigation items
BEGIN;

-- Add Time Tables as a top-level item between Academic and Staff
INSERT INTO navigation_items (parent_id, label, href, sort_order, is_active)
VALUES 
  (NULL, 'Time Tables', '/timetables', 4, TRUE)
ON CONFLICT DO NOTHING;

-- Update sort orders to ensure proper ordering
UPDATE navigation_items SET sort_order = 1 WHERE label = 'Home' AND parent_id IS NULL;
UPDATE navigation_items SET sort_order = 2 WHERE label = 'About' AND parent_id IS NULL;
UPDATE navigation_items SET sort_order = 3 WHERE label = 'Academic' AND parent_id IS NULL;
UPDATE navigation_items SET sort_order = 4 WHERE label = 'Time Tables' AND parent_id IS NULL;
UPDATE navigation_items SET sort_order = 5 WHERE label = 'Staff' AND parent_id IS NULL;
UPDATE navigation_items SET sort_order = 6 WHERE label = 'Events' AND parent_id IS NULL;
UPDATE navigation_items SET sort_order = 7 WHERE label = 'Announcements' AND parent_id IS NULL;
UPDATE navigation_items SET sort_order = 8 WHERE label = 'Departments' AND parent_id IS NULL;
UPDATE navigation_items SET sort_order = 9 WHERE label = 'Contact' AND parent_id IS NULL;

COMMIT;
