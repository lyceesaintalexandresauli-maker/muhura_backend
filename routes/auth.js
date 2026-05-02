const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const rateLimit = require('express-rate-limit');
const pool = require('../db');
const {
  getSupabaseAdminClient,
  getSupabaseAuthClient,
  getSupabaseConfigStatus,
  canUseSupabaseAuthClient,
  canUseSupabaseAdminClient,
} = require('../supabase');

const router = express.Router();
const validRoles = new Set(['admin', 'teacher', 'secretary', 'dos']);
const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const usernameRegex = /^[a-zA-Z0-9_.-]{3,50}$/;

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many authentication attempts. Please try again later.' },
});

router.use(authLimiter);

const profileUploadRoot = path.join(__dirname, '../uploads/profiles');
if (!fs.existsSync(profileUploadRoot)) {
  fs.mkdirSync(profileUploadRoot, { recursive: true });
}

const profileStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, profileUploadRoot),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    cb(null, `user_${req.user.id}_${Date.now()}${ext}`);
  },
});

const profileImageUpload = multer({
  storage: profileStorage,
  limits: { fileSize: 3 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype && file.mimetype.startsWith('image/')) {
      return cb(null, true);
    }
    return cb(new Error('Only image files are allowed'));
  },
});

const respondSupabaseConfigError = (res, mode = 'auth') => {
  const status = getSupabaseConfigStatus();
  const issues = status.issues || [];
  const filteredIssues = mode === 'admin'
    ? issues.filter((issue) => issue !== 'SUPABASE_ANON_KEY is missing')
    : issues;

  return res.status(503).json({
    error:
      mode === 'admin'
        ? 'Supabase admin features are not configured correctly'
        : 'Supabase authentication is not configured correctly',
    details: filteredIssues,
  });
};

const pickProfile = (row) => ({
  id: row.id,
  auth_user_id: row.auth_user_id,
  username: row.username,
  email: row.email,
  full_name: row.full_name,
  phone: row.phone,
  bio: row.bio,
  profile_image: row.profile_image,
  role: row.role,
  is_active: row.is_active,
  created_at: row.created_at,
});

const ensureLocalProfileForAuthUser = async (authUser) => {
  if (!authUser?.id || !authUser?.email) {
    return null;
  }

  let result = await pool.query(
    `SELECT id, auth_user_id, username, email, full_name, phone, bio, profile_image, role, is_active, created_at
     FROM users
     WHERE auth_user_id = $1
     LIMIT 1`,
    [authUser.id]
  );
  if (result.rows.length > 0) {
    return result.rows[0];
  }

  result = await pool.query(
    `UPDATE users
     SET auth_user_id = $1
     WHERE auth_user_id IS NULL AND LOWER(TRIM(email)) = LOWER(TRIM($2))
     RETURNING id, auth_user_id, username, email, full_name, phone, bio, profile_image, role, is_active, created_at`,
    [authUser.id, authUser.email]
  );
  if (result.rows.length > 0) {
    return result.rows[0];
  }

  const metadataRole = String(authUser?.app_metadata?.role || "").trim().toLowerCase();
  const role = validRoles.has(metadataRole) ? metadataRole : 'teacher';
  const rawUsername =
    String(authUser?.user_metadata?.username || authUser?.email?.split("@")[0] || "").trim() || `user_${authUser.id.slice(0, 8)}`;
  const usernameSeed = rawUsername.replace(/[^a-zA-Z0-9_.-]/g, "_") || "user";
  const usernameSuffix = authUser.id.replace(/-/g, "").slice(0, 6).toLowerCase();
  const safeUsernameBase = `${usernameSeed}_${usernameSuffix}`.slice(0, 50);
  const safeUsername = safeUsernameBase.length >= 3 ? safeUsernameBase : `user_${usernameSuffix}`;
  const fullName = authUser?.user_metadata?.full_name || null;
  const phone = authUser?.user_metadata?.phone || null;
  const bio = authUser?.user_metadata?.bio || null;

  result = await pool.query(
    `INSERT INTO users (auth_user_id, username, email, full_name, phone, bio, role, is_active)
     VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE)
     ON CONFLICT (email) DO UPDATE SET auth_user_id = EXCLUDED.auth_user_id
     RETURNING id, auth_user_id, username, email, full_name, phone, bio, profile_image, role, is_active, created_at`,
    [authUser.id, safeUsername, String(authUser.email).trim().toLowerCase(), fullName, phone, bio, role]
  );
  if (result.rows.length > 0) {
    return result.rows[0];
  }

  return null;
};

const buildUserContext = (profile, authUser) => ({
  id: profile.id,
  auth_user_id: profile.auth_user_id,
  username: profile.username,
  email: profile.email,
  role: profile.role,
  is_active: profile.is_active,
  auth_email: authUser?.email || profile.email,
});

const authenticateToken = async (req, res, next) => {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  if (!canUseSupabaseAuthClient()) {
    return respondSupabaseConfigError(res, 'auth');
  }

  try {
    const supabase = getSupabaseAuthClient();
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user) {
      return res.status(401).json({ error: 'Invalid or expired Supabase session' });
    }

    const profile = await ensureLocalProfileForAuthUser(data.user);
    if (!profile) {
      return res.status(403).json({ error: 'No staff profile is linked to this Supabase account' });
    }

    if (!profile.is_active) {
      return res.status(403).json({ error: 'Account is disabled' });
    }

    req.supabaseAccessToken = token;
    req.supabaseUser = data.user;
    req.user = buildUserContext(profile, data.user);
    return next();
  } catch (err) {
    console.error('[Auth] Token verification failed:', err.message);
    return respondSupabaseConfigError(res, 'auth');
  }
};

const authorizeRoles =
  (...roles) =>
  (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    return next();
  };

router.post('/register', async (req, res) => {
  try {
    const { username, email, password, role: requestedRole, setupKey, full_name = null, phone = null, bio = null } = req.body;

    if (!username || !email || !password || !requestedRole) {
      return res.status(400).json({ error: 'username, email, password and role are required' });
    }
    if (!usernameRegex.test(String(username))) {
      return res.status(400).json({ error: 'Invalid username format' });
    }
    if (!emailRegex.test(String(email).trim().toLowerCase())) {
      return res.status(400).json({ error: 'Invalid email format' });
    }
    if (String(password).length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters long' });
    }
    if (!validRoles.has(requestedRole)) {
      return res.status(400).json({ error: 'Invalid role. Allowed roles: admin, teacher, secretary, dos' });
    }
    if (!process.env.ADMIN_SETUP_KEY || setupKey !== process.env.ADMIN_SETUP_KEY) {
      return res.status(403).json({ error: 'Invalid setup key for staff user creation' });
    }

    if (!canUseSupabaseAdminClient()) {
      return respondSupabaseConfigError(res, 'admin');
    }

    const normalizedEmail = String(email).trim().toLowerCase();
    const normalizedUsername = String(username).trim();

    const exists = await pool.query('SELECT 1 FROM users WHERE email = $1 OR username = $2', [normalizedEmail, normalizedUsername]);
    if (exists.rows.length > 0) {
      return res.status(400).json({ error: 'User already exists' });
    }

    const adminClient = getSupabaseAdminClient();
    const { data: created, error: createError } = await adminClient.auth.admin.createUser({
      email: normalizedEmail,
      password: String(password),
      email_confirm: true,
      user_metadata: {
        username: normalizedUsername,
        full_name,
        phone,
        bio,
      },
      app_metadata: {
        role: requestedRole,
      },
    });

    if (createError || !created?.user) {
      return res.status(400).json({ error: createError?.message || 'Failed to create Supabase user' });
    }

    const profileResult = await pool.query(
      `INSERT INTO users (auth_user_id, username, email, full_name, phone, bio, role, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE)
       RETURNING id, auth_user_id, username, email, full_name, phone, bio, profile_image, role, is_active, created_at`,
      [created.user.id, normalizedUsername, normalizedEmail, full_name, phone, bio, requestedRole]
    );

    return res.status(201).json(pickProfile(profileResult.rows[0]));
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
});

router.get('/me', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, auth_user_id, username, email, full_name, phone, bio, profile_image, role, is_active, created_at
       FROM users
       WHERE id = $1`,
      [req.user.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    return res.json(pickProfile(result.rows[0]));
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
});

router.put('/me', authenticateToken, async (req, res) => {
  try {
    const { username, email, full_name, phone, bio } = req.body;
    if (username && !usernameRegex.test(String(username).trim())) {
      return res.status(400).json({ error: 'Invalid username format' });
    }
    if (email && !emailRegex.test(String(email).trim().toLowerCase())) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    const currentResult = await pool.query(
      `SELECT id, auth_user_id, username, email, full_name, phone, bio, profile_image, role, is_active, created_at
       FROM users WHERE id = $1`,
      [req.user.id]
    );
    if (currentResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const current = currentResult.rows[0];
    const nextUsername = username ? String(username).trim() : current.username;
    const nextEmail = email ? String(email).trim().toLowerCase() : current.email;
    const nextFullName = full_name !== undefined ? full_name : current.full_name;
    const nextPhone = phone !== undefined ? phone : current.phone;
    const nextBio = bio !== undefined ? bio : current.bio;

    const duplicate = await pool.query(
      'SELECT 1 FROM users WHERE (email = $1 OR username = $2) AND id <> $3',
      [nextEmail, nextUsername, req.user.id]
    );
    if (duplicate.rows.length > 0) {
      return res.status(400).json({ error: 'Email or username already in use' });
    }

    if (!current.auth_user_id) {
      return res.status(400).json({ error: 'This profile is not linked to a Supabase account yet' });
    }
    if (!canUseSupabaseAdminClient()) {
      return respondSupabaseConfigError(res, 'admin');
    }

    const adminClient = getSupabaseAdminClient();
    const { error: updateAuthError } = await adminClient.auth.admin.updateUserById(current.auth_user_id, {
      email: nextEmail,
      user_metadata: {
        username: nextUsername,
        full_name: nextFullName,
        phone: nextPhone,
        bio: nextBio,
      },
    });
    if (updateAuthError) {
      return res.status(400).json({ error: updateAuthError.message || 'Failed to update Supabase account' });
    }

    const result = await pool.query(
      `UPDATE users
       SET username = $1, email = $2, full_name = $3, phone = $4, bio = $5
       WHERE id = $6
       RETURNING id, auth_user_id, username, email, full_name, phone, bio, profile_image, role, is_active, created_at`,
      [nextUsername, nextEmail, nextFullName, nextPhone, nextBio, req.user.id]
    );
    return res.json(pickProfile(result.rows[0]));
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
});

router.put('/me/password', authenticateToken, async (req, res) => {
  try {
    const newPassword = String(req.body?.new_password || '').trim();
    if (newPassword.length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters long' });
    }

    const userResult = await pool.query('SELECT auth_user_id FROM users WHERE id = $1', [req.user.id]);
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const authUserId = userResult.rows[0].auth_user_id;
    if (!authUserId) {
      return res.status(400).json({ error: 'This profile is not linked to a Supabase account yet' });
    }
    if (!canUseSupabaseAdminClient()) {
      return respondSupabaseConfigError(res, 'admin');
    }

    const adminClient = getSupabaseAdminClient();
    const { error: updateError } = await adminClient.auth.admin.updateUserById(authUserId, {
      password: newPassword,
    });
    if (updateError) {
      return res.status(400).json({ error: updateError.message || 'Failed to update Supabase password' });
    }

    return res.json({ message: 'Password updated successfully' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
});

router.post('/me/profile-image', authenticateToken, profileImageUpload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No image uploaded' });
    }
    const publicPath = `/uploads/profiles/${req.file.filename}`;
    const result = await pool.query(
      `UPDATE users
       SET profile_image = $1
       WHERE id = $2
       RETURNING id, auth_user_id, username, email, full_name, phone, bio, profile_image, role, is_active, created_at`,
      [publicPath, req.user.id]
    );
    return res.json(pickProfile(result.rows[0]));
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
});

module.exports = { router, authenticateToken, authorizeRoles, ensureLocalProfileForAuthUser, pickProfile };
