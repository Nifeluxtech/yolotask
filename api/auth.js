// /api/auth.js
const { supabaseAdmin } = require('../lib/supabase');
const { getAuthenticatedUser, requireRole } = require('../lib/auth');
const { sendSuccess, sendError } = require('../lib/response');

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return sendError(res, 'METHOD_NOT_ALLOWED', 'Only POST allowed.', 405);

  try {
    const { action } = req.body;
    if (!action) return sendError(res, 'VALIDATION_ERROR', 'Missing action.', 400);

    switch (action) {
      // ---------- PUBLIC ACTIONS ----------
      case 'register': {
        const { email, password, full_name, gender, role, interests, referral_code } = req.body;

        if (!email || !password || !full_name) {
          return sendError(res, 'VALIDATION_ERROR', 'Missing required fields.', 400);
        }
        if (password.length < 8) {
          return sendError(res, 'VALIDATION_ERROR', 'Password must be at least 8 characters.', 400);
        }

        const allowedRoles = ['earner', 'advertiser'];
        const finalRole = allowedRoles.includes(role) ? role : 'earner';

        if (finalRole === 'earner' && (!interests || interests.length < 3)) {
          return sendError(res, 'VALIDATION_ERROR', 'Select at least 3 interests.', 400);
        }

        let validReferralCode = null;
        if (referral_code) {
          const { data: referrer } = await supabaseAdmin
            .from('profiles')
            .select('id')
            .eq('referral_code', referral_code)
            .maybeSingle();
          if (referrer) validReferralCode = referral_code;
        }

        const { data, error } = await supabaseAdmin.auth.admin.createUser({
          email,
          password,
          email_confirm: true,
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

        await supabaseAdmin.auth.resetPasswordForEmail(email, {
          redirectTo: `${process.env.APP_URL || ''}/login.html`
        });

        return sendSuccess(res, {}, 'Reset link sent.');
      }

      // ---------- AUTHENTICATED ACTIONS ----------
      case 'get-session': {
        const { user, profile } = await getAuthenticatedUser(req);
        return sendSuccess(res, {
          profile: {
            ...profile,
            email: user.email,
            email_verified: !!user.email_confirmed_at
          }
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

        if (!full_name || full_name.trim().length < 2) {
          return sendError(res, 'VALIDATION_ERROR', 'Display name is too short.', 400);
        }

        // Light phone validation (digits only, 10-14 chars after cleaning)
        let cleanPhone = null;
        if (phone && phone.trim() !== '') {
          cleanPhone = phone.replace(/[\s\-()]/g, '');
          if (!/^\+?\d{10,14}$/.test(cleanPhone)) {
            return sendError(res, 'VALIDATION_ERROR', 'Invalid phone number format.', 400);
          }
        }

        const { data, error } = await supabaseAdmin
          .from('profiles')
          .update({ full_name: full_name.trim(), phone: cleanPhone, updated_at: new Date().toISOString() })
          .eq('id', profile.id)
          .select('id, full_name, role, is_suspended, created_at, referral_code, phone, avatar_url')
          .single();

        if (error) throw error;
        return sendSuccess(res, { profile: data }, 'Profile updated.');
      }

      case 'upload_avatar': {
        const { profile } = await getAuthenticatedUser(req);
        const { dataUrl } = req.body;

        if (!dataUrl || !dataUrl.startsWith('data:image/')) {
          return sendError(res, 'VALIDATION_ERROR', 'Invalid image data.', 400);
        }

        const base64 = dataUrl.split(',')[1];
        if (!base64) return sendError(res, 'VALIDATION_ERROR', 'Empty image.', 400);

        const buffer = Buffer.from(base64, 'base64');
        if (buffer.length > 500 * 1024) {
          return sendError(res, 'FILE_TOO_LARGE', 'Image must be under 500KB.', 400);
        }

        const path = `${profile.id}.jpg`;
        const { error: upErr } = await supabaseAdmin.storage
          .from('avatars')
          .upload(path, buffer, { contentType: 'image/jpeg', upsert: true });

        if (upErr) throw upErr;

        const { data: pub } = supabaseAdmin.storage.from('avatars').getPublicUrl(path);
        const publicUrl = `${pub.publicUrl}?t=${Date.now()}`;

        await supabaseAdmin.from('profiles').update({ avatar_url: publicUrl }).eq('id', profile.id);
        return sendSuccess(res, { avatar_url: publicUrl }, 'Avatar updated.');
      }

      case 'change_password': {
        const { user } = await getAuthenticatedUser(req);
        const { currentPassword, newPassword } = req.body;

        if (!currentPassword || !newPassword) {
          return sendError(res, 'VALIDATION_ERROR', 'Both passwords required.', 400);
        }
        if (newPassword.length < 8) {
          return sendError(res, 'VALIDATION_ERROR', 'New password must be at least 8 characters.', 400);
        }

        // Verify current password by attempting a sign-in
        const { error: verifyErr } = await supabaseAdmin.auth.signInWithPassword({
          email: user.email,
          password: currentPassword
        });
        if (verifyErr) {
          return sendError(res, 'INVALID_PASSWORD', 'Current password is incorrect.', 400);
        }

        const { error: updateErr } = await supabaseAdmin.auth.admin.updateUserById(user.id, {
          password: newPassword
        });
        if (updateErr) throw updateErr;

        // Force re-login everywhere for safety
        await supabaseAdmin.auth.admin.signOut(user.id, 'global');
        return sendSuccess(res, {}, 'Password changed. Please log in again.');
      }

      case 'sign_out_all': {
        const { user } = await getAuthenticatedUser(req);
        await supabaseAdmin.auth.admin.signOut(user.id, 'global');
        return sendSuccess(res, {}, 'All devices signed out.');
      }

      // ---------- NOTIFICATIONS ----------
      case 'get_notifications': {
        const { profile } = await getAuthenticatedUser(req);
        const { data, error } = await supabaseAdmin
          .from('notifications')
          .select('*')
          .eq('user_id', profile.id)
          .order('created_at', { ascending: false })
          .limit(50);

        if (error) throw error;
        return sendSuccess(res, { notifications: data || [] });
      }

      case 'mark_notifications_read': {
        const { profile } = await getAuthenticatedUser(req);
        await supabaseAdmin
          .from('notifications')
          .update({ is_read: true })
          .eq('user_id', profile.id)
          .eq('is_read', false);

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
