const { supabaseAdmin } = require('../lib/supabase');
const { getAuthenticatedUser } = require('../lib/auth');
const { sendSuccess, sendError } = require('../lib/response');

module.exports = async (req, res) => {
  // CORS & Preflight
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return sendError(res, 'METHOD_NOT_ALLOWED', 'Only POST allowed.', 405);

  const { action } = req.body;

  try {
    switch (action) {
      
      case 'register': {
        const { email, password, full_name, gender, role, interests, referral_code } = req.body;
        
        // Basic validation
        if (!email || !password || !full_name || !role) {
          return sendError(res, 'VALIDATION_ERROR', 'Missing required fields.', 400);
        }
        if (role === 'earner' && (!interests || interests.length < 3)) {
          return sendError(res, 'VALIDATION_ERROR', 'Earners must select at least 3 interests.', 400);
        }

        // Check if referral code exists (if provided)
        let validReferralCode = null;
        if (referral_code) {
          const { data: referrer } = await supabaseAdmin.from('profiles').select('id').eq('referral_code', referral_code).single();
          if (referrer) validReferralCode = referral_code;
        }

        // Create user in Supabase Auth
        const { data, error } = await supabaseAdmin.auth.admin.createUser({
          email,
          password,
          email_confirm: true, // Auto-confirm for MVP (enable email confirmation in prod later)
          user_metadata: {
            full_name,
            gender,
            role,
            interests: role === 'earner' ? interests.join(',') : null,
            referral_code: validReferralCode
          }
        });

        if (error) {
          return sendError(res, 'REGISTRATION_FAILED', error.message, 400);
        }

        // The DB trigger (handle_new_user) automatically creates profile, wallet, etc.
        return sendSuccess(res, { userId: data.user.id }, 'Registration successful.');
      }

      case 'login': {
        const { email, password } = req.body;
        if (!email || !password) return sendError(res, 'VALIDATION_ERROR', 'Email and password required.', 400);

        const { data, error } = await supabaseAdmin.auth.signInWithPassword({ email, password });
        if (error) return sendError(res, 'LOGIN_FAILED', 'Invalid email or password.', 401);

        return sendSuccess(res, { session: data.session }, 'Login successful.');
      }

      case 'get-session': {
        const { profile } = await getAuthenticatedUser(req);
        return sendSuccess(res, { profile });
      }

      case 'logout': {
        const { profile } = await getAuthenticatedUser(req);
        await supabaseAdmin.auth.admin.signOut(profile.id);
        return sendSuccess(res, {}, 'Logged out successfully.');
      }

      case 'forgot-password': {
        const { email } = req.body;
        if (!email) return sendError(res, 'VALIDATION_ERROR', 'Email required.', 400);
        
        const { error } = await supabaseAdmin.auth.resetPasswordForEmail(email, {
          redirectTo: `${process.env.APP_URL}/reset-password.html`
        });
        if (error) return sendError(res, 'EMAIL_FAILED', error.message, 400);

        return sendSuccess(res, {}, 'Password reset link sent to your email.');
      }

      default:
        return sendError(res, 'INVALID_ACTION', 'Unknown auth action.', 400);
    }
  } catch (err) {
    if (err.code) return sendError(res, err.code, err.message, err.statusCode || 400);
    console.error('Auth API Error:', err);
    return sendError(res, 'INTERNAL_ERROR', 'Server error.');
  }
  // Add to the switch statement in /api/auth.js
case 'get_notifications': {
  const { data, error } = await supabaseAdmin
    .from('notifications')
    .select('*')
    .eq('user_id', profile.id)
    .order('created_at', { ascending: false })
    .limit(50);
  
  if (error) throw error;
  return sendSuccess(res, { notifications: data });
}

case 'mark_notifications_read': {
  await supabaseAdmin
    .from('notifications')
    .update({ is_read: true })
    .eq('user_id', profile.id)
    .eq('is_read', false);
  return sendSuccess(res, {}, 'Notifications marked as read.');
}
};
