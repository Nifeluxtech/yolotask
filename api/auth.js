// /api/auth.js
const { supabaseAdmin } = require('../lib/supabase');
const { getAuthenticatedUser, requireRole, getPlatformFlag } = require('../lib/auth');
const { sendSuccess, sendError } = require('../lib/response');

const isActive = (r) =>
  r.is_active === undefined || r.is_active === null ||
  r.is_active === true || r.is_active === 'true' || r.is_active === 't';

// Run a Supabase query, retry once after 400ms on error
async function q(fn) {
  const first = await fn();
  if (!first.error) return first;
  await new Promise(r => setTimeout(r, 400));
  const second = await fn();
  if (second.error) console.error('QUERY FAILED AFTER RETRY:', second.error);
  return second;
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return sendError(res, 'METHOD_NOT_ALLOWED', 'Only POST allowed.', 405);

  try {
    const { action } = req.body;
    if (!action) return sendError(res, 'VALIDATION_ERROR', 'Missing action.', 400);

    switch (action) {
      case 'register': {
        const open = await getPlatformFlag('registrations_open');
        if (open === false || open === 'false') {
          return sendError(res, 'REGISTRATION_CLOSED', 'New registrations are temporarily closed.', 403);
        }

        const { email, password, full_name, gender, role, interests, referral_code } = req.body;
        if (!email || !password || !full_name) return sendError(res, 'VALIDATION_ERROR', 'Missing required fields.', 400);
        if (password.length < 8) return sendError(res, 'VALIDATION_ERROR', 'Password must be at least 8 characters.', 400);

        const allowedRoles = ['earner', 'advertiser'];
        const finalRole = allowedRoles.includes(role) ? role : 'earner';
        if (finalRole === 'earner' && (!interests || !Array.isArray(interests) || interests.length < 3)) {
          return sendError(res, 'VALIDATION_ERROR', 'Select at least 3 interests.', 400);
        }

        let validReferralCode = null;
        if (referral_code) {
          const { data: referrer } = await supabaseAdmin.from('profiles').select('id').eq('referral_code', referral_code).maybeSingle();
          if (referrer) validReferralCode = referral_code;
        }

        const { data, error } = await supabaseAdmin.auth.admin.createUser({
          email, password, email_confirm: true,
          user_metadata: {
            full_name,
            gender: gender || null,
            role: finalRole,
            interests: finalRole === 'earner' && interests ? interests.join(',') : null,
            referral_code: validReferralCode
          }
        });

        if (error) {
          console.error('Supabase create user error:', error);
          return sendError(res, 'REGISTRATION_FAILED', error.message, 400);
        }
        return sendSuccess(res, { userId: data.user.id }, 'Registration successful.');
      }

      case 'login': {
        const { email, password } = req.body;
        if (!email || !password) return sendError(res, 'VALIDATION_ERROR', 'Credentials required.', 400);
        const { data, error } = await supabaseAdmin.auth.signInWithPassword({ email, password });
        if (error) return sendError(res, 'LOGIN_FAILED', 'Invalid email or password.', 401);
        return sendSuccess(res, { session: data.session }, 'Login successful.');
      }

      case 'forgot-password': {
        const { email } = req.body;
        if (!email) return sendError(res, 'VALIDATION_ERROR', 'Email required.', 400);
        await supabaseAdmin.auth.resetPasswordForEmail(email, { redirectTo: `${process.env.APP_URL || ''}/login.html` });
        return sendSuccess(res, {}, 'Reset link sent.');
      }

      case 'get-session': {
        const { user, profile } = await getAuthenticatedUser(req);
        return sendSuccess(res, {
          profile: { ...profile, email: user.email, email_verified: !!user.email_confirmed_at }
        });
      }

      case 'logout': {
        const { user } = await getAuthenticatedUser(req);
        await supabaseAdmin.auth.admin.signOut(user.id, 'global');
        return sendSuccess(res, {}, 'Logged out.');
      }

      case 'update_profile': {
        const { profile } = await getAuthenticatedUser(req);
        const { full_name, phone } = req.body;
        if (!full_name || full_name.trim().length < 2) return sendError(res, 'VALIDATION_ERROR', 'Display name is too short.', 400);

        let cleanPhone = null;
        if (phone && phone.trim() !== '') {
          cleanPhone = phone.replace(/[\s\-()]/g, '');
          if (!/^\+?\d{10,14}$/.test(cleanPhone)) return sendError(res, 'VALIDATION_ERROR', 'Invalid phone number format.', 400);
        }

        const { data, error } = await q(() => supabaseAdmin.from('profiles')
          .update({ full_name: full_name.trim(), phone: cleanPhone, updated_at: new Date().toISOString() })
          .eq('id', profile.id)
          .select('id, full_name, role, is_suspended, created_at, referral_code, phone, avatar_url')
          .single());

        if (error) throw error;
        return sendSuccess(res, { profile: data }, 'Profile updated.');
      }

      case 'upload_avatar': {
        const { profile } = await getAuthenticatedUser(req);
        const { dataUrl } = req.body;
        if (!dataUrl || !dataUrl.startsWith('data:image/')) return sendError(res, 'VALIDATION_ERROR', 'Invalid image data.', 400);

        const base64 = dataUrl.split(',')[1];
        if (!base64) return sendError(res, 'VALIDATION_ERROR', 'Empty image.', 400);
        const buffer = Buffer.from(base64, 'base64');
        if (buffer.length > 500 * 1024) return sendError(res, 'FILE_TOO_LARGE', 'Image must be under 500KB.', 400);

        const path = `${profile.id}.jpg`;

        // Retry once on storage flakiness
        let up = await supabaseAdmin.storage.from('avatars').upload(path, buffer, { contentType: 'image/jpeg', upsert: true });
        if (up.error) {
          await new Promise(r => setTimeout(r, 500));
          up = await supabaseAdmin.storage.from('avatars').upload(path, buffer, { contentType: 'image/jpeg', upsert: true });
        }
        if (up.error) {
          console.error('Avatar upload error:', up.error);
          throw { code: 'UPLOAD_FAILED', message: 'Storage error: ' + (up.error.message || 'upload failed'), statusCode: 502 };
        }

        const { data: pub } = supabaseAdmin.storage.from('avatars').getPublicUrl(path);
        const publicUrl = `${pub.publicUrl}?t=${Date.now()}`;

        const { error: dbErr } = await q(() => supabaseAdmin.from('profiles').update({ avatar_url: publicUrl }).eq('id', profile.id));
        if (dbErr) throw dbErr;

        return sendSuccess(res, { avatar_url: publicUrl }, 'Avatar updated.');
      }

      case 'change_password': {
        const { user } = await getAuthenticatedUser(req);
        const { currentPassword, newPassword } = req.body;
        if (!currentPassword || !newPassword) return sendError(res, 'VALIDATION_ERROR', 'Both passwords required.', 400);
        if (newPassword.length < 8) return sendError(res, 'VALIDATION_ERROR', 'New password must be at least 8 characters.', 400);

        const { error: verifyErr } = await supabaseAdmin.auth.signInWithPassword({ email: user.email, password: currentPassword });
        if (verifyErr) return sendError(res, 'INVALID_PASSWORD', 'Current password is incorrect.', 400);

        const { error: updateErr } = await supabaseAdmin.auth.admin.updateUserById(user.id, { password: newPassword });
        if (updateErr) throw updateErr;

        await supabaseAdmin.auth.admin.signOut(user.id, 'global');
        return sendSuccess(res, {}, 'Password changed. Please log in again.');
      }

      case 'sign_out_all': {
        const { user } = await getAuthenticatedUser(req);
        await supabaseAdmin.auth.admin.signOut(user.id, 'global');
        return sendSuccess(res, {}, 'All devices signed out.');
      }

      // ---------- SETTINGS DATA (retry + LOUD errors) ----------
      case 'get_settings_data': {
        const { profile } = await getAuthenticatedUser(req);

        const [interestsRes, taskTypesRes, myInterestsRes, hiddenRes] = await Promise.all([
          q(() => supabaseAdmin.from('interests').select('*')),
          q(() => supabaseAdmin.from('task_types').select('*')),
          q(() => supabaseAdmin.from('user_interests').select('interest_id').eq('user_id', profile.id)),
          q(() => supabaseAdmin.from('profiles').select('hidden_task_types').eq('id', profile.id).maybeSingle())
        ]);

        // FAIL LOUDLY instead of pretending the platform has no data
        if (interestsRes.error || taskTypesRes.error) {
          const msg = (interestsRes.error && interestsRes.error.message) || (taskTypesRes.error && taskTypesRes.error.message) || 'Unknown DB error';
          return sendError(res, 'SETTINGS_LOAD_FAILED', 'Database temporarily unavailable: ' + msg, 502);
        }

        const interests = (interestsRes.data || [])
          .filter(isActive)
          .map(i => ({ id: i.id, name: i.name, category: i.category }))
          .sort((a, b) => String(a.name).localeCompare(String(b.name)));

        const task_types = (taskTypesRes.data || [])
          .filter(isActive)
          .map(t => ({ id: t.id, name: t.name }))
          .sort((a, b) => String(a.name).localeCompare(String(b.name)));

        return sendSuccess(res, {
          version: 'auth-v5',
          interests,
          task_types,
          my_interest_ids: (myInterestsRes.data || []).map(i => i.interest_id),
          my_hidden_task_ids: (hiddenRes && hiddenRes.data && hiddenRes.data.hidden_task_types) || []
        });
      }

      case 'update_interests': {
        const { profile } = await getAuthenticatedUser(req);
        requireRole(profile, ['earner']);
        const { interest_ids } = req.body;

        if (!Array.isArray(interest_ids) || interest_ids.length < 3) {
          return sendError(res, 'VALIDATION_ERROR', 'Select at least 3 interests.', 400);
        }

        const { data: valid, error: vErr } = await q(() => supabaseAdmin.from('interests').select('id').in('id', interest_ids));
        if (vErr) throw vErr;
        if (!valid || valid.length !== interest_ids.length) {
          return sendError(res, 'VALIDATION_ERROR', 'One or more interests are invalid.', 400);
        }

        await supabaseAdmin.from('user_interests').delete().eq('user_id', profile.id);
        const { error } = await supabaseAdmin.from('user_interests')
          .insert(interest_ids.map(id => ({ user_id: profile.id, interest_id: id })));

        if (error) throw error;
        return sendSuccess(res, {}, 'Interests updated. Your task feed will now match.');
      }

      case 'update_task_prefs': {
        const { profile } = await getAuthenticatedUser(req);
        requireRole(profile, ['earner']);
        const { hidden_task_type_ids } = req.body;

        if (!Array.isArray(hidden_task_type_ids)) {
          return sendError(res, 'VALIDATION_ERROR', 'Invalid preference list.', 400);
        }

        let clean = hidden_task_type_ids;
        if (clean.length > 0) {
          const { data: valid } = await q(() => supabaseAdmin.from('task_types').select('id').in('id', clean));
          clean = (valid || []).map(t => t.id);
        }

        const { error } = await q(() => supabaseAdmin.from('profiles')
          .update({ hidden_task_types: clean, updated_at: new Date().toISOString() })
          .eq('id', profile.id));

        if (error) throw error;
        return sendSuccess(res, {}, 'Task preferences saved.');
      }

      case 'get_notifications': {
        const { profile } = await getAuthenticatedUser(req);
        const { data, error } = await q(() => supabaseAdmin.from('notifications').select('*')
          .eq('user_id', profile.id).order('created_at', { ascending: false }).limit(50));
        if (error) throw error;
        return sendSuccess(res, { notifications: data || [] });
      }

      case 'mark_notifications_read': {
        const { profile } = await getAuthenticatedUser(req);
        await q(() => supabaseAdmin.from('notifications').update({ is_read: true })
          .eq('user_id', profile.id).eq('is_read', false));
        return sendSuccess(res, {}, 'Marked as read.');
      }

      default:
        return sendError(res, 'INVALID_ACTION', 'Unknown action.', 400);
    }
  } catch (err) {
    if (err.code) return sendError(res, err.code, err.message, err.statusCode || 400);
    console.error('Auth API Error:', err);
    return sendError(res, 'INTERNAL_ERROR', err.message || 'Server error.', 500);
  }
};
