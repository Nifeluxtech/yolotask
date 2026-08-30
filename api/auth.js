import { randomBytes } from 'node:crypto';
import { adminClient, authClient, requireUser } from '../src/server/supabase.js';
import { ok, fail, body } from '../src/server/http.js';
import { email, requiredString, oneOf, interests } from '../src/server/validation.js';
import { enforceRateLimit } from '../src/server/rate-limit.js';

const safeNewUserRole = role => role === 'advertiser' ? 'advertiser' : 'earner';
const makeReferralCode = () => randomBytes(4).toString('hex').toUpperCase();

async function ensureProfile(user, details = {}) {
  const metadata = user.user_metadata || {};
  const hasRegistrationDetails = Object.keys(details).length > 0;
  const role = hasRegistrationDetails ? safeNewUserRole(details.role) : undefined;
  const fullName = details.full_name || metadata.full_name || 'New member';
  const gender = details.gender || 'prefer_not_to_say';
  const { data: existing, error: lookupError } = await adminClient
    .from('profiles')
    .select('*')
    .eq('id', user.id)
    .maybeSingle();
  if (lookupError) throw lookupError;

  let profile = existing;
  if (profile && (hasRegistrationDetails || !profile.referral_code)) {
    const changes = { referral_code: profile.referral_code || makeReferralCode() };
    if (hasRegistrationDetails) Object.assign(changes, { email: user.email, full_name: fullName, role, gender });
    const { data: updated, error: updateError } = await adminClient
      .from('profiles')
      .update(changes)
      .eq('id', user.id)
      .select()
      .single();
    if (updateError) throw updateError;
    profile = updated;
  }

  if (!profile) {
    const { data: created, error: createError } = await adminClient
      .from('profiles')
      .insert({
        id: user.id,
        email: user.email,
        full_name: fullName,
        role: role || safeNewUserRole(metadata.role),
        gender,
        referral_code: makeReferralCode()
      })
      .select()
      .single();
    if (createError) throw new Error(`Your account profile could not be created: ${createError.message}`);
    profile = created;
  }

  const { data: wallet, error: walletError } = await adminClient.rpc('ensure_wallet', { p_profile_id: user.id });
  if (walletError || !wallet) throw new Error(`Your account wallet could not be created: ${walletError?.message || 'wallet repair returned no row'}`);
  return profile;
}

export default async function handler(req, res) {
  try {
    const action = new URL(req.url, `http://${req.headers.host || 'localhost'}`).searchParams.get('action') || 'session';

    if (action === 'interests' && req.method === 'GET') {
      if (!adminClient) throw Object.assign(new Error('Supabase server configuration is missing.'), { status: 500 });
      const { data, error } = await adminClient
        .from('interests')
        .select('name,is_active,interest_categories(name,sort_order,is_active)')
        .eq('is_active', true)
        .order('name', { ascending: true });
      if (error) throw error;
      const rows = (data || []).filter(row => row.interest_categories?.is_active !== false);
      rows.sort((a, b) => (a.interest_categories?.sort_order ?? 999) - (b.interest_categories?.sort_order ?? 999) || a.name.localeCompare(b.name));
      return ok(res, { interests: rows.map(row => row.name) });
    }

    if (action === 'register' && req.method === 'POST') {
      if (!adminClient || !authClient) throw Object.assign(new Error('Supabase server configuration is missing.'), { status: 500 });
      await enforceRateLimit(req, 'auth:register');
      const input = await body(req);
      const mail = email(input.email);
      const password = requiredString(input.password, 'Password', 128);
      if (password.length < 8) throw new Error('Password must be at least 8 characters.');
      const role = oneOf(input.role || 'earner', 'Role', ['earner', 'advertiser']);
      const full_name = requiredString(input.full_name, 'Full name', 120);
      const gender = oneOf(input.gender || 'prefer_not_to_say', 'Gender', ['male', 'female', 'prefer_not_to_say']);
      const selected = role === 'earner' ? interests(input.interests, 3) : [];
      const { data, error } = await adminClient.auth.admin.createUser({
        email: mail,
        password,
        email_confirm: true,
        user_metadata: { full_name, role }
      });
      if (error || !data?.user) {
        console.error('YOLOTASK Auth user creation failed:', { code: error?.code, status: error?.status, message: error?.message });
        if (error?.message === 'Database error creating new user') {
          throw new Error('Registration database setup is incomplete. Apply 012_role_enum_patch.sql, wait for it to commit, then apply 016_registration_trigger_hardening.sql.');
        }
        throw error || new Error('User creation failed.');
      }

      const profile = await ensureProfile(data.user, { full_name, role, gender });
      if (selected.length) {
        const { data: rows, error: interestError } = await adminClient.from('interests').select('id,name').in('name', selected);
        if (interestError) throw interestError;
        if (!rows || rows.length !== selected.length) throw new Error('One or more interests are unavailable.');
        const { error: profileInterestError } = await adminClient.from('profile_interests').insert(rows.map(row => ({ profile_id: data.user.id, interest_id: row.id })));
        if (profileInterestError) throw profileInterestError;
      }

      const { data: signInData, error: signInError } = await authClient.auth.signInWithPassword({ email: mail, password });
      if (signInError) throw signInError;
      const dashboard_path = profile.role === 'advertiser' ? '/advertiser/index.html' : '/earner/index.html';
      return ok(res, {
        user: profile,
        session: signInData.session,
        requires_email_confirmation: false,
        dashboard_path
      });
    }

    if (action === 'login' && req.method === 'POST') {
      if (!authClient) throw Object.assign(new Error('Supabase server configuration is missing.'), { status: 500 });
      await enforceRateLimit(req, 'auth:login');
      const input = await body(req);
      const { data, error } = await authClient.auth.signInWithPassword({
        email: email(input.email),
        password: requiredString(input.password, 'Password', 128)
      });
      if (error || !data?.user) throw Object.assign(new Error('Email or password is incorrect.'), { status: 401 });
      const profile = await ensureProfile(data.user);
      const dashboard_path = profile.role === 'admin' ? '/admin/index.html' : profile.role === 'advertiser' ? '/advertiser/index.html' : '/earner/index.html';
      return ok(res, { user: profile, session: data.session, dashboard_path });
    }

    if (action === 'session' && req.method === 'GET') {
      const { authUser, profile } = await requireUser(req);
      const dashboard_path = profile.role === 'admin' ? '/admin/index.html' : profile.role === 'advertiser' ? '/advertiser/index.html' : '/earner/index.html';
      return ok(res, { user: profile, auth_user_id: authUser.id, dashboard_path });
    }

    if (action === 'profile' && req.method === 'PATCH') {
      const { profile } = await requireUser(req, ['earner', 'advertiser']);
      const input = await body(req);
      const changes = {};
      if (input.full_name !== undefined) changes.full_name = requiredString(input.full_name, 'Full name', 120);
      if (input.gender !== undefined) changes.gender = oneOf(input.gender, 'Gender', ['male', 'female', 'prefer_not_to_say']);
      const { data, error } = await adminClient.from('profiles').update(changes).eq('id', profile.id).select().single();
      if (error) throw error;
      if (input.interests !== undefined) {
        const selected = interests(input.interests, profile.role === 'earner' ? 3 : 0);
        const { data: rows, error: rowError } = await adminClient.from('interests').select('id,name').in('name', selected);
        if (rowError) throw rowError;
        await adminClient.from('profile_interests').delete().eq('profile_id', profile.id);
        if (rows?.length) await adminClient.from('profile_interests').insert(rows.map(row => ({ profile_id: profile.id, interest_id: row.id })));
      }
      return ok(res, { user: data });
    }

    return fail(res, 405, 'Method or action not supported.');
  } catch (error) {
    return fail(res, error.status || 400, error.message || 'Authentication request failed.');
  }
}
