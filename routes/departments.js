const express = require('express');
const router = express.Router();
const pool = require('../db');
const { authenticateToken, authorizeRoles } = require('./auth');
const adminOnly = [authenticateToken, authorizeRoles('admin')];

// Get all departments
router.get('/', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM departments ORDER BY name');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get department by id
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('SELECT * FROM departments WHERE id::text = $1 OR code = $1', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Department not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Create new department
router.post('/', ...adminOnly, async (req, res) => {
  try {
    const { name, code, description, image_path } = req.body;
    const result = await pool.query(
      'INSERT INTO departments (name, code, description, image_path) VALUES ($1, $2, $3, $4) RETURNING *',
      [name, code, description, image_path]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update department
router.put('/:id', ...adminOnly, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, code, description, image_path } = req.body;
    const result = await pool.query(
      'UPDATE departments SET name = $1, code = $2, description = $3, image_path = $4 WHERE id = $5 RETURNING *',
      [name, code, description, image_path, id]
    );
    if (result.rows.length === 0) {
      const fallback = await pool.query(
        'UPDATE departments SET name = $1, code = $2, description = $3, image_path = $4 WHERE code = $5 RETURNING *',
        [name, code, description, image_path, id]
      );
      if (fallback.rows.length === 0) {
        return res.status(404).json({ error: 'Department not found' });
      }
      return res.json(fallback.rows[0]);
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Delete department
router.delete('/:id', ...adminOnly, async (req, res) => {
  try {
    const { id } = req.params;
    let result = await pool.query('DELETE FROM departments WHERE id::text = $1 RETURNING *', [id]);
    if (result.rows.length === 0) {
      result = await pool.query('DELETE FROM departments WHERE code = $1 RETURNING *', [id]);
    }
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Department not found' });
    }
    res.json({ message: 'Department deleted' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
