const { supabaseAdmin } = require('../lib/supabase');
const { getAuthenticatedUser } = require('../lib/auth');
const { sendSuccess, sendError } = require('../lib/response');

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return sendError(res, 'METHOD_NOT_ALLOWED', 'Only POST allowed.', 405);
  const { action } = req.body;

  try {
    switch (action) {
      case 'register': {
        const { email, password, full_name, gender, role, interests, referral_code } = req.body;
        if (!email || !password || !full_name) return sendError(res, 'VALIDATION_ERROR', 'Missing required fields.', 400);
        
        // SECURITY PATCH: Strict Role Validation
        const allowedRoles = ['earner', 'advertiser'];
        const finalRole = allowedRoles.includes(role) ? role : 'earner';
        
        if (finalRole === 'earner' && (!interests || interests.length < 3)) return sendError(res, 'VALIDATION_ERROR', 'Select at least 3 interests.', 400);

        let validReferralCode = null;
        if (referral_code) {
          const { data: referrer } = await supabaseAdmin.from('profiles').select('id').eq('referral_code', referral_code).single();
          if (referrer) validReferralCode = referral_code;
        }

        const { data, error } = await supabaseAdmin.auth.admin.createUser({
          email, password, email_confirm: true,
          user_metadata: { full_name, gender, role: finalRole, interests: finalRole === 'earner' ? interests.join(',') : null, referral_code: validReferralCode }
        });
        if (error) return sendError(res, 'REGISTRATION_FAILED', error.message, 400);
        return sendSuccess(res, { userId: data.user.id }, 'Registration successful.');
      }
      case 'login': {
        const { email, password } = req.body;
        if (!email || !password) return sendError(res, 'VALIDATION_ERROR', 'Credentials required.', 400);
        const { data, error } = await supabaseAdmin.auth.signInWithPassword({ email, password });
        if (error) return sendError(res, 'LOGIN_FAILED', 'Invalid credentials.', 401);
        return sendSuccess(res, { session: data.session }, 'Login successful.');
      }
      case 'get-session': {
        const { profile } = await getAuthenticatedUser(req);
        return sendSuccess(res, { profile });
      }
      case 'logout': {
        const { profile } = await getAuthenticatedUser(req);
        await supabaseAdmin.auth.admin.signOut(profile.id);
        return sendSuccess(res, {}, 'Logged out.');
      }
      case 'forgot-password': {
        const { email } = req.body;
        if (!email) return sendError(res, 'VALIDATION_ERROR', 'Email required.', 400);
        await supabaseAdmin.auth.resetPasswordForEmail(email, { redirectTo: `${process.env.APP_URL}/reset-password.html` });
        return sendSuccess(res, {}, 'Reset link sent.');
      }
      case 'get_notifications': {
        const { profile } = await getAuthenticatedUser(req);
        const { data } = await supabaseAdmin.from('notifications').select('*').eq('user_id', profile.id).order('created_at', { ascending: false }).limit(50);
        return sendSuccess(res, { notifications: data });
      }
      case 'mark_notifications_read': {
        const { profile } = await getAuthenticatedUser(req);
        await supabaseAdmin.from('notifications').update({ is_read: true }).eq('user_id', profile.id).eq('is_read', false);
        return sendSuccess(res, {}, 'Marked as read.');
      }
      default: return sendError(res, 'INVALID_ACTION', 'Unknown action.', 400);
    }
  } catch (err) {
    if (err.code) return sendError(res, err.code, err.message, err.statusCode || 400);
    return sendError(res, 'INTERNAL_ERROR', 'Server error.');
  }
};
