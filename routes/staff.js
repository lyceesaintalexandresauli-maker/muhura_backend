const express = require('express');
const router = express.Router();
const pool = require('../db');
const { authenticateToken, authorizeRoles } = require('./auth');

const adminOnly = [authenticateToken, authorizeRoles('admin')];

// Get all staff
router.get('/', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM staff ORDER BY name');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get staff by department
router.get('/department/:dept', async (req, res) => {
  try {
    const { dept } = req.params;
    const result = await pool.query('SELECT * FROM staff WHERE department = $1 ORDER BY name', [dept]);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get staff by ID
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('SELECT * FROM staff WHERE id = $1', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Staff member not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Create new staff
router.post('/', ...adminOnly, async (req, res) => {
  try {
    const { name, position, department, bio, email, phone, image_path } = req.body;

    const result = await pool.query(
      'INSERT INTO staff (name, position, department, bio, image_path, email, phone) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *',
      [name, position, department, bio, image_path, email, phone]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update staff
router.put('/:id', ...adminOnly, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, position, department, bio, email, phone, image_path } = req.body;

    const result = await pool.query(
      'UPDATE staff SET name = $1, position = $2, department = $3, bio = $4, image_path = $5, email = $6, phone = $7 WHERE id = $8 RETURNING *',
      [name, position, department, bio, image_path, email, phone, id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Staff member not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Delete staff
router.delete('/:id', ...adminOnly, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('DELETE FROM staff WHERE id = $1 RETURNING *', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Staff member not found' });
    }
    res.json({ message: 'Staff member deleted' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
