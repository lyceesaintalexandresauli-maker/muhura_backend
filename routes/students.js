const express = require('express');
const router = express.Router();
const pool = require('../db');
const { authenticateToken, authorizeRoles } = require('./auth');

const adminOnly = [authenticateToken, authorizeRoles('admin')];
const classLevelsByProgram = {
  SWD: ['L3SWD', 'L4SWDA', 'L4SWDB', 'L5SWD'],
  SOD: ['L3', 'L4SOD A', 'L4SOD B', 'L5', 'L3SWD', 'L4SWDA', 'L4SWDB', 'L5SWD'],
  NIT: ['L3NIT', 'L4NITA', 'L4NITB', 'L5NIT'],
  CSA: ['L3CSA', 'L4CSA', 'L5CSA'],
  FAD: ['L3FAD', 'L4FAD', 'L5FAD'],
  ACC: ['S4ACC', 'S5ACC', 'S6ACC'],
};

const validateClass = (department, classLevel) => {
  const level = String(classLevel || '').trim().toUpperCase();
  const inferredProgram = Object.keys(classLevelsByProgram)
    .filter((candidate) => candidate !== 'SOD')
    .find((candidate) => classLevelsByProgram[candidate].includes(level));
  const program = String(inferredProgram || department || '').trim().toUpperCase();
  if (!classLevelsByProgram[program]) return { error: 'Choose a valid student program' };
  if (!classLevelsByProgram[program].includes(level)) {
    return { error: program === 'ACC'
      ? 'Accounting students must be assigned to S4ACC, S5ACC or S6ACC'
      : `Choose a valid ${program} class or section` };
  }
  return { department: program, classLevel: level };
};

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
    const classValidation = validateClass(req.body?.department, class_level);
    if (classValidation.error) return res.status(400).json({ error: classValidation.error });

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
        classValidation.classLevel,
        classValidation.department,
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
      class_level,
    } = req.body;

    if (!student_code || !first_name || !last_name) {
      return res.status(400).json({ error: 'student_code, first_name and last_name are required' });
    }
    const currentStudent = await pool.query('SELECT department FROM students WHERE id = $1', [id]);
    if (currentStudent.rows.length === 0) return res.status(404).json({ error: 'Student not found' });
    const classValidation = validateClass(req.body?.department || currentStudent.rows[0].department, class_level);
    if (classValidation.error) return res.status(400).json({ error: classValidation.error });

    const result = await pool.query(
      `UPDATE students
       SET student_code = $1, first_name = $2, last_name = $3,
           class_level = $4, department = $5
       WHERE id = $6
       RETURNING *`,
      [
        student_code,
        first_name,
        last_name,
        classValidation.classLevel,
        classValidation.department,
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
