const express = require('express');
const router = express.Router();
const pool = require('../db');
const { authenticateToken, authorizeRoles } = require('./auth');
const adminOnly = [authenticateToken, authorizeRoles('admin')];
const MAX_PAGE_SIZE = 50;

const parsePositiveInt = (value) => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  return parsed;
};

const cleanText = (value, maxLen = 1000) => {
  if (value === undefined || value === null) return '';
  return String(value).trim().replace(/\s+/g, ' ').slice(0, maxLen);
};

router.get('/', async (req, res) => {
  try {
    const limitRaw = parsePositiveInt(req.query.limit);
    const limit = Math.min(limitRaw || 20, MAX_PAGE_SIZE);
    const search = cleanText(req.query.search, 80);
    const category = cleanText(req.query.category, 50);

    const conditions = [];
    const values = [];

    if (search) {
      values.push(`%${search}%`);
      conditions.push(`(title ILIKE $${values.length} OR description ILIKE $${values.length})`);
    }
    if (category) {
      values.push(category);
      conditions.push(`category ILIKE $${values.length}`);
    }

    values.push(limit);
    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = await pool.query(
      `SELECT * FROM events ${whereClause} ORDER BY created_at DESC LIMIT $${values.length}`,
      values
    );
    return res.json(result.rows);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const id = parsePositiveInt(req.params.id);
    if (!id) {
      return res.status(400).json({ error: 'Invalid event id' });
    }
    const result = await pool.query('SELECT * FROM events WHERE id = $1', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Event not found' });
    }
    return res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
});

router.post('/', ...adminOnly, async (req, res) => {
  try {
    const title = cleanText(req.body.title, 160);
    const description = cleanText(req.body.description, 5000);
    const category = cleanText(req.body.category, 80);
    const imagePath = cleanText(req.body.image_path, 2048);
    if (!title || !description) {
      return res.status(400).json({ error: 'title and description are required' });
    }
    const result = await pool.query(
      'INSERT INTO events (title, description, category, image_path) VALUES ($1, $2, $3, $4) RETURNING *',
      [title, description, category || null, imagePath || null]
    );
    return res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
});

router.put('/:id', ...adminOnly, async (req, res) => {
  try {
    const id = parsePositiveInt(req.params.id);
    if (!id) {
      return res.status(400).json({ error: 'Invalid event id' });
    }
    const title = cleanText(req.body.title, 160);
    const description = cleanText(req.body.description, 5000);
    const category = cleanText(req.body.category, 80);
    const imagePath = cleanText(req.body.image_path, 2048);
    if (!title || !description) {
      return res.status(400).json({ error: 'title and description are required' });
    }
    const result = await pool.query(
      'UPDATE events SET title = $1, description = $2, category = $3, image_path = $4 WHERE id = $5 RETURNING *',
      [title, description, category || null, imagePath || null, id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Event not found' });
    }
    return res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
});

router.delete('/:id', ...adminOnly, async (req, res) => {
  try {
    const id = parsePositiveInt(req.params.id);
    if (!id) {
      return res.status(400).json({ error: 'Invalid event id' });
    }
    const result = await pool.query('DELETE FROM events WHERE id = $1 RETURNING *', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Event not found' });
    }
    return res.json({ message: 'Event deleted' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
