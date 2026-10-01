const { getAuthenticatedUser, requireRole } = require('../lib/auth');
const { sendSuccess, sendError } = require('../lib/response');
const { getTaskFeed, submitTaskProof, getAdvertiserSubmissions, reviewSubmission } = require('../lib/task-engine');
const { sendNotification } = require('../lib/notifications');
const { supabaseAdmin } = require('../lib/supabase');

module.exports = async (req, res) => {
  // 1. Handle CORS Preflight
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return sendError(res, 'METHOD_NOT_ALLOWED', 'Only POST allowed.', 405);

  try {
    const { action } = req.body;
    if (!action) return sendError(res, 'VALIDATION_ERROR', 'Missing action.', 400);

    // 2. Authenticate User
    let profile;
    try {
      const authResult = await getAuthenticatedUser(req);
      profile = authResult.profile;
    } catch (authErr) {
      return sendError(res, authErr.code || 'UNAUTHORIZED', authErr.message, 401);
    }

    // 3. Route Actions
    switch (action) {
      
      // --- EARNER ACTIONS ---
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

      // --- ADVERTISER ACTIONS ---
      case 'get_submissions': {
        requireRole(profile, ['advertiser']);
        const submissions = await getAdvertiserSubmissions(profile.id);
        return sendSuccess(res, { submissions });
      }

      case 'review_submission': {
        requireRole(profile, ['advertiser']);
        // Note: We use 'reviewAction' to avoid overwriting the main 'action' variable
        const { submissionId, reviewAction } = req.body; 
        if (!submissionId || !reviewAction) return sendError(res, 'VALIDATION_ERROR', 'Submission ID and Action required.', 400);
        
        const result = await reviewSubmission(profile.id, submissionId, reviewAction);
        
        // Send Notification to Earner
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

      // --- REVIEWER & ADMIN ACTIONS (GLOBAL QUEUE) ---
      case 'reviewer_get_queue': {
        requireRole(profile, ['reviewer', 'admin']);
        
        try {
          // Simple query - just get submissions with basic info
          const { data: submissions, error } = await supabaseAdmin
            .from('task_submissions')
            .select('id, campaign_id, earner_id, proof_url, status, created_at')
            .eq('status', 'PENDING_REVIEW')
            .order('created_at', { ascending: false })
            .limit(100);

          if (error) {
            console.error('Queue fetch error:', error);
            throw error;
          }

          if (!submissions || submissions.length === 0) {
            return sendSuccess(res, { submissions: [] });
          }

          // Fetch campaign titles separately
          const campaignIds = [...new Set(submissions.map(s => s.campaign_id))];
          const { data: campaigns } = await supabaseAdmin
            .from('campaigns')
            .select('id, title, advertiser_id')
            .in('id', campaignIds);

          // Fetch earner names separately
          const earnerIds = [...new Set(submissions.map(s => s.earner_id))];
          const { data: earners } = await supabaseAdmin
            .from('profiles')
            .select('id, full_name, referral_code')
            .in('id', earnerIds);

          // Fetch advertiser names separately
          const advertiserIds = campaigns ? [...new Set(campaigns.map(c => c.advertiser_id))] : [];
          const { data: advertisers } = await supabaseAdmin
            .from('profiles')
            .select('id, full_name')
            .in('id', advertiserIds);

          // Map everything together
          const campMap = new Map(campaigns?.map(c => [c.id, c]) || []);
          const earnerMap = new Map(earners?.map(e => [e.id, e]) || []);
          const advMap = new Map(advertisers?.map(a => [a.id, a]) || []);

          const enriched = submissions.map(s => {
            const camp = campMap.get(s.campaign_id);
            const earner = earnerMap.get(s.earner_id);
            const advertiser = camp ? advMap.get(camp.advertiser_id) : null;
            
            return {
              ...s,
              campaign_title: camp?.title || 'Unknown Campaign',
              earner_name: earner?.full_name || 'Unknown Worker',
              earner_referral: earner?.referral_code || 'N/A',
              advertiser_name: advertiser?.full_name || 'Unknown Advertiser'
            };
          });

          return sendSuccess(res, { submissions: enriched });
        } catch (err) {
          console.error('REVIEWER QUEUE ERROR:', err);
          throw err;
        }
      }

      case 'reviewer_process': {
        requireRole(profile, ['reviewer', 'admin']);
        const { submissionId, reviewAction } = req.body;
        if (!submissionId || !reviewAction) return sendError(res, 'VALIDATION_ERROR', 'Missing fields.', 400);
        
        // Call the dedicated Reviewer SQL function
        const { data, error } = await supabaseAdmin.rpc('process_reviewer_approval', {
          p_submission_id: submissionId,
          p_reviewer_id: profile.id,
          p_action: reviewAction
        });

        if (error) throw { code: 'PROCESSING_ERROR', message: error.message };

        // Notify Earner
        try {
          const { data: sub } = await supabaseAdmin.from('task_submissions').select('earner_id, campaign_id').eq('id', submissionId).single();
          if (sub) {
            const { data: camp } = await supabaseAdmin.from('campaigns').select('title').eq('id', sub.campaign_id).single();
            const msg = reviewAction === 'APPROVED' ? `Your task "${camp?.title || 'submission'}" was approved by our review team.` : `Your task was rejected by our review team.`;
            await sendNotification(sub.earner_id, reviewAction === 'APPROVED' ? 'Task Approved!' : 'Task Rejected', msg, 'TASK');
          }
        } catch (notifErr) { console.error('Notification error:', notifErr); }

        return sendSuccess(res, data, `Task ${reviewAction.toLowerCase()} successfully.`);
      }

      default:
        return sendError(res, 'INVALID_ACTION', 'Unknown action.', 400);
    }
  } catch (err) {
    // CRITICAL: Catch-all to prevent Vercel HTML error pages
    console.error('Tasks API CRITICAL ERROR:', err);
    const msg = err.message || 'Server error occurred';
    return sendError(res, err.code || 'INTERNAL_ERROR', msg, err.statusCode || 500);
  }
};
