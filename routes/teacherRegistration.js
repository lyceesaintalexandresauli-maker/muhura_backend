const express = require('express');
const rateLimit = require('express-rate-limit');
const pool = require('../db');
const { getSupabaseAdminClient, canUseSupabaseAdminClient, getSupabaseConfigStatus } = require('../supabase');

const router = express.Router();
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many registration attempts. Please try again later.' },
});
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Public self-registration deliberately accepts teacher fields only. New teachers
// can sign in immediately, but receive no classes/modules until an administrator
// creates academic module assignments for them.
router.post('/', registerLimiter, async (req, res) => {
  const fullName = String(req.body?.full_name || '').trim().slice(0, 120);
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');

  if (fullName.length < 2) return res.status(400).json({ error: 'Enter your full name.' });
  if (!emailPattern.test(email) || email.length > 100) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (password.length < 8 || password.length > 128) return res.status(400).json({ error: 'Password must be 8 to 128 characters.' });
  if (!canUseSupabaseAdminClient()) {
    const status = getSupabaseConfigStatus();
    return res.status(503).json({ error: 'Teacher registration is not configured.', details: (status.issues || []).filter((item) => item !== 'SUPABASE_ANON_KEY is missing') });
  }

  let authUserId = null;
  try {
    const duplicate = await pool.query('SELECT 1 FROM users WHERE LOWER(email) = $1 LIMIT 1', [email]);
    if (duplicate.rows.length) return res.status(409).json({ error: 'An account already exists for this email.' });

    const base = (email.split('@')[0] || 'teacher').replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 38) || 'teacher';
    const username = `${base}_${require('crypto').randomBytes(4).toString('hex')}`.slice(0, 50);
    const admin = getSupabaseAdminClient();
    const { data, error } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { username, full_name: fullName },
      app_metadata: { role: 'teacher' },
    });
    if (error || !data?.user?.id) return res.status(400).json({ error: error?.message || 'Could not create teacher account.' });
    authUserId = data.user.id;

    const created = await pool.query(
      `INSERT INTO users (auth_user_id, username, email, full_name, role, is_active)
       VALUES ($1, $2, $3, $4, 'teacher', TRUE)
       RETURNING id, username, email, full_name, role, is_active, created_at`,
      [authUserId, username, email, fullName]
    );
    return res.status(201).json({ ...created.rows[0], assignment_status: 'pending_assignments' });
  } catch (error) {
    if (authUserId) {
      try { await getSupabaseAdminClient().auth.admin.deleteUser(authUserId); } catch (cleanupError) {
        console.error('[TeacherRegistration] Auth rollback failed:', cleanupError.message);
      }
    }
    if (error.code === '23505') return res.status(409).json({ error: 'An account already exists for this email or username.' });
    console.error('[TeacherRegistration] Registration failed:', error);
    return res.status(500).json({ error: 'Unable to register teacher right now.' });
  }
});

module.exports = router;
