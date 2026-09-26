const { supabaseAdmin } = require('./supabase');
const { v4: uuidv4 } = require('uuid');

async function sendNotification(userId, title, message, type = 'GENERAL') {
  try {
    await supabaseAdmin.from('notifications').insert({
      id: uuidv4(), user_id: userId, title, message, type, is_read: false
    });
  } catch (err) { console.error('Notification error:', err); }
}

async function sendAnnouncement(title, message, type = 'GENERAL') {
  try {
    await supabaseAdmin.from('announcements').insert({
      id: uuidv4(), title, message, type, is_active: true
    });
  } catch (err) { console.error('Announcement error:', err); }
}

module.exports = { sendNotification, sendAnnouncement };
