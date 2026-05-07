require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const helmet = require('helmet');
const hpp = require('hpp');
const rateLimit = require('express-rate-limit');
const compression = require('compression');
const pool = require('./db');
const { getSupabaseConfigStatus } = require('./supabase');

const app = express();
const PORT = process.env.PORT || 5000;
const uploadsRoot = path.join(__dirname, 'uploads');
const assetDirectoryCandidates = [
  path.join(__dirname, 'assets'),
  path.join(__dirname, '../school-frontend/public/assets'),
  path.join(process.cwd(), 'assets'),
  path.join(process.cwd(), '../school-frontend/public/assets')
];
const assetsRoot = assetDirectoryCandidates.find((candidate) => fs.existsSync(candidate)) || assetDirectoryCandidates[0];
const uploadFolders = ['images', 'videos', 'documents', 'profiles'];
const trimTrailingSlash = (value = '') => String(value).replace(/\/+$/, '');
const allowedOrigins = (process.env.CORS_ORIGIN || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
const defaultAllowedOrigins = [
  'https://fronend-l7hh.onrender.com',
  'https://muhura-web.onrender.com',
  'https://lycee-muhura.onrender.com',
  'https://muhura-frontend.onrender.com'
];
const corsAllowedOrigins = Array.from(
  new Set([...allowedOrigins, ...defaultAllowedOrigins].map(trimTrailingSlash).filter(Boolean))
);
const corsOptions = {
  origin: (origin, callback) => {
    const normalizedOrigin = trimTrailingSlash(origin || '');
    const isLocalhostDev = /^http:\/\/localhost:\d+$/i.test(normalizedOrigin);

    if (
      !origin ||
      corsAllowedOrigins.length === 0 ||
      corsAllowedOrigins.includes(normalizedOrigin) ||
      isLocalhostDev
    ) {
      return callback(null, true);
    }

    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
  methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Origin', 'X-Requested-With', 'Content-Type', 'Accept', 'Authorization'],
  optionsSuccessStatus: 204,
  maxAge: 86400
};

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' }
  })
);
app.use(hpp());
app.use(
  compression({
    threshold: 1024
  })
);
app.use(
  cors(corsOptions)
);
app.options(/.*/, cors(corsOptions));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests. Please try again later.' }
  })
);
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  return next();
});

if (!fs.existsSync(uploadsRoot)) {
  fs.mkdirSync(uploadsRoot, { recursive: true });
}
for (const folder of uploadFolders) {
  const folderPath = path.join(uploadsRoot, folder);
  if (!fs.existsSync(folderPath)) {
    fs.mkdirSync(folderPath, { recursive: true });
  }
}

// Middleware to serve uploads with proper CORS and caching headers
app.use('/uploads', (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
  next();
});

app.use(
  '/uploads',
  express.static(uploadsRoot, {
    maxAge: '1d',
    etag: true,
    lastModified: true
  })
);
app.use(
  '/assets',
  express.static(assetsRoot, {
    maxAge: '7d',
    etag: true,
    lastModified: true
  })
);

app.use((req, res, next) => {
  if (req.originalUrl && req.originalUrl.length > 2048) {
    return res.status(414).json({ error: 'Request URI too long' });
  }
  return next();
});

(async () => {
  try {
    await pool.query('SELECT 1');
    console.log('Connected to PostgreSQL database');
  } catch (err) {
    console.error('Database connection error:', err);
  }
})();

const contentRoutes = require('./routes/content');
const eventsRoutes = require('./routes/events');
const announcementsRoutes = require('./routes/announcements');
const staffRoutes = require('./routes/staff');
const studentsRoutes = require('./routes/students');
const departmentsRoutes = require('./routes/departments');
const contactRoutes = require('./routes/contact');
const uploadRoutes = require('./routes/uploads');
const navigationRoutes = require('./routes/navigation');
const siteRoutes = require('./routes/site');
const usersRoutes = require('./routes/users');
const timetablesRoutes = require('./routes/timetables');
const galleryRoutes = require('./routes/gallery');
const schoolWorkersRoutes = require('./routes/schoolWorkers');
const chatRoutes = require('./routes/chat');
const { router: authRoutes } = require('./routes/auth');

app.use('/api/content', contentRoutes);
app.use('/api/events', eventsRoutes);
app.use('/api/announcements', announcementsRoutes);
app.use('/api/staff', staffRoutes);
app.use('/api/students', studentsRoutes);
app.use('/api/departments', departmentsRoutes);
app.use('/api/contact', contactRoutes);
app.use('/api/uploads', uploadRoutes);
app.use('/api/navigation', navigationRoutes);
app.use('/api/site', siteRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/timetables', timetablesRoutes);
app.use('/api/gallery', galleryRoutes);
app.use('/api/school-workers', schoolWorkersRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/auth', authRoutes);

app.get('/', (req, res) => {
  res.json({ message: 'School Website API' });
});

app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    const supabase = getSupabaseConfigStatus();
    res.json({
      status: 'ok',
      db: 'connected',
      supabase: {
        url_configured: Boolean(supabase.resolvedUrl),
        anon_configured: supabase.anonConfigured,
        service_role_configured: supabase.serviceRoleConfigured,
        storage_bucket: supabase.storageBucket,
        issues: supabase.issues,
      }
    });
  } catch (err) {
    res.status(500).json({ status: 'error', db: 'disconnected', message: err.message });
  }
});

app.use('/api', (req, res) => {
  res.status(404).json({ error: 'API endpoint not found' });
});

app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({ error: 'Invalid JSON payload' });
  }
  if (err && err.message === 'Not allowed by CORS') {
    return res.status(403).json({ error: 'CORS origin denied' });
  }
  if (err && err.name === 'PayloadTooLargeError') {
    return res.status(413).json({ error: 'Payload too large' });
  }
  console.error('Unhandled error:', err);
  return res.status(500).json({ error: 'Server error' });
});

app.listen(PORT, () => {
  console.log(`Static assets served from ${assetsRoot}`);
  console.log(`Server running on port ${PORT}`);
});
