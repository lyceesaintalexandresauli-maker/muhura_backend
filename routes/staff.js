const express = require('express');
const router = express.Router();
const pool = require('../db');
const { authenticateToken, authorizeRoles } = require('./auth');
const multer = require('multer');
const path = require('path');
const { getSupabaseAdminClient, canUseSupabaseAdminClient } = require('../supabase');

const adminOnly = [authenticateToken, authorizeRoles('admin')];

// Configure multer for file uploads
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only JPEG, PNG, and WebP images are allowed.'));
    }
  }
});

// Helper function to upload file to Supabase or local
const uploadFile = async (file, folder = 'images') => {
  if (!file) return null;

  const filename = `${Date.now()}_${path.basename(file.originalname, path.extname(file.originalname))}${path.extname(file.originalname).toLowerCase()}`;
  const objectPath = `${folder}/${filename}`;

  // Try Supabase Storage first
  if (canUseSupabaseAdminClient()) {
    try {
      const supabase = getSupabaseAdminClient();
      const { error } = await supabase.storage.from('uploads').upload(objectPath, file.buffer, {
        contentType: file.mimetype,
        upsert: true,
      });
      if (!error) {
        const { data } = supabase.storage.from('uploads').getPublicUrl(objectPath);
        return data.publicUrl;
      }
    } catch (err) {
      console.error('Supabase upload failed, falling back to local:', err.message);
    }
  }

  // Fallback: return relative path for local storage
  return `/uploads/${objectPath}`;
};

// Get all staff
router.get('/', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM staff ORDER BY name');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get staff by department
router.get('/department/:dept', async (req, res) => {
  try {
    const { dept } = req.params;
    const result = await pool.query('SELECT * FROM staff WHERE department = $1 ORDER BY name', [dept]);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get staff by ID
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('SELECT * FROM staff WHERE id = $1', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Staff member not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Create new staff
router.post('/', ...adminOnly, upload.single('image'), async (req, res) => {
  try {
    const { name, position, department, class: staffClass, bio, email, phone } = req.body;
    let image_path = req.body.image_path;

    // Handle file upload
    if (req.file) {
      image_path = await uploadFile(req.file, 'images');
    }

    const result = await pool.query(
      'INSERT INTO staff (name, position, department, class, bio, image_path, email, phone) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *',
      [name, position, department, staffClass, bio, image_path, email, phone]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'File too large. Maximum size is 5MB.' });
    }
    if (err.message.includes('Invalid file type')) {
      return res.status(400).json({ error: err.message });
    }
    res.status(500).json({ error: 'Server error' });
  }
});

// Update staff
router.put('/:id', ...adminOnly, upload.single('image'), async (req, res) => {
  try {
    const { id } = req.params;
    const { name, position, department, class: staffClass, bio, email, phone } = req.body;
    let image_path = req.body.image_path;

    // Handle file upload
    if (req.file) {
      image_path = await uploadFile(req.file, 'images');
    }

    const result = await pool.query(
      'UPDATE staff SET name = $1, position = $2, department = $3, class = $4, bio = $5, image_path = $6, email = $7, phone = $8 WHERE id = $9 RETURNING *',
      [name, position, department, staffClass, bio, image_path, email, phone, id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Staff member not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'File too large. Maximum size is 5MB.' });
    }
    if (err.message.includes('Invalid file type')) {
      return res.status(400).json({ error: err.message });
    }
    res.status(500).json({ error: 'Server error' });
  }
});

// Delete staff
router.delete('/:id', ...adminOnly, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('DELETE FROM staff WHERE id = $1 RETURNING *', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Staff member not found' });
    }
    res.json({ message: 'Staff member deleted' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
