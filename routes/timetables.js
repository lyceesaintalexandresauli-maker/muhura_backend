const express = require('express');
const pool = require('../db');
const { authenticateToken, authorizeRoles } = require('./auth');

const router = express.Router();
const adminOnly = [authenticateToken, authorizeRoles('admin', 'dos')];
const authRequired = [authenticateToken];
const viewOnly = [authenticateToken, authorizeRoles('admin', 'teacher', 'dos')];

// Published timetables for the public website (no auth; must be registered before /:id)
router.get('/public/published', async (req, res) => {
  try {
    const { department, trade_level, academic_year, term } = req.query;
    let query = `
      SELECT t.id, t.class_name, t.department, t.trade_level, t.academic_year, t.term,
             t.schedule_data, t.updated_at
      FROM timetables t
      WHERE t.status = 'published'
    `;
    const params = [];
    let paramIndex = 1;

    if (department) {
      query += ` AND t.department = $${paramIndex}`;
      params.push(department);
      paramIndex += 1;
    }
    if (trade_level) {
      query += ` AND t.trade_level = $${paramIndex}`;
      params.push(trade_level);
      paramIndex += 1;
    }
    if (academic_year) {
      query += ` AND t.academic_year = $${paramIndex}`;
      params.push(academic_year);
      paramIndex += 1;
    }
    if (term) {
      query += ` AND t.term = $${paramIndex}`;
      params.push(term);
      paramIndex += 1;
    }

    query += ` ORDER BY t.department ASC NULLS LAST, t.trade_level ASC NULLS LAST, t.class_name ASC`;

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get all timetables (with filters)
router.get('/', authRequired, async (req, res) => {
  try {
    const { department, trade_level, status, academic_year, term } = req.query;
    let query = `
      SELECT t.*, u.username as created_by_username, u.full_name as created_by_name
      FROM timetables t
      LEFT JOIN users u ON t.created_by = u.id
      WHERE 1=1
    `;
    const params = [];
    let paramIndex = 1;

    if (department) {
      query += ` AND t.department = $${paramIndex}`;
      params.push(department);
      paramIndex++;
    }
    if (trade_level) {
      query += ` AND t.trade_level = $${paramIndex}`;
      params.push(trade_level);
      paramIndex++;
    }
    if (status) {
      query += ` AND t.status = $${paramIndex}`;
      params.push(status);
      paramIndex++;
    }
    if (academic_year) {
      query += ` AND t.academic_year = $${paramIndex}`;
      params.push(academic_year);
      paramIndex++;
    }
    if (term) {
      query += ` AND t.term = $${paramIndex}`;
      params.push(term);
      paramIndex++;
    }

    query += ` ORDER BY t.created_at DESC`;

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get single timetable by ID
router.get('/:id', authRequired, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      `SELECT t.*, u.username as created_by_username, u.full_name as created_by_name
       FROM timetables t
       LEFT JOIN users u ON t.created_by = u.id
       WHERE t.id = $1`,
      [id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Timetable not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Create timetable (Admin/DOS only)
router.post('/', adminOnly, async (req, res) => {
  const client = await pool.connect();
  try {
    const { class_name, department, trade_level, academic_year, term, schedule_data, status = 'draft' } = req.body;
    
    if (!class_name || !department || !trade_level || !academic_year || !term || !schedule_data) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    await client.query('BEGIN');
    
    const result = await client.query(
      `INSERT INTO timetables (class_name, department, trade_level, academic_year, term, schedule_data, created_by, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [class_name, department, trade_level, academic_year, term, JSON.stringify(schedule_data), req.user.id, status]
    );

    // If status is published, automatically distribute
    if (status === 'published') {
      await distributeTimetable(client, result.rows[0].id, req.user.id);
    }

    await client.query('COMMIT');
    res.status(201).json(result.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

// Update timetable (Admin/DOS only)
router.put('/:id', adminOnly, async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { class_name, department, trade_level, academic_year, term, schedule_data, status } = req.body;
    
    const existingResult = await client.query('SELECT * FROM timetables WHERE id = $1', [id]);
    if (existingResult.rows.length === 0) {
      return res.status(404).json({ error: 'Timetable not found' });
    }

    await client.query('BEGIN');
    
    const result = await client.query(
      `UPDATE timetables
       SET class_name = COALESCE($1, class_name),
           department = COALESCE($2, department),
           trade_level = COALESCE($3, trade_level),
           academic_year = COALESCE($4, academic_year),
           term = COALESCE($5, term),
           schedule_data = COALESCE($6, schedule_data),
           status = COALESCE($7, status),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $8
       RETURNING *`,
      [class_name, department, trade_level, academic_year, term, schedule_data ? JSON.stringify(schedule_data) : null, status, id]
    );

    // If status changed to published, distribute
    if (status === 'published' && existingResult.rows[0].status !== 'published') {
      await distributeTimetable(client, id, req.user.id);
    }

    await client.query('COMMIT');
    res.json(result.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

// Delete timetable (Admin/DOS only)
router.delete('/:id', adminOnly, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('DELETE FROM timetables WHERE id = $1 RETURNING id', [id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Timetable not found' });
    }
    res.json({ message: 'Timetable deleted' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get teacher timetables
router.get('/teacher/:code', authRequired, async (req, res) => {
  try {
    const { code } = req.params;
    const result = await pool.query(
      `SELECT tt.*, t.class_name, t.department, t.trade_level
       FROM teacher_timetables tt
       JOIN timetables t ON tt.timetable_id = t.id
       WHERE tt.teacher_code = $1
       ORDER BY t.created_at DESC`,
      [code]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get distribution logs for a timetable
router.get('/:id/distributions', adminOnly, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      `SELECT td.*, u.username as distributed_by_username
       FROM timetable_distributions td
       LEFT JOIN users u ON td.distributed_by = u.id
       WHERE td.timetable_id = $1
       ORDER BY td.distributed_at DESC`,
      [id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Helper function to distribute timetable
async function distributeTimetable(client, timetableId, userId) {
  const timetableResult = await client.query('SELECT * FROM timetables WHERE id = $1', [timetableId]);
  if (timetableResult.rows.length === 0) return;

  const timetable = timetableResult.rows[0];

  // Distribute to class
  await client.query(
    `INSERT INTO timetable_distributions (timetable_id, recipient_type, recipient_id, distributed_by, status)
     VALUES ($1, 'class', $2, $3, 'sent')`,
    [timetableId, timetable.class_name, userId]
  );

  // Distribute to department
  await client.query(
    `INSERT INTO timetable_distributions (timetable_id, recipient_type, recipient_id, distributed_by, status)
     VALUES ($1, 'department', $2, $3, 'sent')`,
    [timetableId, timetable.department, userId]
  );

  // Distribute to teachers based on schedule data
  const scheduleData = timetable.schedule_data;
  const teacherCodes = new Set();
  
  for (const timeSlot of Object.keys(scheduleData)) {
    const row = scheduleData[timeSlot];
    if (!row || typeof row !== 'object') continue;
    for (const day of Object.keys(row)) {
      const cell = row[day];
      if (typeof cell !== 'string') continue;
      const match = cell.match(/\((\d+)\)/);
      if (match) {
        teacherCodes.add(match[1]);
      }
    }
  }

  for (const teacherCode of teacherCodes) {
    await client.query(
      `INSERT INTO timetable_distributions (timetable_id, recipient_type, recipient_id, distributed_by, status)
       VALUES ($1, 'teacher', $2, $3, 'sent')`,
      [timetableId, teacherCode, userId]
    );
  }
}

module.exports = router;
