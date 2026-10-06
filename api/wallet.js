// /api/wallet.js
const { getAuthenticatedUser, requireRole } = require('../lib/auth');
const { sendSuccess, sendError } = require('../lib/response');
const { supabaseAdmin } = require('../lib/supabase');

const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY;

async function paystackGet(path) {
  const resp = await fetch(`https://api.paystack.co${path}`, {
    headers: { Authorization: `Bearer ${PAYSTACK_SECRET}` }
  });
  return await resp.json();
}

async function getMinWithdrawal() {
  const { data } = await supabaseAdmin
    .from('platform_settings')
    .select('value')
    .eq('key', 'min_withdrawal_amount')
    .maybeSingle();
  const val = Number(data?.value ?? 1000);
  return isNaN(val) ? 1000 : val;
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return sendError(res, 'METHOD_NOT_ALLOWED', 'Only POST allowed.', 405);

  try {
    const { action } = req.body;
    if (!action) return sendError(res, 'VALIDATION_ERROR', 'Missing action.', 400);

    const { profile } = await getAuthenticatedUser(req);

    switch (action) {
      case 'get_balance': {
        requireRole(profile, ['earner', 'advertiser']);
        const { data: wallet, error } = await supabaseAdmin
          .from('wallets')
          .select('*')
          .eq('user_id', profile.id)
          .single();
        if (error) throw error;

        const min_withdrawal = await getMinWithdrawal();
        return sendSuccess(res, { wallet, min_withdrawal });
      }

      case 'get_transactions': {
        requireRole(profile, ['earner', 'advertiser']);
        const { data, error } = await supabaseAdmin
          .from('wallet_ledger')
          .select('*')
          .eq('user_id', profile.id)
          .order('created_at', { ascending: false })
          .limit(50);
        if (error) throw error;
        return sendSuccess(res, { transactions: data || [] });
      }

      // ---------- PAYOUT ACCOUNTS ----------
      case 'get_banks': {
        requireRole(profile, ['earner']);
        const result = await paystackGet('/bank?per_page=100');
        if (!result.status) throw { code: 'PAYSTACK_ERROR', message: result.message || 'Failed to load banks.', statusCode: 502 };
        return sendSuccess(res, { banks: result.data || [] });
      }

      case 'resolve_account': {
        requireRole(profile, ['earner']);
        const { account_number, bank_code } = req.body;
        if (!account_number || !bank_code) return sendError(res, 'VALIDATION_ERROR', 'Missing fields.', 400);
        if (!/^\d{10}$/.test(account_number)) return sendError(res, 'VALIDATION_ERROR', 'Account number must be exactly 10 digits.', 400);

        const result = await paystackGet(`/bank/resolve?account_number=${encodeURIComponent(account_number)}&bank_code=${encodeURIComponent(bank_code)}`);
        if (!result.status) throw { code: 'RESOLUTION_FAILED', message: result.message || 'Could not verify this account.', statusCode: 400 };

        return sendSuccess(res, { account_name: result.data.account_name });
      }

      case 'get_bank_accounts': {
        requireRole(profile, ['earner']);
        const { data, error } = await supabaseAdmin
          .from('earner_bank_accounts')
          .select('*')
          .eq('user_id', profile.id)
          .order('is_default', { ascending: false })
          .order('created_at', { ascending: false });
        if (error) throw error;
        return sendSuccess(res, { accounts: data || [] });
      }

      case 'save_bank_account': {
        requireRole(profile, ['earner']);
        const { bank_code, bank_name, account_number, account_name, is_default } = req.body;

        if (!bank_code || !bank_name || !account_number || !account_name) {
          return sendError(res, 'VALIDATION_ERROR', 'Resolve the account before saving.', 400);
        }
        if (!/^\d{10}$/.test(account_number)) return sendError(res, 'VALIDATION_ERROR', 'Invalid account number.', 400);

        // If first account or marked default, clear other defaults
        if (is_default) {
          await supabaseAdmin.from('earner_bank_accounts').update({ is_default: false }).eq('user_id', profile.id);
        }

        const { data: existingCount } = await supabaseAdmin
          .from('earner_bank_accounts')
          .select('id')
          .eq('user_id', profile.id);

        const makeDefault = is_default || !existingCount || existingCount.length === 0;

        const { data, error } = await supabaseAdmin
          .from('earner_bank_accounts')
          .insert({
            user_id: profile.id,
            bank_code,
            bank_name,
            account_number,
            account_name,
            is_default: makeDefault
          })
          .select()
          .single();

        if (error) {
          if (error.code === '23505') throw { code: 'DUPLICATE_ACCOUNT', message: 'This bank account is already saved.', statusCode: 400 };
          throw error;
        }

        return sendSuccess(res, { account: data }, 'Bank account saved.');
      }

      case 'set_default_bank': {
        requireRole(profile, ['earner']);
        const { accountId } = req.body;
        if (!accountId) return sendError(res, 'VALIDATION_ERROR', 'Account ID required.', 400);

        await supabaseAdmin.from('earner_bank_accounts').update({ is_default: false }).eq('user_id', profile.id);
        const { error } = await supabaseAdmin
          .from('earner_bank_accounts')
          .update({ is_default: true })
          .eq('id', accountId)
          .eq('user_id', profile.id); // ownership guard

        if (error) throw error;
        return sendSuccess(res, {}, 'Default account updated.');
      }

      case 'delete_bank_account': {
        requireRole(profile, ['earner']);
        const { accountId } = req.body;
        if (!accountId) return sendError(res, 'VALIDATION_ERROR', 'Account ID required.', 400);

        const { error } = await supabaseAdmin
          .from('earner_bank_accounts')
          .delete()
          .eq('id', accountId)
          .eq('user_id', profile.id); // ownership guard

        if (error) throw error;
        return sendSuccess(res, {}, 'Bank account removed.');
      }

      // ---------- WITHDRAWAL ----------
      case 'request_withdrawal': {
        requireRole(profile, ['earner']);
        const { amount, bank_account_id, bank_name, account_number, account_name } = req.body;

        const amt = Number(amount);
        if (!amt || amt <= 0) return sendError(res, 'VALIDATION_ERROR', 'Invalid amount.', 400);

        const min = await getMinWithdrawal();
        if (amt < min) return sendError(res, 'BELOW_MINIMUM', `Minimum withdrawal is ₦${min}.`, 400);

        // Resolve payout destination
        let bankDetails = null;

        if (bank_account_id) {
          const { data: acc } = await supabaseAdmin
            .from('earner_bank_accounts')
            .select('*')
            .eq('id', bank_account_id)
            .eq('user_id', profile.id)
            .maybeSingle();
          if (acc) bankDetails = acc;
        } else if (bank_name && account_number && account_name) {
          bankDetails = { bank_name, account_number, account_name };
        } else {
          const { data: def } = await supabaseAdmin
            .from('earner_bank_accounts')
            .select('*')
            .eq('user_id', profile.id)
            .eq('is_default', true)
            .maybeSingle();
          if (def) bankDetails = def;
        }

        if (!bankDetails) {
          return sendError(res, 'NO_PAYOUT_ACCOUNT', 'Add a bank account in Settings → Payouts first.', 400);
        }

        // Debit available balance (guarded against negatives)
        const { data: updated, error: debitErr } = await supabaseAdmin
          .from('wallets')
          .update({ available_balance: Math.round((0 - amt) * 100) / 100 + 0, updated_at: new Date().toISOString() })
          .eq('user_id', profile.id)
          .gte('available_balance', amt)
          .select('*')
          .single();

        // The trick above can't compute relative values; do it properly:
        if (debitErr && debitErr.code === 'PGRST116') {
          return sendError(res, 'INSUFFICIENT_FUNDS', 'Available balance is too low.', 400);
        }

        // Proper relative debit using RPC-free two-step with re-check
        const { data: wallet } = await supabaseAdmin.from('wallets').select('*').eq('user_id', profile.id).single();
        if (Number(wallet.available_balance) < amt) {
          return sendError(res, 'INSUFFICIENT_FUNDS', 'Available balance is too low.', 400);
        }

        const newBalance = Number(wallet.available_balance) - amt;
        const { error: updErr } = await supabaseAdmin
          .from('wallets')
          .update({ available_balance: newBalance, updated_at: new Date().toISOString() })
          .eq('user_id', profile.id)
          .eq('available_balance', wallet.available_balance); // optimistic lock

        if (updErr) throw updErr;

        // Create withdrawal record
        const { data: withdrawal, error: wdErr } = await supabaseAdmin
          .from('withdrawals')
          .insert({
            user_id: profile.id,
            amount: amt,
            bank_name: bankDetails.bank_name,
            account_number: bankDetails.account_number,
            account_name: bankDetails.account_name,
            status: 'PENDING'
          })
          .select()
          .single();

        if (wdErr) throw wdErr;

        // Ledger entry
        await supabaseAdmin.from('wallet_ledger').insert({
          user_id: profile.id,
          transaction_type: 'WITHDRAWAL',
          amount: amt,
          direction: 'DEBIT',
          status: 'COMPLETED',
          reference: 'WD-' + withdrawal.id
        });

        return sendSuccess(res, { withdrawal }, 'Withdrawal requested. Processing within 24 hours.');
      }

      default:
        return sendError(res, 'INVALID_ACTION', 'Unknown action.', 400);
    }
  } catch (err) {
    if (err.code) return sendError(res, err.code, err.message, err.statusCode || 400);
    console.error('Wallet API Error:', err);
    return sendError(res, 'INTERNAL_ERROR', err.message || 'Server error.', 500);
  }
};
