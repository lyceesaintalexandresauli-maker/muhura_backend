const express = require('express');
const router = express.Router();
const pool = require('../db');
const { authenticateToken, authorizeRoles } = require('./auth');
const adminOnly = [authenticateToken, authorizeRoles('admin')];

const buildTree = (items, parentId = null) => {
  return items
    .filter((item) => item.parent_id === parentId)
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((item) => ({
      id: item.id,
      label: item.label,
      href: item.href,
      sort_order: item.sort_order,
      children: buildTree(items, item.id)
    }));
};

// Get flat navigation list
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, parent_id, label, href, sort_order FROM navigation_items WHERE is_active = TRUE ORDER BY sort_order, id'
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get navigation as tree
router.get('/tree', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, parent_id, label, href, sort_order FROM navigation_items WHERE is_active = TRUE ORDER BY sort_order, id'
    );
    res.json(buildTree(result.rows));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Create nav item
router.post('/', ...adminOnly, async (req, res) => {
  try {
    const { parent_id = null, label, href = null, sort_order = 0, is_active = true } = req.body;
    const result = await pool.query(
      `INSERT INTO navigation_items (parent_id, label, href, sort_order, is_active)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [parent_id, label, href, sort_order, is_active]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update nav item
router.put('/:id', ...adminOnly, async (req, res) => {
  try {
    const { id } = req.params;
    const { parent_id = null, label, href = null, sort_order = 0, is_active = true } = req.body;
    const result = await pool.query(
      `UPDATE navigation_items
       SET parent_id = $1, label = $2, href = $3, sort_order = $4, is_active = $5
       WHERE id = $6
       RETURNING *`,
      [parent_id, label, href, sort_order, is_active, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Navigation item not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Delete nav item
router.delete('/:id', ...adminOnly, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('DELETE FROM navigation_items WHERE id = $1 RETURNING *', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Navigation item not found' });
    }
    res.json({ message: 'Navigation item deleted' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
