const { getAuthenticatedUser, requireRole } = require('../lib/auth');
const { sendSuccess, sendError } = require('../lib/response');
const { supabaseAdmin } = require('../lib/supabase');

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return sendError(res, 'METHOD_NOT_ALLOWED', 'Only POST allowed.', 405);

  const { action } = req.body;

  try {
    const { profile } = await getAuthenticatedUser(req);

    switch (action) {
      
      case 'get_balance': {
        const { data: wallet, error } = await supabaseAdmin
          .from('wallets')
          .select('available_balance, pending_balance, locked_balance')
          .eq('user_id', profile.id)
          .single();

        if (error) throw error;
        return sendSuccess(res, { wallet });
      }

      case 'get_ledger': {
        const { data: transactions, error } = await supabaseAdmin
          .from('wallet_ledger')
          .select('*')
          .eq('user_id', profile.id)
          .order('created_at', { ascending: false })
          .limit(50);

        if (error) throw error;
        return sendSuccess(res, { transactions });
      }

      case 'request_withdrawal': {
        requireRole(profile, ['earner']); // Only earners can withdraw in this MVP
        const { amount, bank_name, account_number, account_name } = req.body;

        if (!amount || !bank_name || !account_number || !account_name) {
          return sendError(res, 'VALIDATION_ERROR', 'All withdrawal fields are required.', 400);
        }
        if (amount <= 0) {
          return sendError(res, 'VALIDATION_ERROR', 'Invalid amount.', 400);
        }

        const { data, error } = await supabaseAdmin.rpc('request_earner_withdrawal', {
          p_user_id: profile.id,
          p_amount: amount,
          p_bank_name: bank_name,
          p_account_number: account_number,
          p_account_name: account_name
        });

        if (error) {
          // Postgres exceptions are caught here
          return sendError(res, 'WITHDRAWAL_FAILED', error.message, 400);
        }

        return sendSuccess(res, {}, data.message);
      }

      default:
        return sendError(res, 'INVALID_ACTION', 'Unknown wallet action.', 400);
    }
  } catch (err) {
    if (err.code) return sendError(res, err.code, err.message, err.statusCode || 400);
    console.error('Wallet API Error:', err);
    return sendError(res, 'INTERNAL_ERROR', 'Server error.');
  }
};
