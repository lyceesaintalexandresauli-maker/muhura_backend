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

// Get all gallery items (public)
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM gallery WHERE is_active = true ORDER BY sort_order ASC, created_at DESC'
    );
    return res.json(result.rows);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// Get gallery items by media type (images or videos)
router.get('/type/:mediaType', async (req, res) => {
  try {
    const { mediaType } = req.params;
    if (!['image', 'video'].includes(mediaType)) {
      return res.status(400).json({ error: 'Invalid media type. Use "image" or "video"' });
    }
    const result = await pool.query(
      'SELECT * FROM gallery WHERE is_active = true AND media_type = $1 ORDER BY sort_order ASC, created_at DESC',
      [mediaType]
    );
    return res.json(result.rows);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// Get single gallery item
router.get('/:id', async (req, res) => {
  try {
    const id = parsePositiveInt(req.params.id);
    if (!id) {
      return res.status(400).json({ error: 'Invalid gallery id' });
    }
    const result = await pool.query('SELECT * FROM gallery WHERE id = $1', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Gallery item not found' });
    }
    return res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// Create gallery item (admin only)
router.post('/', ...adminOnly, async (req, res) => {
  try {
    const title = cleanText(req.body.title, 255) || null;
    const media_path = cleanText(req.body.media_path, 500);
    const media_type = cleanText(req.body.media_type, 20);
    const sort_order = Number.parseInt(req.body.sort_order, 10) || 0;

    if (!media_path) {
      return res.status(400).json({ error: 'media_path is required' });
    }
    if (!['image', 'video'].includes(media_type)) {
      return res.status(400).json({ error: 'media_type must be "image" or "video"' });
    }

    const result = await pool.query(
      'INSERT INTO gallery (title, media_path, media_type, sort_order) VALUES ($1, $2, $3, $4) RETURNING *',
      [title, media_path, media_type, sort_order]
    );
    return res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// Update gallery item (admin only)
router.put('/:id', ...adminOnly, async (req, res) => {
  try {
    const id = parsePositiveInt(req.params.id);
    if (!id) {
      return res.status(400).json({ error: 'Invalid gallery id' });
    }

    const title = cleanText(req.body.title, 255) || null;
    const media_path = cleanText(req.body.media_path, 500);
    const media_type = cleanText(req.body.media_type, 20);
    const sort_order = Number.parseInt(req.body.sort_order, 10) || 0;
    const is_active = req.body.is_active !== undefined ? !!req.body.is_active : true;

    if (media_path && !['image', 'video'].includes(media_type)) {
      return res.status(400).json({ error: 'media_type must be "image" or "video"' });
    }

    const result = await pool.query(
      'UPDATE gallery SET title = $1, media_path = COALESCE($2, media_path), media_type = COALESCE($3, media_type), sort_order = $4, is_active = $5, updated_at = CURRENT_TIMESTAMP WHERE id = $6 RETURNING *',
      [title, media_path || null, media_type || null, sort_order, is_active, id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Gallery item not found' });
    }
    return res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// Delete gallery item (admin only)
router.delete('/:id', ...adminOnly, async (req, res) => {
  try {
    const id = parsePositiveInt(req.params.id);
    if (!id) {
      return res.status(400).json({ error: 'Invalid gallery id' });
    }
    const result = await pool.query('DELETE FROM gallery WHERE id = $1 RETURNING *', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Gallery item not found' });
    }
    return res.json({ message: 'Gallery item deleted' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
