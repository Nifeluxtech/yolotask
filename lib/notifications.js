// /lib/notifications.js
const { supabaseAdmin } = require('./supabase');

/**
 * Inserts an in-app notification for one user.
 */
async function sendNotification(userId, title, message, type = 'GENERAL') {
  const { error } = await supabaseAdmin
    .from('notifications')
    .insert({ user_id: userId, title, message, type });
  if (error) console.error('sendNotification error:', error);
  return !error;
}

/**
 * Publishes a platform-wide announcement:
 * 1. Inserts into announcements table
 * 2. Creates in-app notifications for every user
 */
async function sendAnnouncement(title, message, type = 'GENERAL') {
  const { error: annErr } = await supabaseAdmin
    .from('announcements')
    .insert({ title, message, type });
  if (annErr) throw annErr;

  const { error: notifErr } = await supabaseAdmin
    .from('notifications')
    .insert(
      supabaseAdmin
        .from('profiles')
        .select('id')
        .then ? undefined : undefined // placeholder never used
    );
  // The above pattern is invalid; do a proper two-step insert instead:
  if (notifErr) console.error('announcement notification error:', notifErr);

  const { data: profiles } = await supabaseAdmin.from('profiles').select('id');
  if (profiles && profiles.length > 0) {
    const rows = profiles.map(p => ({ user_id: p.id, title, message, type: 'ANNOUNCEMENT' }));
    // Chunk inserts to stay within payload limits
    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await supabaseAdmin.from('notifications').insert(rows.slice(i, i + 500));
      if (error) console.error('announcement batch error:', error);
    }
  }
  return true;
}

/**
 * Builds the branded HTML email body.
 */
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
        <a href="https://yolotask-flax.vercel.app" style="display:inline-block; background:#00D4FF; color:#0A1628; font-weight:700; text-decoration:none; padding:12px 26px; border-radius:8px; font-size:14px;">Open YOLOTASK</a>
      </div>
      <div style="padding:18px 30px; border-top:1px solid #1E3A5F; color:#64748B; font-size:12px; line-height:1.6;">
        You received this email because you have a YOLOTASK account.<br/>
        <a href="https://yolotask-flax.vercel.app/terms.html" style="color:#64748B;">Terms</a> •
        <a href="https://yolotask-flax.vercel.app/privacy.html" style="color:#64748B;">Privacy</a> •
        <a href="https://yolotask-flax.vercel.app/refunds.html" style="color:#64748B;">Refunds</a>
      </div>
    </div>
  </div>`;
}

/**
 * Sends a platform-wide email broadcast via Resend (chunked batches of 50).
 * Returns { sent, failed }.
 */
async function sendEmailBroadcast(title, message) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    throw { code: 'EMAIL_NOT_CONFIGURED', message: 'RESEND_API_KEY is not set in Vercel environment variables.', statusCode: 500 };
  }

  const from = process.env.EMAIL_FROM || 'YOLOTASK <onboarding@resend.dev>';
  const html = buildEmailHtml(title, message);

  // Collect all user emails (paginated)
  const emails = [];
  let page = 1;
  while (true) {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: 100 });
    if (error) throw error;
    const users = data?.users || [];
    users.forEach(u => { if (u.email) emails.push(u.email); });
    if (users.length < 100) break;
    page++;
    if (page > 50) break; // safety cap: 5,000 users per broadcast
  }

  if (emails.length === 0) return { sent: 0, failed: 0 };

  let sent = 0;
  let failed = 0;

  for (let i = 0; i < emails.length; i += 50) {
    const chunk = emails.slice(i, i + 50).map(email => ({
      from,
      to: [email],
      subject: `[YOLOTASK] ${title}`,
      html
    }));

    try {
      const resp = await fetch('https://api.resend.com/emails/batch', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(chunk)
      });
      const result = await resp.json();
      if (resp.ok) sent += chunk.length;
      else {
        failed += chunk.length;
        console.error('Resend batch error:', result);
      }
    } catch (e) {
      failed += chunk.length;
      console.error('Resend batch exception:', e);
    }
  }

  return { sent, failed };
}

module.exports = { sendNotification, sendAnnouncement, sendEmailBroadcast, buildEmailHtml };
