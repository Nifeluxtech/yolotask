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
        const { data: wallet, error } = await supabaseAdmin.from('wallets').select('*').eq('user_id', profile.id).single();
        if (error) throw error;
        const min_withdrawal = await getMinWithdrawal();
        return sendSuccess(res, { wallet, min_withdrawal });
      }

      case 'get_transactions': {
        requireRole(profile, ['earner', 'advertiser']);
        const { data, error } = await supabaseAdmin.from('wallet_ledger').select('*')
          .eq('user_id', profile.id).order('created_at', { ascending: false }).limit(50);
        if (error) throw error;
        return sendSuccess(res, { transactions: data || [] });
      }

      case 'get_my_withdrawals': {
        requireRole(profile, ['earner']);
        const { data, error } = await supabaseAdmin.from('withdrawals').select('*')
          .eq('user_id', profile.id).order('created_at', { ascending: false }).limit(30);
        if (error) throw error;
        return sendSuccess(res, { withdrawals: data || [] });
      }

      // ---------- RECEIPTS ----------
      case 'get_receipt': {
        requireRole(profile, ['earner', 'advertiser', 'admin']);
        const { receiptType, receiptId } = req.body;
        if (!receiptType || !receiptId) return sendError(res, 'VALIDATION_ERROR', 'Missing receipt info.', 400);

        let row = null;
        let receipt = null;

        if (receiptType === 'withdrawal') {
          const { data } = await supabaseAdmin.from('withdrawals').select('*').eq('id', receiptId).maybeSingle();
          row = data;
          if (row && (row.user_id === profile.id || profile.role === 'admin')) {
            receipt = {
              type: 'Withdrawal Payout',
              reference: 'WD-' + row.id,
              amount: Number(row.amount),
              status: row.status,
              created_at: row.created_at,
              processed_at: row.processed_at,
              detail: `${row.bank_name} • ****${String(row.account_number).slice(-4)} • ${row.account_name}`
            };
          }
        } else if (receiptType === 'topup') {
          const { data } = await supabaseAdmin.from('payment_transactions').select('*').eq('id', receiptId).maybeSingle();
          row = data;
          if (row && (row.user_id === profile.id || profile.role === 'admin')) {
            receipt = {
              type: 'Wallet Top-up',
              reference: row.paystack_reference,
              amount: Number(row.amount),
              status: row.status,
              created_at: row.created_at,
              processed_at: row.status === 'SUCCESS' ? row.created_at : null,
              detail: 'Paid via Paystack'
            };
          }
        } else {
          return sendError(res, 'VALIDATION_ERROR', 'Unknown receipt type.', 400);
        }

        if (!receipt) return sendError(res, 'NOT_FOUND', 'Receipt not found or not yours.', 404);

        const { data: owner } = await supabaseAdmin.from('profiles')
          .select('full_name, email, business_name, phone')
          .eq('id', row.user_id).single();

        receipt.customer = {
          name: owner?.business_name || owner?.full_name || 'Customer',
          personal_name: owner?.full_name || '',
          email: owner?.email || '',
          phone: owner?.phone || ''
        };
        receipt.platform = { name: 'YOLOTASK', issuer: 'Nifelux Media', support: 'support@yolotask.com' };

        return sendSuccess(res, { receipt });
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
        const { data, error } = await supabaseAdmin.from('earner_bank_accounts').select('*')
          .eq('user_id', profile.id).order('is_default', { ascending: false }).order('created_at', { ascending: false });
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

        if (is_default) {
          await supabaseAdmin.from('earner_bank_accounts').update({ is_default: false }).eq('user_id', profile.id);
        }

        const { data: existingCount } = await supabaseAdmin.from('earner_bank_accounts').select('id').eq('user_id', profile.id);
        const makeDefault = is_default || !existingCount || existingCount.length === 0;

        const { data, error } = await supabaseAdmin.from('earner_bank_accounts')
          .insert({ user_id: profile.id, bank_code, bank_name, account_number, account_name, is_default: makeDefault })
          .select().single();

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
        const { error } = await supabaseAdmin.from('earner_bank_accounts')
          .update({ is_default: true }).eq('id', accountId).eq('user_id', profile.id);
        if (error) throw error;
        return sendSuccess(res, {}, 'Default account updated.');
      }

      case 'delete_bank_account': {
        requireRole(profile, ['earner']);
        const { accountId } = req.body;
        if (!accountId) return sendError(res, 'VALIDATION_ERROR', 'Account ID required.', 400);

        const { error } = await supabaseAdmin.from('earner_bank_accounts')
          .delete().eq('id', accountId).eq('user_id', profile.id);
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

        let bankDetails = null;
        if (bank_account_id) {
          const { data: acc } = await supabaseAdmin.from('earner_bank_accounts').select('*')
            .eq('id', bank_account_id).eq('user_id', profile.id).maybeSingle();
          if (acc) bankDetails = acc;
        } else if (bank_name && account_number && account_name) {
          bankDetails = { bank_name, account_number, account_name };
        } else {
          const { data: def } = await supabaseAdmin.from('earner_bank_accounts').select('*')
            .eq('user_id', profile.id).eq('is_default', true).maybeSingle();
          if (def) bankDetails = def;
        }

        if (!bankDetails) return sendError(res, 'NO_PAYOUT_ACCOUNT', 'Add a bank account in Settings → Payouts first.', 400);

        const { data: wallet } = await supabaseAdmin.from('wallets').select('*').eq('user_id', profile.id).single();
        if (!wallet || Number(wallet.available_balance) < amt) {
          return sendError(res, 'INSUFFICIENT_FUNDS', 'Available balance is too low.', 400);
        }

        const newBalance = Number(wallet.available_balance) - amt;
        const { error: updErr } = await supabaseAdmin.from('wallets')
          .update({ available_balance: newBalance, updated_at: new Date().toISOString() })
          .eq('user_id', profile.id)
          .eq('available_balance', wallet.available_balance);
        if (updErr) throw updErr;

        const { data: withdrawal, error: wdErr } = await supabaseAdmin.from('withdrawals')
          .insert({
            user_id: profile.id,
            amount: amt,
            bank_name: bankDetails.bank_name,
            account_number: bankDetails.account_number,
            account_name: bankDetails.account_name,
            status: 'PENDING'
          })
          .select().single();
        if (wdErr) throw wdErr;

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
