const express = require('express');
const router = express.Router();
const pool = require('../db');
const { authenticateToken, authorizeRoles } = require('./auth');
const adminOnly = [authenticateToken, authorizeRoles('admin')];
const toStructuredPageContent = (page, rows) => {
  const sections = rows.reduce((acc, row) => {
    const sectionKey = row.section || 'default';
    if (!acc[sectionKey]) {
      acc[sectionKey] = row;
    } else {
      acc[sectionKey] = { ...acc[sectionKey], rows: [...(acc[sectionKey].rows || [acc[sectionKey]]), row] };
    }
    return acc;
  }, {});

  return { page, rows, sections };
};

// Get all content
router.get('/', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM content ORDER BY page, section, id');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get content grouped by page -> section
router.get('/grouped/all', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM content ORDER BY page, section, id');
    const grouped = result.rows.reduce((acc, row) => {
      if (!acc[row.page]) {
        acc[row.page] = {};
      }
      if (!acc[row.page][row.section]) {
        acc[row.page][row.section] = [];
      }
      acc[row.page][row.section].push(row);
      return acc;
    }, {});
    res.json(grouped);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get content for a specific page
router.get('/:page', async (req, res) => {
  try {
    const { page } = req.params;
    const result = await pool.query('SELECT * FROM content WHERE page = $1 ORDER BY created_at', [page]);
    res.json(toStructuredPageContent(page, result.rows));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get content for a specific page and section
router.get('/:page/:section', async (req, res) => {
  try {
    const { page, section } = req.params;
    const result = await pool.query('SELECT * FROM content WHERE page = $1 AND section = $2 ORDER BY created_at', [page, section]);
    res.json({
      page,
      section,
      rows: result.rows,
      entry: result.rows[0] || null
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Create new content (admin only)
router.post('/', ...adminOnly, async (req, res) => {
  try {
    const { page, section, title, content, image_path } = req.body;
    const result = await pool.query(
      'INSERT INTO content (page, section, title, content, image_path) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [page, section, title, content, image_path]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update content
router.put('/:id', ...adminOnly, async (req, res) => {
  try {
    const { id } = req.params;
    const { page, section, title, content, image_path } = req.body;
    const result = await pool.query(
      'UPDATE content SET page = $1, section = $2, title = $3, content = $4, image_path = $5, updated_at = CURRENT_TIMESTAMP WHERE id = $6 RETURNING *',
      [page, section, title, content, image_path, id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Content not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Delete content
router.delete('/:id', ...adminOnly, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('DELETE FROM content WHERE id = $1 RETURNING *', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Content not found' });
    }
    res.json({ message: 'Content deleted' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
