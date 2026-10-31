const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const pool = require('../db');
const { authenticateToken, authorizeRoles } = require('./auth');

const adminOnly = [authenticateToken, authorizeRoles('admin')];
const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const messageLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many messages sent. Please try again later.' }
});

// Public: get all contact info
router.get('/', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM contact_info ORDER BY type');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Public: client submits a contact/comment message
router.post('/messages', messageLimiter, async (req, res) => {
  try {
    const { name, email, subject, message } = req.body;
    if (!name || !email || !message) {
      return res.status(400).json({ error: 'name, email and message are required' });
    }
    if (!emailRegex.test(String(email).trim().toLowerCase())) {
      return res.status(400).json({ error: 'Invalid email format' });
    }
    if (String(name).trim().length < 2 || String(name).trim().length > 120) {
      return res.status(400).json({ error: 'Invalid name length' });
    }
    if (subject && String(subject).length > 255) {
      return res.status(400).json({ error: 'Subject is too long' });
    }
    if (String(message).trim().length < 5 || String(message).length > 5000) {
      return res.status(400).json({ error: 'Message length must be between 5 and 5000 characters' });
    }

    const result = await pool.query(
      `INSERT INTO contact_messages (name, email, subject, message, status)
       VALUES ($1, $2, $3, $4, 'unread')
       RETURNING id, name, email, subject, message, status, created_at`,
      [name, String(email).toLowerCase().trim(), subject || null, message]
    );
    res.status(201).json({ message: 'Message sent successfully', data: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Admin: inbox of client messages
router.get('/messages', ...adminOnly, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM contact_messages ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Admin: get one message and mark as read
router.get('/messages/:id', ...adminOnly, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('SELECT * FROM contact_messages WHERE id = $1', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Message not found' });
    }

    if (result.rows[0].status === 'unread') {
      await pool.query('UPDATE contact_messages SET status = $1, read_at = CURRENT_TIMESTAMP WHERE id = $2', [
        'read',
        id
      ]);
      result.rows[0].status = 'read';
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Admin: update message status (unread/read/archived)
router.put('/messages/:id/status', ...adminOnly, async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    if (!['unread', 'read', 'archived'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    const result = await pool.query(
      `UPDATE contact_messages
       SET status = $1, read_at = CASE WHEN $1 = 'read' THEN CURRENT_TIMESTAMP ELSE read_at END
       WHERE id = $2
       RETURNING *`,
      [status, id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Message not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Admin: delete message
router.delete('/messages/:id', ...adminOnly, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('DELETE FROM contact_messages WHERE id = $1 RETURNING id', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Message not found' });
    }
    res.json({ message: 'Contact message deleted' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Public: get contact info by type
router.get('/:type', async (req, res) => {
  try {
    const { type } = req.params;
    const result = await pool.query('SELECT * FROM contact_info WHERE type = $1', [type]);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Admin: create new contact info
router.post('/', ...adminOnly, async (req, res) => {
  try {
    const { type, value } = req.body;
    const result = await pool.query(
      'INSERT INTO contact_info (type, value) VALUES ($1, $2) RETURNING *',
      [type, value]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Admin: update contact info
router.put('/:id', ...adminOnly, async (req, res) => {
  try {
    const { id } = req.params;
    const { type, value } = req.body;
    const result = await pool.query(
      'UPDATE contact_info SET type = $1, value = $2 WHERE id = $3 RETURNING *',
      [type, value, id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Contact info not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Admin: delete contact info
router.delete('/:id', ...adminOnly, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('DELETE FROM contact_info WHERE id = $1 RETURNING *', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Contact info not found' });
    }
    res.json({ message: 'Contact info deleted' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
