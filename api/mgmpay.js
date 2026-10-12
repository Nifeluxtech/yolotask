// /api/mgmpay.js — MGM Pay gateway control + payout execution + diagnostics
const { getAuthenticatedUser, requireRole } = require('../lib/auth');
const { sendSuccess, sendError } = require('../lib/response');
const { supabaseAdmin } = require('../lib/supabase');
const mgmpay = require('../lib/mgmpay');

const GW_RULES = {
  deposit_gateway:    { allowed: ['paystack', 'mgmpay'] },
  payout_gateway:     { allowed: ['manual', 'mgmpay'] },
  mgmpay_country:     { type: 'string', max: 4 },
  mgmpay_deposit_method: { type: 'string', max: 60 },
  mgmpay_deposit_flow: { allowed: ['REDIRECT', 'DIRECT'] }
};

async function readGatewaySettings() {
  const { data } = await supabaseAdmin.from('platform_settings').select('key, value')
    .in('key', Object.keys(GW_RULES));
  const map = {};
  (data || []).forEach(r => { map[r.key] = r.value; });
  return {
    deposit_gateway: map.deposit_gateway || 'paystack',
    payout_gateway: map.payout_gateway || 'manual',
    mgmpay_country: map.mgmpay_country || 'NG',
    mgmpay_deposit_method: map.mgmpay_deposit_method || 'BANK_CARD',
    mgmpay_deposit_flow: map.mgmpay_deposit_flow || 'REDIRECT'
  };
}

async function findMgmBankCode(bankName) {
  const name = String(bankName || '').toLowerCase();
  const { data } = await supabaseAdmin.from('mgmpay_bank_map').select('*');
  const matches = (data || []).filter(m => name.includes(m.match_name));
  if (!matches.length) return null;
  matches.sort((a, b) => b.match_name.length - a.match_name.length); // Longest match wins
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
      
      // ---------- CONNECTION PROBE ----------
      case 'ping': {
        requireRole(profile, ['admin']);
        const candidates = [
          process.env.MGMPAY_BASE_URL,
          'https://api.mgm-paysandbox.com',
          'https://api.mgm-pay.com'
        ];
        const unique = [...new Set(candidates.filter(Boolean))];
        const report = [];
        
        for (const base of unique) {
          try {
            const c = mgmpay.cfg();
            const merchant_no = c.merchantNo;
            const signature = mgmpay.sign({ merchant_no }, c.payoutKey, { excludeNested: [] });
            
            const resp = await fetch(base.replace(/\/+$/, '') + '/api/merchant/balance', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'ApiVersion': '1.0',
                'AppId': c.appId,
                'Noncestr': String(Math.floor(10000000 + Math.random() * 90000000)),
                'Timestamp': String(Date.now()),
                'User-Agent': 'YOLOTASK-Probe/1.0'
              },
              body: JSON.stringify({ merchant_no, signature })
            });
            
            const text = await resp.text();
            let verdict = 'BLOCKED';
            if (resp.ok && text.includes('"state"')) verdict = 'REACHABLE';
            else if (resp.status === 403 && text.includes('<html')) verdict = 'WAF/IP-BLOCK';
            
            report.push({ base, http: resp.status, verdict, snippet: text.slice(0, 160) });
            
          } catch (e) {
            report.push({ base, http: 'EXC', verdict: 'NETWORK ERROR', snippet: e.message });
          }
        }
        
        return sendSuccess(res, { report });
      }
      
      case 'payout_balance': {
        requireRole(profile, ['admin']);
        const data = await mgmpay.getBalance();
        return sendSuccess(res, {
          available: Number(data.available_balance || 0),
          frozen: Number(data.freeze_balance || 0),
          total: Number(data.total_balance || 0)
        });
      }
      
      case 'get_bank_map': {
        requireRole(profile, ['admin']);
        const { data } = await supabaseAdmin.from('mgmpay_bank_map').select('*').order('mgmpay_name');
        return sendSuccess(res, { banks: data || [] });
      }
      
      // ---------- EXECUTE A PAYOUT VIA MGM PAY ----------
      case 'process_payout': {
        requireRole(profile, ['admin']);
        const s = await readGatewaySettings();
        if (s.payout_gateway !== 'mgmpay') {
          return sendError(res, 'GATEWAY_MISMATCH', 'Payout gateway is set to manual. Switch it to mgmpay first.', 400);
        }
        
        const { withdrawalId } = req.body;
        const { data: wd } = await supabaseAdmin.from('withdrawals').select('*').eq('id', withdrawalId).single();
        if (!wd) return sendError(res, 'NOT_FOUND', 'Withdrawal not found.', 404);
        if (wd.status !== 'PENDING') return sendError(res, 'VALIDATION_ERROR', `Withdrawal is ${wd.status}, not PENDING.`, 400);
        
        const bank = await findMgmBankCode(wd.bank_name);
        if (!bank) {
          return sendError(res, 'BANK_NOT_MAPPED', `"${wd.bank_name}" has no MGM Pay bank code mapped. Use manual payout or add the mapping.`, 400);
        }
        
        const orderId = 'WD-' + wd.id;
        const notificationUrl = `${process.env.APP_URL || ''}/api/mgmpay-callback.js`;
        
        const result = await mgmpay.createSettlement({
          orderId,
          amount: Number(wd.amount),
          notificationUrl,
          country: s.mgmpay_country,
          currency: 'NGN',
          payee: {
            name: wd.account_name,
            account: String(wd.account_number),
            account_type: 'BANK',
            bank_code: bank.mgmpay_code,
            bank_name: bank.mgmpay_name
          }
        });
        
        const respData = result.data || result;
        await supabaseAdmin.from('withdrawals')
          .update({
            status: 'PROCESSING',
            gateway: 'mgmpay',
            vqpay_settlement_id: String(respData.settlement_id || ''),
            vqpay_status: 'APPLY',
            vqpay_status_code: 1
          })
          .eq('id', wd.id).eq('status', 'PENDING');
        
        return sendSuccess(res, { settlement_id: respData.settlement_id || null },
          'Payout sent to MGM Pay. Status updates arrive via callback (sandbox auto-succeeds in ~60s).');
      }
      
      case 'query_payout': {
        requireRole(profile, ['admin']);
        const { withdrawalId } = req.body;
        const { data: wd } = await supabaseAdmin.from('withdrawals').select('*').eq('id', withdrawalId).single();
        if (!wd) return sendError(res, 'NOT_FOUND', 'Withdrawal not found.', 404);
        
        const result = await mgmpay.querySettlement('WD-' + wd.id);
        const d = result.data || result;
        const code = Number(d.status_code || 0);
        
        const patch = { vqpay_status: String(d.status || ''), vqpay_status_code: code };
        if (d.settlement_id) patch.vqpay_settlement_id = String(d.settlement_id);
        
        if (mgmpay.isFinalSuccess(code) && wd.status !== 'COMPLETED') {
          patch.status = 'COMPLETED'; patch.processed_at = new Date().toISOString();
        } else if (mgmpay.isTerminalFail(code) && (wd.status === 'PENDING' || wd.status === 'PROCESSING')) {
          patch.status = 'FAILED';
          
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
          `MGM Pay says: ${d.status} (${code})`);
      }
      
      default:
        return sendError(res, 'INVALID_ACTION', 'Unknown action.', 400);
    }
    
  } catch (err) {
    if (err.code) return sendError(res, err.code, err.message, err.statusCode || 400);
    console.error('MGM Pay API Error:', err);
    return sendError(res, 'INTERNAL_ERROR', err.message || 'Server error.', 500);
  }
};
