import { adminClient } from '../src/server/supabase.js';
import { ok, fail, body } from '../src/server/http.js';
import { email, requiredString, oneOf, interests } from '../src/server/validation.js';

const safeNewUserRole = role => role === 'advertiser' ? 'advertiser' : 'earner';

async function ensureProfile(user) {
  const { data: existing, error: lookupError } = await adminClient
    .from('profiles')
    .select('*')
    .eq('id', user.id)
    .maybeSingle();
  if (lookupError) throw lookupError;
  if (existing) return existing;

  // Never create an administrator from browser-controlled metadata. A missing
  // profile is repaired as earner/advertiser only; administrator access must
  // be granted separately by a trusted database operator.
  const metadata = user.user_metadata || {};
  const role = safeNewUserRole(metadata.role);
  const { data: created, error: createError } = await adminClient
    .from('profiles')
    .upsert({
      id: user.id,
      email: user.email,
      full_name: metadata.full_name || 'New member',
      role,
      gender: 'prefer_not_to_say'
    }, { onConflict: 'id' })
    .select()
    .single();
  if (createError) throw new Error('Your account profile is missing. Apply the YOLOTASK SQL package in Supabase, then try again.');

  await adminClient.from('wallets').upsert({ profile_id: user.id }, { onConflict: 'profile_id' });
  return created;
}

export default async function handler(req, res) {
  try {
    const action = new URL(req.url, `http://${req.headers.host || 'localhost'}`).searchParams.get('action') || 'session';

    if (action === 'register' && req.method === 'POST') {
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
      if (error) throw error;
      const profile = await ensureProfile(data.user);
      const { error: profileError } = await adminClient.from('profiles').update({ email: mail, full_name, role, gender }).eq('id', data.user.id);
      if (profileError) throw profileError;
      if (selected.length) {
        const { data: rows, error: interestError } = await adminClient.from('interests').select('id,name').in('name', selected);
        if (interestError) throw interestError;
        if (rows.length !== selected.length) throw new Error('One or more interests are unavailable.');
        await adminClient.from('profile_interests').insert(rows.map(row => ({ profile_id: data.user.id, interest_id: row.id })));
      }
      return ok(res, { user: { ...profile, email: mail, full_name, role, gender }, requires_email_confirmation: false });
    }

    if (action === 'login' && req.method === 'POST') {
      const input = await body(req);
      const { data, error } = await adminClient.auth.signInWithPassword({
        email: email(input.email),
        password: requiredString(input.password, 'Password', 128)
      });
      if (error || !data.user) throw Object.assign(new Error('Email or password is incorrect.'), { status: 401 });
      const profile = await ensureProfile(data.user);
      const dashboard_path = profile.role === 'admin' ? '/admin/index.html' : profile.role === 'advertiser' ? '/advertiser/index.html' : '/earner/index.html';
      return ok(res, { user: profile, session: data.session, dashboard_path });
    }

    if (action === 'profile' && req.method === 'PATCH') {
      const { requireUser } = await import('../src/server/supabase.js');
      const { profile } = await requireUser(req, ['earner', 'advertiser']);
      const input = await body(req);
      const changes = {};
      if (input.full_name !== undefined) changes.full_name = requiredString(input.full_name, 'Full name', 120);
      if (input.gender !== undefined) changes.gender = oneOf(input.gender, 'Gender', ['male', 'female', 'prefer_not_to_say']);
      const { data, error } = await adminClient.from('profiles').update(changes).eq('id', profile.id).select().single();
      if (error) throw error;
      if (input.interests !== undefined) {
        const selected = interests(input.interests, profile.role === 'earner' ? 3 : 0);
        const { data: rows } = await adminClient.from('interests').select('id,name').in('name', selected);
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
