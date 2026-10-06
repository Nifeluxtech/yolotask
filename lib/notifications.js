// /lib/notifications.js
const { supabaseAdmin } = require('./supabase');

const SUPPORT_EMAIL = 'support@nifelux.com';
const APP_URL = process.env.APP_URL || 'https://yolotask-flax.vercel.app';
const ONESIGNAL_REST_KEY = process.env.ONESIGNAL_REST_API_KEY;
const ONESIGNAL_APP_ID = process.env.ONESIGNAL_APP_ID_PUBLIC || '';

/**
 * Sends a push notification to one user via OneSignal (fire-and-forget).
 */
async function pushToUser(userId, title, message) {
  if (!ONESIGNAL_REST_KEY || !ONESIGNAL_APP_ID) return;
  try {
    await fetch('https://api.onesignal.com/notifications', {
      method: 'POST',
      headers: {
        Authorization: `Key ${ONESIGNAL_REST_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        app_id: ONESIGNAL_APP_ID,
        include_filters: [{ field: 'tag', key: 'user_id', relation: '=', value: userId }],
        headings: { en: title },
        contents: { en: message },
        url: APP_URL,
        android_channel_id: 'yolotask-default'
      })
    });
  } catch (e) {
    console.error('pushToUser error:', e.message);
  }
}

/**
 * Sends a push broadcast to all subscribed devices.
 */
async function pushToAll(title, message) {
  if (!ONESIGNAL_REST_KEY || !ONESIGNAL_APP_ID) return;
  try {
    await fetch('https://api.onesignal.com/notifications', {
      method: 'POST',
      headers: {
        Authorization: `Key ${ONESIGNAL_REST_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        app_id: ONESIGNAL_APP_ID,
        included_segments: ['Subscribed'],
        headings: { en: title },
        contents: { en: message },
        url: APP_URL
      })
    });
  } catch (e) {
    console.error('pushToAll error:', e.message);
  }
}

/**
 * Inserts an in-app notification + sends push.
 */
async function sendNotification(userId, title, message, type = 'GENERAL') {
  const { error } = await supabaseAdmin
    .from('notifications')
    .insert({ user_id: userId, title, message, type });
  if (error) console.error('sendNotification error:', error);

  pushToUser(userId, title, message); // async, non-blocking
  return !error;
}

/**
 * Publishes a platform-wide announcement: in-app + push broadcast.
 */
async function sendAnnouncement(title, message, type = 'GENERAL') {
  const { error: annErr } = await supabaseAdmin
    .from('announcements')
    .insert({ title, message, type });
  if (annErr) throw annErr;

  const { data: profiles, error: profErr } = await supabaseAdmin
    .from('profiles')
    .select('id');

  if (profErr) {
    console.error('sendAnnouncement: failed to fetch profiles:', profErr);
    return true;
  }
  if (!profiles || profiles.length === 0) return true;

  const rows = profiles.map(p => ({ user_id: p.id, title, message, type: 'ANNOUNCEMENT' }));
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await supabaseAdmin.from('notifications').insert(rows.slice(i, i + 500));
    if (error) console.error('announcement notification batch error:', error);
  }

  pushToAll(title, message); // async, non-blocking
  return true;
}

function buildEmailHtml(title, message) {
  return `
  <div style="background:#0A1628; padding:40px 20px; font-family: Arial, Helvetica, sans-serif;">
    <div style="max-width:560px; margin:0 auto; background:#101E33; border:1px solid #1E3A5F; border-radius:12px; overflow:hidden;">
      <div style="background:#00D4FF; padding:18px 30px;">
        <span style="color:#0A1628; font-size:22px; font-weight:800; letter-spacing:1px;">YOLOTASK</span>
      </div>
      <div style="padding:30px;">
        <h1 style="color:#FFFFFF; font-size:20px; margin:0 0 16px;">${title}</h1>
        <p style="color:#B8C4D6; font-size:15px; line-height:1.7; margin:0 0 24px; white-space:pre-wrap;">${message}</p>
        <a href="${APP_URL}" style="display:inline-block; background:#00D4FF; color:#0A1628; font-weight:700; text-decoration:none; padding:12px 26px; border-radius:8px; font-size:14px;">Open YOLOTASK</a>
      </div>
      <div style="padding:18px 30px; border-top:1px solid #1E3A5F; color:#64748B; font-size:12px; line-height:1.8;">
        You received this email because you have a YOLOTASK account.<br/>
        <a href="${APP_URL}/terms.html" style="color:#64748B;">Terms</a> •
        <a href="${APP_URL}/privacy.html" style="color:#64748B;">Privacy</a> •
        <a href="${APP_URL}/refunds.html" style="color:#64748B;">Refunds</a><br/>
        <a href="mailto:${SUPPORT_EMAIL}?subject=Unsubscribe" style="color:#64748B;">Unsubscribe from announcements</a> •
        Nifelux Media, Lagos, Nigeria
      </div>
    </div>
  </div>`;
}

function buildEmailText(title, message) {
  return `YOLOTASK\n\n${title}\n\n${message}\n\nOpen YOLOTASK: ${APP_URL}\n\n---\nYou received this email because you have a YOLOTASK account.\nUnsubscribe: mailto:${SUPPORT_EMAIL}?subject=Unsubscribe\nNifelux Media, Lagos, Nigeria`;
}

/**
 * Platform-wide email broadcast via Resend (batches of 50).
 */
async function sendEmailBroadcast(title, message) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    throw { code: 'EMAIL_NOT_CONFIGURED', message: 'RESEND_API_KEY is not set in Vercel environment variables.', statusCode: 500 };
  }

  const from = process.env.EMAIL_FROM || 'YOLOTASK <onboarding@resend.dev>';
  const html = buildEmailHtml(title, message);
  const text = buildEmailText(title, message);

  const emails = [];
  let page = 1;
  while (true) {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: 100 });
    if (error) throw error;
    const users = data?.users || [];
    users.forEach(u => { if (u.email) emails.push(u.email); });
    if (users.length < 100) break;
    page++;
    if (page > 50) break;
  }

  if (emails.length === 0) return { sent: 0, failed: 0, errors: [] };

  let sent = 0;
  let failed = 0;
  const errors = [];

  for (let i = 0; i < emails.length; i += 50) {
    const chunk = emails.slice(i, i + 50).map(email => ({
      from,
      to: [email],
      reply_to: SUPPORT_EMAIL,
      subject: `[YOLOTASK] ${title}`,
      html,
      text,
      headers: {
        'List-Unsubscribe': `<mailto:${SUPPORT_EMAIL}?subject=Unsubscribe>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        'Precedence': 'bulk'
      }
    }));

    try {
      const resp = await fetch('https://api.resend.com/emails/batch', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(chunk)
      });
      const result = await resp.json();
      if (resp.ok) sent += chunk.length;
      else {
        failed += chunk.length;
        const errMsg = result?.message || result?.error?.message || JSON.stringify(result);
        errors.push(errMsg);
        console.error('Resend batch error:', result);
      }
    } catch (e) {
      failed += chunk.length;
      errors.push(e.message || 'Network error');
      console.error('Resend batch exception:', e);
    }
  }

  return { sent, failed, errors: [...new Set(errors)].slice(0, 5) };
}

module.exports = { sendNotification, sendAnnouncement, sendEmailBroadcast, pushToUser, pushToAll, buildEmailHtml, buildEmailText };
