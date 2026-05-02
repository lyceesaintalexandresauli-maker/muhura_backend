require('dotenv').config();
const pool = require('./db');
const { getSupabaseAdminClient } = require('./supabase');

(async () => {
  const resetEmail = String(process.env.ADMIN_RESET_EMAIL || 'jirasubiza1@gmail.com').trim().toLowerCase();
  const resetPassword = String(process.env.ADMIN_RESET_PASSWORD || 'admin123');

  try {
    const profileResult = await pool.query(
      'SELECT id, auth_user_id, email FROM users WHERE LOWER(TRIM(email)) = LOWER(TRIM($1)) LIMIT 1',
      [resetEmail]
    );

    if (profileResult.rows.length === 0) {
      throw new Error(`No local profile found for ${resetEmail}`);
    }

    const profile = profileResult.rows[0];
    if (!profile.auth_user_id) {
      throw new Error(`Profile ${resetEmail} is not linked to Supabase Auth yet. Create the auth user first and link by email.`);
    }

    const adminClient = getSupabaseAdminClient();
    const { error } = await adminClient.auth.admin.updateUserById(profile.auth_user_id, {
      password: resetPassword,
      email_confirm: true,
    });

    if (error) {
      throw error;
    }

    console.log(`Supabase password updated for ${profile.email}`);
  } catch (err) {
    console.error(err.message || err);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
