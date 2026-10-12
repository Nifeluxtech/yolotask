// /api/vqpay.js — gateway control + VQPay payout execution
const { getAuthenticatedUser, requireRole } = require('../lib/auth');
const { sendSuccess, sendError } = require('../lib/response');
const { supabaseAdmin } = require('../lib/supabase');
const vqpay = require('../lib/vqpay');

const GW_RULES = {
  deposit_gateway:    { allowed: ['paystack', 'vqpay'] },
  payout_gateway:     { allowed: ['manual', 'vqpay'] },
  vqpay_country:      { type: 'string', max: 4 },
  vqpay_deposit_method: { type: 'string', max: 60 },
  vqpay_deposit_flow: { allowed: ['REDIRECT', 'DIRECT'] }
};

async function readGatewaySettings() {
  const { data } = await supabaseAdmin.from('platform_settings').select('key, value')
    .in('key', Object.keys(GW_RULES));
  const map = {};
  (data || []).forEach(r => { map[r.key] = r.value; });
  return {
    deposit_gateway: map.deposit_gateway || 'paystack',
    payout_gateway: map.payout_gateway || 'manual',
    vqpay_country: map.vqpay_country || 'NG',
    vqpay_deposit_method: map.vqpay_deposit_method || '',
    vqpay_deposit_flow: map.vqpay_deposit_flow || 'REDIRECT'
  };
}

async function findVqpayBankCode(bankName) {
  const name = String(bankName || '').toLowerCase();
  const { data } = await supabaseAdmin.from('vqpay_bank_map').select('*');
  const matches = (data || []).filter(m => name.includes(m.match_name));
  if (!matches.length) return null;
  matches.sort((a, b) => b.match_name.length - a.match_name.length); // longest match wins
  return matches[0];
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return sendError(res, 'METHOD_NOT_ALLOWED', 'Only POST allowed.', 405);

  try {
    const { action } = req.body;
    if (!action) return sendError(res, 'VALIDATION_ERROR', 'Missing action.', 400);

    const { profile } = await getAuthenticatedUser(req);

    switch (action) {
      case 'get_gateway_settings': {
        const s = await readGatewaySettings();
        return sendSuccess(res, { settings: s });
      }

      case 'update_gateway_settings': {
        requireRole(profile, ['admin']);
        const updates = req.body.settings || {};
        const rows = [];
        for (const [key, raw] of Object.entries(updates)) {
          const rule = GW_RULES[key];
          if (!rule) return sendError(res, 'VALIDATION_ERROR', `Unknown setting: ${key}`, 400);
          const val = String(raw).trim();
          if (rule.allowed && !rule.allowed.includes(val)) {
            return sendError(res, 'VALIDATION_ERROR', `${key} must be one of: ${rule.allowed.join(', ')}`, 400);
          }
          if (rule.type === 'string' && val.length > rule.max) {
            return sendError(res, 'VALIDATION_ERROR', `${key} too long.`, 400);
          }
          rows.push({ key, value: val });
        }
        if (!rows.length) return sendError(res, 'VALIDATION_ERROR', 'Nothing to update.', 400);
        const { error } = await supabaseAdmin.from('platform_settings').upsert(rows, { onConflict: 'key' });
        if (error) throw error;
        return sendSuccess(res, {}, 'Gateway settings saved. Live immediately.');
      }

      case 'payout_balance': {
        requireRole(profile, ['admin']);
        const data = await vqpay.getBalance();
        return sendSuccess(res, {
          available: Number(data.available_balance || 0),
          frozen: Number(data.freeze_balance || 0),
          total: Number(data.total_balance || 0)
        });
      }

      case 'get_bank_map': {
        requireRole(profile, ['admin']);
        const { data } = await supabaseAdmin.from('vqpay_bank_map').select('*').order('vqpay_name');
        return sendSuccess(res, { banks: data || [] });
      }

      // ---------- EXECUTE A PAYOUT VIA VQPAY ----------
      case 'process_payout': {
        requireRole(profile, ['admin']);
        const s = await readGatewaySettings();
        if (s.payout_gateway !== 'vqpay') {
          return sendError(res, 'GATEWAY_MISMATCH', 'Payout gateway is set to manual. Switch it to vqpay first.', 400);
        }

        const { withdrawalId } = req.body;
        const { data: wd } = await supabaseAdmin.from('withdrawals').select('*').eq('id', withdrawalId).single();
        if (!wd) return sendError(res, 'NOT_FOUND', 'Withdrawal not found.', 404);
        if (wd.status !== 'PENDING') return sendError(res, 'VALIDATION_ERROR', `Withdrawal is ${wd.status}, not PENDING.`, 400);

        const bank = await findVqpayBankCode(wd.bank_name);
        if (!bank) {
          return sendError(res, 'BANK_NOT_MAPPED', `"${wd.bank_name}" has no VQPay bank code mapped. Use manual payout or add the mapping.`, 400);
        }

        const orderId = 'WD-' + wd.id;
        const notificationUrl = `${process.env.APP_URL || ''}/api/vqpay-callback.js`;

        const result = await vqpay.createSettlement({
          orderId,
          amount: Number(wd.amount),
          notificationUrl,
          country: s.vqpay_country,
          currency: 'NGN',
          payee: {
            name: wd.account_name,
            account: String(wd.account_number),
            account_type: 'BANK',
            bank_code: bank.vqpay_code,
            bank_name: bank.vqpay_name
          }
        });

        const respData = result.data || result;
        await supabaseAdmin.from('withdrawals')
          .update({
            status: 'PROCESSING',
            gateway: 'vqpay',
            vqpay_settlement_id: String(respData.settlement_id || ''),
            vqpay_status: 'APPLY',
            vqpay_status_code: 1
          })
          .eq('id', wd.id).eq('status', 'PENDING');

        return sendSuccess(res, { settlement_id: respData.settlement_id || null },
          'Payout sent to VQPay. Status updates arrive via callback (sandbox auto-succeeds in ~60s).');
      }

      case 'query_payout': {
        requireRole(profile, ['admin']);
        const { withdrawalId } = req.body;
        const { data: wd } = await supabaseAdmin.from('withdrawals').select('*').eq('id', withdrawalId).single();
        if (!wd) return sendError(res, 'NOT_FOUND', 'Withdrawal not found.', 404);

        const result = await vqpay.querySettlement('WD-' + wd.id);
        const d = result.data || result;
        const code = Number(d.status_code || 0);

        const patch = { vqpay_status: String(d.status || ''), vqpay_status_code: code };
        if (d.settlement_id) patch.vqpay_settlement_id = String(d.settlement_id);

        if (vqpay.isFinalSuccess(code) && wd.status !== 'COMPLETED') {
          patch.status = 'COMPLETED'; patch.processed_at = new Date().toISOString();
        } else if (vqpay.isFinalFail(code) && (wd.status === 'PENDING' || wd.status === 'PROCESSING')) {
          patch.status = 'FAILED';
          // refund
          const { data: wallet } = await supabaseAdmin.from('wallets').select('available_balance').eq('user_id', wd.user_id).single();
          if (wallet && wd.status !== 'FAILED') {
            await supabaseAdmin.from('wallets')
              .update({ available_balance: Number(wallet.available_balance) + Number(wd.amount), updated_at: new Date().toISOString() })
              .eq('user_id', wd.user_id);
            await supabaseAdmin.from('wallet_ledger').insert({
              user_id: wd.user_id, transaction_type: 'WITHDRAWAL_REFUND', amount: Number(wd.amount),
              direction: 'CREDIT', status: 'COMPLETED', reference: 'WDREF-' + wd.id
            });
          }
        }
        await supabaseAdmin.from('withdrawals').update(patch).eq('id', wd.id);

        return sendSuccess(res, { status: d.status, status_code: code, detail: d.status_detail || '' },
          `VQPay says: ${d.status} (${code})`);
      }

      default:
        return sendError(res, 'INVALID_ACTION', 'Unknown action.', 400);
    }
  } catch (err) {
    if (err.code) return sendError(res, err.code, err.message, err.statusCode || 400);
    console.error('VQPay API Error:', err);
    return sendError(res, 'INTERNAL_ERROR', err.message || 'Server error.', 500);
  }
};
