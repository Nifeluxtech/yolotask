const { supabaseAdmin } = require('./supabase');
const { v4: uuidv4 } = require('uuid');

async function sendNotification(userId, title, message, type = 'GENERAL') {
  try {
    const { error } = await supabaseAdmin.from('notifications').insert({
      id: uuidv4(),
      user_id: userId,
      title,
      message,
      type, // e.g., 'TASK', 'WALLET', 'CAMPAIGN', 'SYSTEM'
      is_read: false
    });
    if (error) console.error('Notification insert error:', error);
  } catch (err) {
    console.error('Failed to send notification:', err);
  }
}

async function sendAnnouncement(title, message, type = 'GENERAL') {
  try {
    const { error } = await supabaseAdmin.from('announcements').insert({
      id: uuidv4(),
      title,
      message,
      type,
      is_active: true
    });
    if (error) console.error('Announcement insert error:', error);
  } catch (err) {
    console.error('Failed to send announcement:', err);
  }
}

module.exports = { sendNotification, sendAnnouncement };
