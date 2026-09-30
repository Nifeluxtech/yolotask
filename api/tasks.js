const { getAuthenticatedUser, requireRole } = require('../lib/auth');
const { sendSuccess, sendError } = require('../lib/response');
const { getTaskFeed, submitTaskProof, getAdvertiserSubmissions, reviewSubmission } = require('../lib/task-engine');
const { sendNotification } = require('../lib/notifications');
const { supabaseAdmin } = require('../lib/supabase');

module.exports = async (req, res) => {
  // CORS handling
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return sendError(res, 'METHOD_NOT_ALLOWED', 'Only POST allowed.', 405);

  try {
    const { action } = req.body;
    if (!action) return sendError(res, 'VALIDATION_ERROR', 'Missing action.', 400);

    // Authenticate user
    let profile;
    try {
      const authResult = await getAuthenticatedUser(req);
      profile = authResult.profile;
    } catch (authErr) {
      return sendError(res, authErr.code || 'UNAUTHORIZED', authErr.message, 401);
    }

    switch (action) {
      case 'get_feed': {
        requireRole(profile, ['earner']);
        const feed = await getTaskFeed(profile.id, profile);
        return sendSuccess(res, { tasks: feed });
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
        const submissions = await getAdvertiserSubmissions(profile.id);
        return sendSuccess(res, { submissions });
      }

      case 'review_submission': {
        requireRole(profile, ['advertiser']);
        const { submissionId, reviewAction } = req.body;
        if (!submissionId || !reviewAction) return sendError(res, 'VALIDATION_ERROR', 'Submission ID and Action required.', 400);
        
        const result = await reviewSubmission(profile.id, submissionId, reviewAction);
        
        // Send notification
        try {
          const { data: sub } = await supabaseAdmin.from('task_submissions').select('earner_id, campaign_id').eq('id', submissionId).single();
          if (sub) {
            const { data: camp } = await supabaseAdmin.from('campaigns').select('title').eq('id', sub.campaign_id).single();
            const msg = reviewAction === 'APPROVED' ? `Your submission for "${camp?.title || 'a task'}" was approved.` : `Your submission was rejected.`;
            await sendNotification(sub.earner_id, reviewAction === 'APPROVED' ? 'Task Approved!' : 'Task Rejected', msg, 'TASK');
          }
        } catch (notifErr) { console.error('Notification error:', notifErr); }

        return sendSuccess(res, result, `Task ${reviewAction.toLowerCase()} successfully.`);
      }

      default:
        return sendError(res, 'INVALID_ACTION', 'Unknown action.', 400);
    }
  } catch (err) {
    // CATCH ALL: Prevents Vercel HTML error pages
    console.error('Tasks API CRITICAL ERROR:', err);
    const msg = err.message || 'Server error occurred';
    return sendError(res, err.code || 'INTERNAL_ERROR', msg, err.statusCode || 500);
  }
  case 'reviewer_get_queue': {
        // Reviewers and Admins can see ALL pending submissions across the platform
        requireRole(profile, ['reviewer', 'admin']);
        
        const { data: submissions, error } = await supabaseAdmin
          .from('task_submissions')
          .select(`
            id, campaign_id, earner_id, proof_url, status, created_at,
            campaign:campaign_id(title, advertiser_id),
            earner:earner_id(full_name, referral_code),
            advertiser:campaign.advertiser_id(full_name)
          `)
          .eq('status', 'PENDING_REVIEW')
          .order('created_at', { ascending: false })
          .limit(100); // Load 100 at a time for performance

        if (error) throw error;
        return sendSuccess(res, { submissions: submissions || [] });
      }

      case 'reviewer_process': {
        requireRole(profile, ['reviewer', 'admin']);
        const { submissionId, reviewAction } = req.body;
        if (!submissionId || !reviewAction) return sendError(res, 'VALIDATION_ERROR', 'Missing fields.', 400);
        
        const { data, error } = await supabaseAdmin.rpc('process_reviewer_approval', {
          p_submission_id: submissionId,
          p_reviewer_id: profile.id,
          p_action: reviewAction
        });

        if (error) throw { code: 'PROCESSING_ERROR', message: error.message };
        return sendSuccess(res, data, `Task ${reviewAction.toLowerCase()} successfully.`);
      }
};
