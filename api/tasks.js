const { getAuthenticatedUser, requireRole } = require('../lib/auth');
const { sendSuccess, sendError } = require('../lib/response');
const { getTaskFeed, submitTaskProof, getAdvertiserSubmissions, reviewSubmission } = require('../lib/task-engine');
const { sendNotification } = require('../lib/notifications');
const { supabaseAdmin } = require('../lib/supabase');

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return sendError(res, 'METHOD_NOT_ALLOWED', 'Only POST allowed.', 405);
  const { action } = req.body;

  try {
    const { profile } = await getAuthenticatedUser(req);
    switch (action) {
      case 'get_feed': {
        requireRole(profile, ['earner']);
        return sendSuccess(res, { tasks: await getTaskFeed(profile.id, profile) });
      }
      case 'get_details': {
        requireRole(profile, ['earner']);
        const feed = await getTaskFeed(profile.id, profile);
        const task = feed.find(t => t.id === req.body.taskId);
        if (!task) return sendError(res, 'NOT_FOUND', 'Task not found.', 404);
        return sendSuccess(res, { task });
      }
      case 'submit': {
        requireRole(profile, ['earner']);
        const { taskId, proofUrl } = req.body;
        if (!taskId || !proofUrl) return sendError(res, 'VALIDATION_ERROR', 'Missing fields.', 400);
        await submitTaskProof(profile.id, taskId, proofUrl);
        return sendSuccess(res, {}, 'Submitted for review.');
      }
      case 'get_submissions': {
        requireRole(profile, ['advertiser']);
        return sendSuccess(res, { submissions: await getAdvertiserSubmissions(profile.id) });
      }
      case 'review_submission': {
        requireRole(profile, ['advertiser']);
        const { submissionId, action: reviewAction } = req.body;
        if (!submissionId || !reviewAction) return sendError(res, 'VALIDATION_ERROR', 'Missing fields.', 400);
        
        const result = await reviewSubmission(profile.id, submissionId, reviewAction);
        
        // Notification Trigger
        const { data: sub } = await supabaseAdmin.from('task_submissions').select('earner_id, campaign_id').eq('id', submissionId).single();
        const { data: camp } = await supabaseAdmin.from('campaigns').select('title').eq('id', sub.campaign_id).single();
        const msg = reviewAction === 'APPROVED' ? `Your submission for "${camp.title}" was approved. Reward credited.` : `Your submission for "${camp.title}" was rejected.`;
        await sendNotification(sub.earner_id, reviewAction === 'APPROVED' ? 'Task Approved!' : 'Task Rejected', msg, 'TASK');

        return sendSuccess(res, result, `Task ${reviewAction.toLowerCase()} successfully.`);
      }
      default: return sendError(res, 'INVALID_ACTION', 'Unknown action.', 400);
    }
  } catch (err) {
    if (err.code) return sendError(res, err.code, err.message, err.statusCode || 400);
    return sendError(res, 'INTERNAL_ERROR', 'Server error.');
  }
};
