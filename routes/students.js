const express = require('express');
const router = express.Router();
const pool = require('../db');
const { authenticateToken, authorizeRoles } = require('./auth');

const adminOnly = [authenticateToken, authorizeRoles('admin')];

// Admin: get all students
router.get('/', ...adminOnly, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM students ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Admin: get student by id
router.get('/:id', ...adminOnly, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('SELECT * FROM students WHERE id = $1', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Student not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Admin: create student
router.post('/', ...adminOnly, async (req, res) => {
  try {
    const {
      student_code,
      first_name,
      last_name,
      gender,
      date_of_birth,
      class_level,
      department,
      parent_name,
      parent_phone,
      email,
      address,
      image_path,
      is_active = true
    } = req.body;

    if (!student_code || !first_name || !last_name) {
      return res.status(400).json({ error: 'student_code, first_name and last_name are required' });
    }

    const result = await pool.query(
      `INSERT INTO students (
         student_code, first_name, last_name, gender, date_of_birth, class_level, department,
         parent_name, parent_phone, email, address, image_path, is_active
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING *`,
      [
        student_code,
        first_name,
        last_name,
        gender || null,
        date_of_birth || null,
        class_level || null,
        department || null,
        parent_name || null,
        parent_phone || null,
        email || null,
        address || null,
        image_path || null,
        Boolean(is_active)
      ]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    if (err.code === '23505') {
      return res.status(400).json({ error: 'student_code already exists' });
    }
    res.status(500).json({ error: 'Server error' });
  }
});

// Admin: update student
router.put('/:id', ...adminOnly, async (req, res) => {
  try {
    const { id } = req.params;
    const {
      student_code,
      first_name,
      last_name,
      gender,
      date_of_birth,
      class_level,
      department,
      parent_name,
      parent_phone,
      email,
      address,
      image_path,
      is_active = true
    } = req.body;

    if (!student_code || !first_name || !last_name) {
      return res.status(400).json({ error: 'student_code, first_name and last_name are required' });
    }

    const result = await pool.query(
      `UPDATE students
       SET student_code = $1, first_name = $2, last_name = $3, gender = $4, date_of_birth = $5,
           class_level = $6, department = $7, parent_name = $8, parent_phone = $9, email = $10,
           address = $11, image_path = $12, is_active = $13
       WHERE id = $14
       RETURNING *`,
      [
        student_code,
        first_name,
        last_name,
        gender || null,
        date_of_birth || null,
        class_level || null,
        department || null,
        parent_name || null,
        parent_phone || null,
        email || null,
        address || null,
        image_path || null,
        Boolean(is_active),
        id
      ]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Student not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    if (err.code === '23505') {
      return res.status(400).json({ error: 'student_code already exists' });
    }
    res.status(500).json({ error: 'Server error' });
  }
});

// Admin: delete student
router.delete('/:id', ...adminOnly, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('DELETE FROM students WHERE id = $1 RETURNING id', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Student not found' });
    }
    res.json({ message: 'Student deleted' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
