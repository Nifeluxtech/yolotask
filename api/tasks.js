const { getAuthenticatedUser, requireRole } = require('../lib/auth');
const { sendSuccess, sendError } = require('../lib/response');
const { getTaskFeed, submitTaskProof } = require('../lib/task-engine');

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return sendError(res, 'METHOD_NOT_ALLOWED', 'Only POST allowed.', 405);

  const { action } = req.body;

  try {
    // All task actions require authentication
    const { profile } = await getAuthenticatedUser(req);

    switch (action) {
      
      case 'get_feed': {
        requireRole(profile, ['earner']);
        const feed = await getTaskFeed(profile.id, profile);
        return sendSuccess(res, { tasks: feed });
      }

      case 'get_details': {
        requireRole(profile, ['earner']);
        const { taskId } = req.body;
        if (!taskId) return sendError(res, 'VALIDATION_ERROR', 'Task ID required.', 400);
        
        // Fetch specific details (reusing feed logic but filtering for one)
        const feed = await getTaskFeed(profile.id, profile);
        const task = feed.find(t => t.id === taskId);
        
        if (!task) return sendError(res, 'NOT_FOUND', 'Task not found or ineligible.', 404);
        return sendSuccess(res, { task });
      }

      case 'submit': {
        requireRole(profile, ['earner']);
        const { taskId, proofUrl } = req.body;
        
        if (!taskId || !proofUrl) {
          return sendError(res, 'VALIDATION_ERROR', 'Task ID and Proof URL required.', 400);
        }

        const submission = await submitTaskProof(profile.id, taskId, proofUrl);
        return sendSuccess(res, { submission }, 'Task submitted for review.');
      }

      default:
        return sendError(res, 'INVALID_ACTION', 'Unknown task action.', 400);
    }
  } catch (err) {
    if (err.code) return sendError(res, err.code, err.message, err.statusCode || 400);
    console.error('Tasks API Error:', err);
    return sendError(res, 'INTERNAL_ERROR', 'Server error.');
  }
  case 'get_submissions': {
        requireRole(profile, ['advertiser']);
        const submissions = await getAdvertiserSubmissions(profile.id);
        return sendSuccess(res, { submissions });
      }

      case 'review_submission': {
        requireRole(profile, ['advertiser']);
        const { submissionId, action } = req.body;
        
        if (!submissionId || !action) {
          return sendError(res, 'VALIDATION_ERROR', 'Submission ID and Action required.', 400);
          // ... inside the 'review_submission' case, after successful review ...
const { sendNotification } = require('../lib/notifications');

// Fetch earner name for the message
const { data: earnerProfile } = await supabaseAdmin.from('profiles').select('full_name').eq('id', submission.earner_id).single();

if (action === 'APPROVED') {
  await sendNotification(submission.earner_id, 'Task Approved!', `Your submission for "${submission.campaign_title}" was approved. Your reward has been credited.`, 'TASK');
} else {
  await sendNotification(submission.earner_id, 'Task Rejected', `Your submission for "${submission.campaign_title}" was rejected. Please ensure you follow instructions carefully.`, 'TASK');
}
        }

        const result = await reviewSubmission(profile.id, submissionId, action);
        return sendSuccess(res, result, `Task ${action.toLowerCase()} successfully.`);
      }
};
