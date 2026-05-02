const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const pool = require('../db');
const { authenticateToken, authorizeRoles } = require('./auth');
const { getSupabaseAdminClient } = require('../supabase');
const adminOnly = [authenticateToken, authorizeRoles('admin')];

const uploadsRoot = path.join(__dirname, '../uploads');
const storageBucket = process.env.SUPABASE_STORAGE_BUCKET || 'uploads';
const extensionMap = {
  image: new Set(['.jpeg', '.jpg', '.png', '.gif', '.webp']),
  video: new Set(['.mp4', '.avi', '.mov', '.mkv', '.webm']),
  document: new Set(['.pdf', '.doc', '.docx', '.ppt', '.pptx', '.xls', '.xlsx'])
};

const getFileType = (file) => {
  const ext = path.extname(file.originalname).toLowerCase();
  const mimetype = String(file.mimetype || '');

  if (extensionMap.image.has(ext) || mimetype.startsWith('image/')) {
    return 'image';
  }
  if (extensionMap.video.has(ext) || mimetype.startsWith('video/')) {
    return 'video';
  }
  if (
    extensionMap.document.has(ext) ||
    mimetype.includes('pdf') ||
    mimetype.includes('msword') ||
    mimetype.includes('officedocument')
  ) {
    return 'document';
  }
  return null;
};

const getFolderByType = (type) => {
  if (type === 'image') return 'images';
  if (type === 'video') return 'videos';
  return 'documents';
};

const safeBaseName = (originalname) =>
  path
    .basename(originalname, path.extname(originalname))
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 80) || 'file';

const createStoredFilename = (originalname) =>
  `${Date.now()}_${safeBaseName(originalname)}${path.extname(originalname).toLowerCase()}`;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const type = getFileType(file);
    if (type) return cb(null, true);
    return cb(new Error('Invalid file type'));
  }
});

const canUseSupabaseStorage = () => Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY);

const persistLocally = (file, targetFolder, storedFilename) => {
  const folderPath = path.join(uploadsRoot, targetFolder);
  if (!fs.existsSync(folderPath)) {
    fs.mkdirSync(folderPath, { recursive: true });
  }

  const physicalPath = path.join(folderPath, storedFilename);
  fs.writeFileSync(physicalPath, file.buffer);
  const relativePath = `${targetFolder}/${storedFilename}`;

  return {
    filename: storedFilename,
    path: `/uploads/${relativePath}`,
    storage_mode: 'local'
  };
};

const persistToSupabaseStorage = async (file, targetFolder, storedFilename) => {
  const supabase = getSupabaseAdminClient();
  const objectPath = `${targetFolder}/${storedFilename}`;
  const { error: uploadError } = await supabase.storage
    .from(storageBucket)
    .upload(objectPath, file.buffer, {
      contentType: file.mimetype,
      upsert: false,
      cacheControl: '3600'
    });

  if (uploadError) {
    throw uploadError;
  }

  const { data } = supabase.storage.from(storageBucket).getPublicUrl(objectPath);
  return {
    filename: objectPath,
    path: data.publicUrl,
    storage_mode: 'supabase'
  };
};

const removeStoredFile = async (storedRecord) => {
  if (!storedRecord?.path) return;

  if (/^https?:\/\//i.test(storedRecord.path) && storedRecord.path.includes('/storage/v1/object/public/')) {
    try {
      const supabase = getSupabaseAdminClient();
      const marker = `/storage/v1/object/public/${storageBucket}/`;
      const index = storedRecord.path.indexOf(marker);
      if (index !== -1) {
        const objectPath = decodeURIComponent(storedRecord.path.slice(index + marker.length));
        await supabase.storage.from(storageBucket).remove([objectPath]);
      }
    } catch (err) {
      console.error('Failed to remove Supabase storage object:', err.message);
    }
    return;
  }

  if (storedRecord.path.startsWith('/uploads/')) {
    const physicalPath = path.join(uploadsRoot, storedRecord.path.replace('/uploads/', '').replace(/\//g, path.sep));
    if (fs.existsSync(physicalPath)) {
      fs.unlinkSync(physicalPath);
    }
  }
};

router.post('/', ...adminOnly, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const type = getFileType(req.file);
    if (!type) {
      return res.status(400).json({ error: 'Invalid file type' });
    }

    const targetFolder = getFolderByType(type);
    const storedFilename = createStoredFilename(req.file.originalname);
    let persisted;

    if (canUseSupabaseStorage()) {
      try {
        persisted = await persistToSupabaseStorage(req.file, targetFolder, storedFilename);
      } catch (storageError) {
        console.error('Supabase storage upload failed, falling back to local disk:', storageError.message);
        persisted = persistLocally(req.file, targetFolder, storedFilename);
      }
    } else {
      persisted = persistLocally(req.file, targetFolder, storedFilename);
    }

    const result = await pool.query(
      'INSERT INTO files (filename, original_name, path, type, size, uploaded_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
      [persisted.filename, req.file.originalname, persisted.path, type, req.file.size, req.user.id]
    );

    return res.status(201).json({
      message: 'File uploaded successfully',
      file: {
        ...result.rows[0],
        storage_mode: persisted.storage_mode
      }
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
});

router.get('/', ...adminOnly, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM files ORDER BY created_at DESC');
    return res.json(result.rows);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
});

router.get('/:id', ...adminOnly, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('SELECT * FROM files WHERE id = $1', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'File not found' });
    }
    return res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
});

router.delete('/:id', ...adminOnly, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('DELETE FROM files WHERE id = $1 RETURNING *', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'File not found' });
    }

    await removeStoredFile(result.rows[0]);
    return res.json({ message: 'File deleted' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
