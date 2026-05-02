const express = require('express');
const router = express.Router();
const pool = require('../db');
const { authenticateToken, authorizeRoles } = require('./auth');
const adminOnly = [authenticateToken, authorizeRoles('admin')];
const toSectionsMap = (rows = []) =>
  rows.reduce((acc, row) => {
    const key = row.section || 'default';
    if (!acc[key]) acc[key] = row;
    return acc;
  }, {});

const buildNavTree = (items, parentId = null) => {
  return items
    .filter((item) => item.parent_id === parentId)
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((item) => ({
      id: item.id,
      label: item.label,
      href: item.href,
      sort_order: item.sort_order,
      children: buildNavTree(items, item.id)
    }));
};

// Get all site settings as key-value object
router.get('/settings', async (req, res) => {
  try {
    const result = await pool.query('SELECT key, value FROM site_settings ORDER BY key');
    const settings = result.rows.reduce((acc, row) => {
      acc[row.key] = row.value;
      return acc;
    }, {});
    res.json(settings);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Bootstrap data for frontend: settings + navigation (+ optional page content)
router.get('/bootstrap', async (req, res) => {
  try {
    const page = req.query.page;

    const [settingsResult, navResult] = await Promise.all([
      pool.query('SELECT key, value FROM site_settings ORDER BY key'),
      pool.query(
        'SELECT id, parent_id, label, href, sort_order FROM navigation_items WHERE is_active = TRUE ORDER BY sort_order, id'
      )
    ]);

    const settings = settingsResult.rows.reduce((acc, row) => {
      acc[row.key] = row.value;
      return acc;
    }, {});

    let content = [];
    if (page) {
      const contentResult = await pool.query(
        'SELECT * FROM content WHERE page = $1 ORDER BY section, id',
        [page]
      );
      content = contentResult.rows;
    }

    res.json({
      settings,
      navigation: buildNavTree(navResult.rows),
      content,
      content_sections: toSectionsMap(content)
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Upsert a site setting
router.put('/settings/:key', ...adminOnly, async (req, res) => {
  try {
    const { key } = req.params;
    const { value } = req.body;
    const result = await pool.query(
      `INSERT INTO site_settings (key, value, updated_at)
       VALUES ($1, $2, CURRENT_TIMESTAMP)
       ON CONFLICT (key)
       DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP
       RETURNING *`,
      [key, value]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
