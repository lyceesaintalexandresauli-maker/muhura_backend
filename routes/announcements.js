const express = require('express');
const router = express.Router();
const pool = require('../db');
const { authenticateToken, authorizeRoles } = require('./auth');
const adminOnly = [authenticateToken, authorizeRoles('admin')];

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
    const result = await pool.query('SELECT * FROM announcements ORDER BY created_at DESC');
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
      return res.status(400).json({ error: 'Invalid announcement id' });
    }
    const result = await pool.query('SELECT * FROM announcements WHERE id = $1', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Announcement not found' });
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
    const content = cleanText(req.body.content, 5000);
    const imagePath = cleanText(req.body.image_path, 2048);
    if (!title || !content) {
      return res.status(400).json({ error: 'title and content are required' });
    }
    const result = await pool.query(
      'INSERT INTO announcements (title, content, image_path) VALUES ($1, $2, $3) RETURNING *',
      [title, content, imagePath || null]
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
      return res.status(400).json({ error: 'Invalid announcement id' });
    }
    const title = cleanText(req.body.title, 160);
    const content = cleanText(req.body.content, 5000);
    const imagePath = cleanText(req.body.image_path, 2048);
    if (!title || !content) {
      return res.status(400).json({ error: 'title and content are required' });
    }
    const result = await pool.query(
      'UPDATE announcements SET title = $1, content = $2, image_path = $3 WHERE id = $4 RETURNING *',
      [title, content, imagePath || null, id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Announcement not found' });
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
      return res.status(400).json({ error: 'Invalid announcement id' });
    }
    const result = await pool.query('DELETE FROM announcements WHERE id = $1 RETURNING *', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Announcement not found' });
    }
    return res.json({ message: 'Announcement deleted' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
