const { createClient } = require('@supabase/supabase-js');

const readEnv = (key) => String(process.env[key] || '').trim();

const resolveProjectRef = () => {
  const explicitRef = readEnv('SUPABASE_PROJECT_REF');
  if (explicitRef) return explicitRef;

  const dbUser = readEnv('DB_USER');
  const match = dbUser.match(/^postgres\.([a-z0-9]+)$/i);
  if (match) return match[1];

  const databaseUrl = readEnv('DATABASE_URL');
  const urlMatch = databaseUrl.match(/postgres\.([a-z0-9]+)@/i);
  if (urlMatch) return urlMatch[1];

  return null;
};

const getSupabaseUrl = () => {
  const explicitUrl = readEnv('SUPABASE_URL');
  if (explicitUrl) {
    if (!/^https?:\/\//i.test(explicitUrl)) {
      throw new Error('SUPABASE_URL must be a full http(s) URL');
    }
    return explicitUrl;
  }

  const projectRef = resolveProjectRef();
  if (!projectRef) {
    throw new Error('SUPABASE_URL is not configured and project ref could not be derived');
  }

  return `https://${projectRef}.supabase.co`;
};

const getSupabaseAnonKey = () => {
  const key = readEnv('SUPABASE_ANON_KEY') || readEnv('SUPABASE_PUBLISHABLE_KEY');
  if (!key) {
    throw new Error('SUPABASE_ANON_KEY is not configured');
  }
  return key;
};

const getSupabaseServiceRoleKey = () => {
  const key = readEnv('SUPABASE_SERVICE_ROLE_KEY');
  if (!key) {
    throw new Error('SUPABASE_SERVICE_ROLE_KEY is not configured');
  }
  return key;
};

const getSupabaseConfigStatus = () => {
  const projectRef = resolveProjectRef();
  const explicitUrl = readEnv('SUPABASE_URL');
  const anonKey = readEnv('SUPABASE_ANON_KEY') || readEnv('SUPABASE_PUBLISHABLE_KEY');
  const serviceRoleKey = readEnv('SUPABASE_SERVICE_ROLE_KEY');
  const issues = [];

  let resolvedUrl = '';
  try {
    resolvedUrl = getSupabaseUrl();
  } catch (error) {
    issues.push(error.message);
  }

  if (!anonKey) {
    issues.push('SUPABASE_ANON_KEY is missing');
  }
  if (!serviceRoleKey) {
    issues.push('SUPABASE_SERVICE_ROLE_KEY is missing');
  }

  return {
    projectRef,
    explicitUrlConfigured: Boolean(explicitUrl),
    resolvedUrl,
    anonConfigured: Boolean(anonKey),
    serviceRoleConfigured: Boolean(serviceRoleKey),
    storageBucket: readEnv('SUPABASE_STORAGE_BUCKET') || 'uploads',
    issues,
  };
};

const canUseSupabaseAuthClient = () => {
  const status = getSupabaseConfigStatus();
  return Boolean(status.resolvedUrl && (status.anonConfigured || status.serviceRoleConfigured));
};

const canUseSupabaseAdminClient = () => {
  const status = getSupabaseConfigStatus();
  return Boolean(status.resolvedUrl && status.serviceRoleConfigured);
};

const createServerClient = (key) =>
  createClient(getSupabaseUrl(), key, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  });

let adminClient;
let authClient;

const getSupabaseAdminClient = () => {
  if (!adminClient) {
    adminClient = createServerClient(getSupabaseServiceRoleKey());
  }
  return adminClient;
};

const getSupabaseAuthClient = () => {
  if (!authClient) {
    const authKey = readEnv('SUPABASE_ANON_KEY') || readEnv('SUPABASE_PUBLISHABLE_KEY') || readEnv('SUPABASE_SERVICE_ROLE_KEY');
    if (!authKey) {
      throw new Error('A Supabase auth key is required. Set SUPABASE_ANON_KEY or SUPABASE_SERVICE_ROLE_KEY.');
    }
    authClient = createServerClient(authKey);
  }
  return authClient;
};

module.exports = {
  getSupabaseUrl,
  getSupabaseAnonKey,
  getSupabaseServiceRoleKey,
  getSupabaseConfigStatus,
  canUseSupabaseAuthClient,
  canUseSupabaseAdminClient,
  getSupabaseAdminClient,
  getSupabaseAuthClient,
};
