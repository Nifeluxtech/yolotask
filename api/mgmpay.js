// /api/mgmpay.js — Legacy route name; AfrStar gateway control + payout execution.
const { getAuthenticatedUser, requireRole } = require('../lib/auth');
const { sendSuccess, sendError } = require('../lib/response');
const { supabaseAdmin } = require('../lib/supabase');
const mgmpay = require('../lib/mgmpay');

const GW_RULES = {
  deposit_gateway:    { allowed: ['paystack', 'afrstar'] },
  payout_gateway:     { allowed: ['manual', 'afrstar'] }
};

// AfrStar has its own bank-code directory. Do not send the bank_code saved by
// Paystack account resolution directly to AfrStar: those codes are different.
const AFRSTAR_BANK_CODES = [
  ['access bank', '80000001'], ['citibank', '80000002'], ['ecobank', '80000004'],
  ['fidelity bank', '80000006'], ['first bank', '80000007'], ['fcmb', '80000008'],
  ['first city monument', '80000008'], ['gtbank', '80000009'], ['guaranty trust', '80000009'],
  ['heritage bank', '80000010'], ['jaiz bank', '80000011'], ['keystone bank', '80000012'],
  ['parallex bank', '80000014'], ['providus bank', '80000015'], ['polaris bank', '80000016'],
  ['stanbic ibtc', '80000017'], ['standard chartered', '80000018'], ['sterling bank', '80000019'],
  ['union bank', '80000021'], ['uba', '80000022'], ['united bank for africa', '80000022'],
  ['unity bank', '80000023'], ['wema bank', '80000024'], ['zenith bank', '80000025'],
  ['kuda', '80000028'], ['moniepoint', '80000029'], ['opay', '80000030'],
  ['finca', '80000032'], ['palmpay', '80000033'], ['rubies', '80000034'],
  ['titan trust', '80000035'], ['globus', '80000040'], ['vfd', '80000044'],
  ['carbon', '80000077'], ['nomba', '80000099'], ['gomoney', '80000101'],
  ['now now', '80000106'], ['safe haven', '80000115'], ['paystack', '80000141']
];

async function readGatewaySettings() {
  const { data } = await supabaseAdmin.from('platform_settings').select('key, value')
    .in('key', Object.keys(GW_RULES));
  const map = {};
  (data || []).forEach(r => { map[r.key] = r.value; });
  const normalize = value => ['mgmpay', 'vqpay', 'afrstar'].includes(String(value || '').toLowerCase()) ? 'afrstar' : value;
  return {
    deposit_gateway: normalize(map.deposit_gateway) || 'paystack',
    payout_gateway: normalize(map.payout_gateway) || 'manual',
    afrstar_base_url: process.env.AFRSTAR_BASE_URL || 'https://ngn.afrstar.com'
  };
}

async function findMgmBankCode(bankName) {
  const name = String(bankName || '').toLowerCase();
  const direct = AFRSTAR_BANK_CODES.find(([label]) => name.includes(label));
  if (direct) return { match_name: direct[0], mgmpay_code: direct[1], mgmpay_name: bankName };

  // Keep support for an administrator-maintained map, but only accept values
  // shaped like AfrStar's documented 8000xxxx codes. This prevents a legacy
  // Paystack code such as 999992 from reaching AfrStar.
  const { data } = await supabaseAdmin.from('mgmpay_bank_map').select('*');
  const matches = (data || []).filter(m => name.includes(String(m.match_name || '').toLowerCase()) && /^8000\d{4}$/.test(String(m.mgmpay_code || '')));
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
        const candidates = [process.env.AFRSTAR_BASE_URL || 'https://ngn.afrstar.com'];
        const unique = [...new Set(candidates.filter(Boolean))];
        const report = [];
        
        for (const base of unique) {
          try {
            const c = mgmpay.cfg();
            const probe = await mgmpay.getBalance();
            report.push({ base, http: 200, verdict: 'REACHABLE', snippet: JSON.stringify(probe).slice(0, 160) });
            continue;
            
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
          available: Number(data.balance || 0),
          frozen: 0,
          total: Number(data.balance || 0)
        });
      }
      
      case 'get_bank_map': {
        requireRole(profile, ['admin']);
        const { data } = await supabaseAdmin.from('mgmpay_bank_map').select('*').order('mgmpay_name');
        return sendSuccess(res, { banks: data || [] });
      }
      
      // ---------- EXECUTE A PAYOUT VIA AFRSTAR ----------
      case 'process_payout': {
        requireRole(profile, ['admin']);
        const s = await readGatewaySettings();
        if (s.payout_gateway !== 'afrstar') {
          return sendError(res, 'GATEWAY_MISMATCH', 'Payout gateway is set to manual. Switch it to AfrStar first.', 400);
        }
        
        const { withdrawalId } = req.body;
        const { data: wd } = await supabaseAdmin.from('withdrawals').select('*').eq('id', withdrawalId).single();
        if (!wd) return sendError(res, 'NOT_FOUND', 'Withdrawal not found.', 404);
        if (wd.status !== 'PENDING') return sendError(res, 'VALIDATION_ERROR', `Withdrawal is ${wd.status}, not PENDING.`, 400);
        
        const orderId = 'WD-' + wd.id;
        const bank = await findMgmBankCode(wd.bank_name);
        // Never use wd.bank_code here: it is normally the Paystack code used
        // when the beneficiary account was resolved.
        const bankCode = String(bank?.mgmpay_code || '').trim();
        if (!bankCode) {
          return sendError(res, 'BANK_CODE_REQUIRED', 'This withdrawal has no AfrStar Nigerian bank code. Add the bank-code mapping before paying.', 400);
        }
        
        const result = await mgmpay.createSettlement({
          orderId,
          amount: Number(wd.amount),
          payee: {
            name: wd.account_name,
            account: String(wd.account_number),
            bank_code: bankCode,
            bank_name: bank?.mgmpay_name || wd.bank_name
          }
        });
        
        const respData = result.data || result;
        await supabaseAdmin.from('withdrawals')
          .update({
            status: 'PROCESSING',
            gateway: 'afrstar',
            vqpay_settlement_id: String(respData.platform_osn || ''),
            vqpay_status: String(respData.status || 'init'),
            vqpay_status_code: 0
          })
          .eq('id', wd.id).eq('status', 'PENDING');
        
        return sendSuccess(res, { platform_osn: respData.platform_osn || null },
          'Payout submitted to AfrStar. The payout callback will update the final status.');
      }
      
      case 'query_payout': {
        requireRole(profile, ['admin']);
        return sendError(res, 'AFRSTAR_CALLBACK_ONLY', 'AfrStar payout status is confirmed by callback. Refresh after the provider sends the result.', 400);
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
