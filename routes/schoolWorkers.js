const express = require('express');
const pool = require('../db');
const { authenticateToken, authorizeRoles } = require('./auth');

const router = express.Router();
const adminOnly = [authenticateToken, authorizeRoles('admin')];

// Admin: list all school workers
router.get('/', ...adminOnly, async (req, res) => {
  try {
    const { job_type, location, is_active } = req.query;
    
    let query = `
      SELECT id, name, location, phone_number, national_id, job_type, age, salary, is_active, created_at, updated_at
      FROM school_workers
      WHERE 1=1
    `;
    const params = [];
    let paramIndex = 1;

    if (job_type) {
      query += ` AND job_type = $${paramIndex}`;
      params.push(job_type);
      paramIndex++;
    }

    if (location) {
      query += ` AND location = $${paramIndex}`;
      params.push(location);
      paramIndex++;
    }

    if (is_active !== undefined) {
      query += ` AND is_active = $${paramIndex}`;
      params.push(is_active === 'true');
      paramIndex++;
    }

    query += ' ORDER BY created_at DESC';

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Admin: get single school worker
router.get('/:id', ...adminOnly, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      'SELECT id, name, location, phone_number, national_id, job_type, age, salary, is_active, created_at, updated_at FROM school_workers WHERE id = $1',
      [id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Worker not found' });
    }
    
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Admin: create school worker
router.post('/', ...adminOnly, async (req, res) => {
  try {
    const { name, location, phone_number, national_id, job_type, age, salary, is_active } = req.body;
    
    if (!name || !location || !phone_number || !national_id || !job_type || !age || !salary) {
      return res.status(400).json({ error: 'All fields except is_active are required' });
    }

    if (age < 18 || age > 70) {
      return res.status(400).json({ error: 'Age must be between 18 and 70' });
    }

    const result = await pool.query(
      `INSERT INTO school_workers (name, location, phone_number, national_id, job_type, age, salary, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, name, location, phone_number, national_id, job_type, age, salary, is_active, created_at, updated_at`,
      [name, location, phone_number, national_id, job_type, age, salary, is_active !== undefined ? is_active : true]
    );
    
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    if (err.code === '23505') {
      return res.status(400).json({ error: 'National ID already exists' });
    }
    res.status(500).json({ error: 'Server error' });
  }
});

// Admin: update school worker
router.put('/:id', ...adminOnly, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, location, phone_number, national_id, job_type, age, salary, is_active } = req.body;
    
    if (!name || !location || !phone_number || !national_id || !job_type || !age || !salary) {
      return res.status(400).json({ error: 'All fields except is_active are required' });
    }

    if (age < 18 || age > 70) {
      return res.status(400).json({ error: 'Age must be between 18 and 70' });
    }

    const result = await pool.query(
      `UPDATE school_workers
       SET name = $1, location = $2, phone_number = $3, national_id = $4, job_type = $5, age = $6, salary = $7, is_active = $8, updated_at = CURRENT_TIMESTAMP
       WHERE id = $9
       RETURNING id, name, location, phone_number, national_id, job_type, age, salary, is_active, created_at, updated_at`,
      [name, location, phone_number, national_id, job_type, age, salary, is_active !== undefined ? is_active : true, id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Worker not found' });
    }
    
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    if (err.code === '23505') {
      return res.status(400).json({ error: 'National ID already exists' });
    }
    res.status(500).json({ error: 'Server error' });
  }
});

// Admin: delete school worker
router.delete('/:id', ...adminOnly, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('DELETE FROM school_workers WHERE id = $1 RETURNING id', [id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Worker not found' });
    }
    
    res.json({ message: 'Worker deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
