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
    const videoUrl = cleanText(req.body.video_url, 2048) || null;
    const audioUrl = cleanText(req.body.audio_url, 2048) || null;
    const date = req.body.date || null;
    const time = cleanText(req.body.time, 40) || null;
    const location = cleanText(req.body.location, 180) || null;
    const registrationLink = cleanText(req.body.registration_link, 2048) || null;
    if (!title || !description) {
      return res.status(400).json({ error: 'title and description are required' });
    }
    const result = await pool.query(
      `INSERT INTO events (title, description, category, image_path, video_url, audio_url, date, time, location, registration_link)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [title, description, category || null, imagePath || null, videoUrl, audioUrl, date, time, location, registrationLink]
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
    const videoUrl = req.body.video_url === undefined
      ? undefined
      : cleanText(req.body.video_url, 2048) || null;
    const audioUrl = req.body.audio_url === undefined
      ? undefined
      : cleanText(req.body.audio_url, 2048) || null;
    const date = req.body.date === undefined ? undefined : req.body.date || null;
    const time = req.body.time === undefined ? undefined : cleanText(req.body.time, 40) || null;
    const location = req.body.location === undefined ? undefined : cleanText(req.body.location, 180) || null;
    const registrationLink = req.body.registration_link === undefined
      ? undefined
      : cleanText(req.body.registration_link, 2048) || null;
    if (!title || !description) {
      return res.status(400).json({ error: 'title and description are required' });
    }
    const result = await pool.query(
      `UPDATE events SET title = $1, description = $2, category = $3, image_path = $4,
       video_url = COALESCE($5, video_url), audio_url = COALESCE($6, audio_url),
       date = COALESCE($7, date), time = COALESCE($8, time), location = COALESCE($9, location),
       registration_link = COALESCE($10, registration_link)
       WHERE id = $11 RETURNING *`,
      [title, description, category || null, imagePath || null, videoUrl, audioUrl, date, time, location, registrationLink, id]
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
