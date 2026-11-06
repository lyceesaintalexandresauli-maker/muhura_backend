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
const DEFAULT_MAX_UPLOAD_SIZE_MB = 50;
const configuredMaxUploadSizeMb = process.env.MAX_UPLOAD_SIZE_MB
  ? Number(process.env.MAX_UPLOAD_SIZE_MB)
  : DEFAULT_MAX_UPLOAD_SIZE_MB;
if (!Number.isInteger(configuredMaxUploadSizeMb) || configuredMaxUploadSizeMb < 1 || configuredMaxUploadSizeMb > 250) {
  throw new Error('MAX_UPLOAD_SIZE_MB must be a whole number between 1 and 250');
}
const maxUploadSizeMb = configuredMaxUploadSizeMb;
const maxUploadSizeBytes = maxUploadSizeMb * 1024 * 1024;
const parsePositiveInt = (value) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};
const extensionMap = {
  image: new Set(['.jpeg', '.jpg', '.png', '.gif', '.webp', '.svg']),
  video: new Set(['.mp4', '.avi', '.mov', '.mkv', '.webm', '.ogg', '.m4v']),
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
  limits: { fileSize: maxUploadSizeBytes },
  fileFilter: (req, file, cb) => {
    const type = getFileType(file);
    if (type) return cb(null, true);
    return cb(new Error('Invalid file type'));
  }
});

const uploadFields = upload.fields([
  { name: 'file', maxCount: 1 },
  { name: 'video', maxCount: 1 },
  { name: 'media', maxCount: 1 },
  { name: 'image', maxCount: 1 }
]);
const handleUpload = (req, res, next) => {
  uploadFields(req, res, (error) => {
    if (!error) return next();
    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({
        error: `File is too large. The maximum upload size is ${maxUploadSizeMb} MB. Compress the video or increase MAX_UPLOAD_SIZE_MB and the storage bucket limit.`,
        code: 'UPLOAD_FILE_TOO_LARGE',
        max_upload_size_mb: maxUploadSizeMb
      });
    }
    if (error instanceof multer.MulterError) {
      return res.status(400).json({ error: `Upload failed: ${error.message}`, code: error.code });
    }
    console.warn('File upload rejected:', error.message);
    return res.status(415).json({ error: error.message || 'Unsupported file type', code: 'UPLOAD_UNSUPPORTED_FILE_TYPE' });
  });
};

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

const getUploadedFile = (req) => {
  if (req.file) return req.file;
  const filesMap = req.files || {};
  return filesMap.file?.[0] || filesMap.video?.[0] || filesMap.media?.[0] || filesMap.image?.[0] || null;
};

router.post('/', ...adminOnly, handleUpload, async (req, res) => {
  let persisted;
  try {
    const selectedFile = getUploadedFile(req);
    if (!selectedFile) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const type = getFileType(selectedFile);
    if (!type) {
      return res.status(400).json({ error: 'Invalid file type' });
    }

    const targetFolder = getFolderByType(type);
    const storedFilename = createStoredFilename(selectedFile.originalname);

    if (canUseSupabaseStorage()) {
      try {
        persisted = await persistToSupabaseStorage(selectedFile, targetFolder, storedFilename);
      } catch (storageError) {
        console.error('Supabase storage upload failed:', storageError);
        const statusCode = Number(storageError.statusCode) === 413 ? 413 : 502;
        return res.status(statusCode).json({
          error: statusCode === 413
            ? 'The storage bucket rejected this file because it exceeds the bucket upload limit. Increase the Supabase bucket limit or compress the video.'
            : 'The file could not be saved to shared storage. Check Supabase Storage configuration and try again.',
          code: statusCode === 413 ? 'STORAGE_FILE_TOO_LARGE' : 'STORAGE_UPLOAD_FAILED'
        });
      }
    } else {
      persisted = persistLocally(selectedFile, targetFolder, storedFilename);
    }

    const result = await pool.query(
      'INSERT INTO files (filename, original_name, path, type, size, uploaded_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
      [persisted.filename, selectedFile.originalname, persisted.path, type, selectedFile.size, req.user.id]
    );

    return res.status(201).json({
      message: 'File uploaded successfully',
      file: {
        ...result.rows[0],
        storage_mode: persisted.storage_mode
      }
    });
  } catch (err) {
    console.error('File upload failed:', err);
    if (persisted) {
      try {
        await removeStoredFile(persisted);
      } catch (cleanupError) {
        console.error('Failed to clean up uploaded file after metadata error:', cleanupError);
      }
      return res.status(500).json({
        error: 'The file was received, but the backend could not save its upload record. Please retry the upload.',
        code: 'UPLOAD_METADATA_SAVE_FAILED'
      });
    }
    return res.status(500).json({ error: 'The backend could not store this file. Check server storage configuration and try again.' });
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

router.get('/public/documents', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, original_name, size, created_at
       FROM files
       WHERE type = 'document'
       ORDER BY created_at DESC`
    );
    return res.json(result.rows);
  } catch (err) {
    console.error('Failed to list public documents:', err);
    return res.status(500).json({ error: 'Failed to load documents' });
  }
});

router.get('/public/documents/:id/download', async (req, res) => {
  try {
    const id = parsePositiveInt(req.params.id);
    if (!id) {
      return res.status(400).json({ error: 'Invalid document id' });
    }

    const result = await pool.query(
      `SELECT filename, original_name, path
       FROM files
       WHERE id = $1 AND type = 'document'`,
      [id]
    );
    const file = result.rows[0];
    if (!file) {
      return res.status(404).json({ error: 'Document not found' });
    }

    const downloadName = path.basename(String(file.original_name || file.filename).replace(/\\/g, '/'));
    if (file.path.startsWith('/uploads/')) {
      const physicalPath = path.resolve(uploadsRoot, file.path.slice('/uploads/'.length));
      const documentsRoot = path.resolve(uploadsRoot, 'documents') + path.sep;
      if (!physicalPath.startsWith(documentsRoot)) {
        return res.status(400).json({ error: 'Invalid document path' });
      }

      return res.download(physicalPath, downloadName, (err) => {
        if (err && !res.headersSent) {
          console.error('Failed to download local document:', err);
          res.status(err.statusCode === 404 ? 404 : 500).json({
            error: err.statusCode === 404 ? 'Document file not found' : 'Failed to download document'
          });
        }
      });
    }

    const objectPath = String(file.filename || '').replace(/\\/g, '/');
    if (!objectPath.startsWith('documents/') || objectPath.includes('..')) {
      return res.status(400).json({ error: 'Invalid document path' });
    }

    const { data, error } = await getSupabaseAdminClient()
      .storage
      .from(storageBucket)
      .download(objectPath);
    if (error) {
      throw error;
    }

    res.attachment(downloadName);
    return res.send(Buffer.from(await data.arrayBuffer()));
  } catch (err) {
    console.error('Failed to download document:', err);
    return res.status(500).json({ error: 'Failed to download document' });
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
