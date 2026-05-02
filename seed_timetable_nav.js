const pool = require('./db');

async function seedTimetableNavigation() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Add Time Tables as a top-level item between Academic and Staff
    await client.query(`
      INSERT INTO navigation_items (parent_id, label, href, sort_order, is_active)
      VALUES (NULL, 'Time Tables', '/timetables', 3.5, TRUE)
      ON CONFLICT DO NOTHING;
    `);

    // Update sort orders to ensure proper ordering
    await client.query(`UPDATE navigation_items SET sort_order = 3 WHERE label = 'Academic' AND parent_id IS NULL;`);
    await client.query(`UPDATE navigation_items SET sort_order = 5 WHERE label = 'Staff' AND parent_id IS NULL;`);
    await client.query(`UPDATE navigation_items SET sort_order = 6 WHERE label = 'Events' AND parent_id IS NULL;`);
    await client.query(`UPDATE navigation_items SET sort_order = 7 WHERE label = 'Announcements' AND parent_id IS NULL;`);
    await client.query(`UPDATE navigation_items SET sort_order = 8 WHERE label = 'Departments' AND parent_id IS NULL;`);
    await client.query(`UPDATE navigation_items SET sort_order = 9 WHERE label = 'Contact' AND parent_id IS NULL;`);

    await client.query('COMMIT');
    console.log(' Time Tables navigation added successfully!');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(' Error:', err.message);
  } finally {
    client.release();
    process.exit(0);
  }
}

seedTimetableNavigation();
