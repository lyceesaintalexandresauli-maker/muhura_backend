const express = require('express');
const pool = require('../db');
const { authenticateToken, authorizeRoles, pickProfile } = require('./auth');
const { getSupabaseAdminClient, canUseSupabaseAdminClient, getSupabaseConfigStatus } = require('../supabase');

const router = express.Router();
const adminOnly = [authenticateToken, authorizeRoles('admin')];
const validRoles = new Set(['admin', 'teacher', 'secretary', 'dos']);
const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const usernameRegex = /^[a-zA-Z0-9_.-]{3,50}$/;

const respondSupabaseConfigError = (res) => {
  const status = getSupabaseConfigStatus();
  return res.status(503).json({
    error: 'Supabase admin features are not configured correctly',
    details: (status.issues || []).filter((issue) => issue !== 'SUPABASE_ANON_KEY is missing'),
  });
};

const getProfileById = async (id) => {
  const result = await pool.query(
    `SELECT id, auth_user_id, username, email, full_name, phone, bio, profile_image, role, is_active, created_at
     FROM users
     WHERE id = $1`,
    [id]
  );
  return result.rows[0] || null;
};

router.get('/', ...adminOnly, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, auth_user_id, username, email, full_name, phone, bio, profile_image, role, is_active, created_at
       FROM users
       ORDER BY created_at DESC`
    );
    return res.json(result.rows.map(pickProfile));
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
});

router.post('/', ...adminOnly, async (req, res) => {
  try {
    const { username, email, password, role, full_name = null, phone = null, bio = null } = req.body;
    if (!username || !email || !password || !role) {
      return res.status(400).json({ error: 'username, email, password and role are required' });
    }
    if (!usernameRegex.test(String(username))) {
      return res.status(400).json({ error: 'Invalid username format' });
    }
    if (!emailRegex.test(String(email).trim().toLowerCase())) {
      return res.status(400).json({ error: 'Invalid email format' });
    }
    if (!validRoles.has(role)) {
      return res.status(400).json({ error: 'Invalid role. Allowed roles: admin, teacher, secretary, dos' });
    }
    if (String(password).length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters long' });
    }
    if (!canUseSupabaseAdminClient()) {
      return respondSupabaseConfigError(res);
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
        role,
      },
    });

    if (createError || !created?.user) {
      return res.status(400).json({ error: createError?.message || 'Failed to create Supabase user' });
    }

    const result = await pool.query(
      `INSERT INTO users (auth_user_id, username, email, full_name, phone, bio, role, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE)
       RETURNING id, auth_user_id, username, email, full_name, phone, bio, profile_image, role, is_active, created_at`,
      [created.user.id, normalizedUsername, normalizedEmail, full_name, phone, bio, role]
    );
    return res.status(201).json(pickProfile(result.rows[0]));
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
});

router.put('/:id', ...adminOnly, async (req, res) => {
  try {
    const { id } = req.params;
    const { username, email, role, is_active, full_name = null, phone = null, bio = null, profile_image = null } = req.body;

    if (!username || !email || !role || typeof is_active !== 'boolean') {
      return res.status(400).json({ error: 'username, email, role and is_active are required' });
    }
    if (!usernameRegex.test(String(username))) {
      return res.status(400).json({ error: 'Invalid username format' });
    }
    if (!emailRegex.test(String(email).trim().toLowerCase())) {
      return res.status(400).json({ error: 'Invalid email format' });
    }
    if (!validRoles.has(role)) {
      return res.status(400).json({ error: 'Invalid role. Allowed roles: admin, teacher, secretary, dos' });
    }

    const normalizedEmail = String(email).trim().toLowerCase();
    const normalizedUsername = String(username).trim();

    const duplicate = await pool.query(
      'SELECT 1 FROM users WHERE (email = $1 OR username = $2) AND id <> $3',
      [normalizedEmail, normalizedUsername, id]
    );
    if (duplicate.rows.length > 0) {
      return res.status(400).json({ error: 'Email or username already in use' });
    }

    const current = await getProfileById(id);
    if (!current) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (current.auth_user_id) {
      if (!canUseSupabaseAdminClient()) {
        return respondSupabaseConfigError(res);
      }
      const adminClient = getSupabaseAdminClient();
      const { error: updateAuthError } = await adminClient.auth.admin.updateUserById(current.auth_user_id, {
        email: normalizedEmail,
        user_metadata: {
          username: normalizedUsername,
          full_name,
          phone,
          bio,
        },
        app_metadata: {
          role,
        },
        ban_duration: is_active ? 'none' : '876000h',
      });
      if (updateAuthError) {
        return res.status(400).json({ error: updateAuthError.message || 'Failed to update Supabase user' });
      }
    }

    const result = await pool.query(
      `UPDATE users
       SET username = $1, email = $2, role = $3, is_active = $4,
           full_name = $5, phone = $6, bio = $7, profile_image = $8
       WHERE id = $9
       RETURNING id, auth_user_id, username, email, full_name, phone, bio, profile_image, role, is_active, created_at`,
      [normalizedUsername, normalizedEmail, role, is_active, full_name, phone, bio, profile_image, id]
    );

    return res.json(pickProfile(result.rows[0]));
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
});

router.put('/:id/password', ...adminOnly, async (req, res) => {
  try {
    const { id } = req.params;
    const { password } = req.body;
    if (!password || String(password).length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters long' });
    }

    const current = await getProfileById(id);
    if (!current) {
      return res.status(404).json({ error: 'User not found' });
    }
    if (!current.auth_user_id) {
      return res.status(400).json({ error: 'This profile is not linked to a Supabase account yet' });
    }
    if (!canUseSupabaseAdminClient()) {
      return respondSupabaseConfigError(res);
    }

    const adminClient = getSupabaseAdminClient();
    const { error: updateError } = await adminClient.auth.admin.updateUserById(current.auth_user_id, {
      password: String(password),
    });
    if (updateError) {
      return res.status(400).json({ error: updateError.message || 'Failed to reset Supabase password' });
    }

    return res.json({ message: 'Password reset successfully' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
});

router.delete('/:id', ...adminOnly, async (req, res) => {
  try {
    const { id } = req.params;

    if (Number(id) === Number(req.user.id)) {
      return res.status(400).json({ error: 'You cannot delete your own account' });
    }

    const current = await getProfileById(id);
    if (!current) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (current.auth_user_id) {
      if (!canUseSupabaseAdminClient()) {
        return respondSupabaseConfigError(res);
      }
      const adminClient = getSupabaseAdminClient();
      const { error: deleteAuthError } = await adminClient.auth.admin.deleteUser(current.auth_user_id);
      if (deleteAuthError) {
        return res.status(400).json({ error: deleteAuthError.message || 'Failed to delete Supabase user' });
      }
    }

    await pool.query('DELETE FROM users WHERE id = $1', [id]);
    return res.json({ message: 'User deleted' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
