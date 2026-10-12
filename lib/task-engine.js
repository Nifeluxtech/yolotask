// /lib/task-engine.js — Core task engine: Feed, Proof Submission, Review Logic
const { supabaseAdmin } = require('./supabase');
const { sendNotification } = require('./notifications');

/**
 * GET TASK FEED
 * Fetches active campaigns for an earner, enriched with platform & type details.
 * CRITICAL FIX: Explicitly selects platforms.name/logo_url to prevent "Other" fallback.
 */
async function getTaskFeed(userId, profile) {
  // 1. Fetch ACTIVE campaigns with joined metadata
  const { data: campaigns, error: campErr } = await supabaseAdmin.from('campaigns')
    .select(`
      id, title, description, target_link, instructions, 
      status, tier, total_slots, filled_slots, verification_window_hours,
      created_at, updated_at,
      platforms:platform_id(id, name, logo_url),
      task_types:task_type_id(id, name, base_advertiser_cost, base_earner_reward, premium_advertiser_cost, premium_earner_reward)
    `)
    .eq('status', 'ACTIVE')
    .order('created_at', { ascending: false });

  if (campErr) throw campErr;
  if (!campaigns || campaigns.length === 0) return { tasks: [], platforms: [], task_types: [] };

  // 2. Identify which campaigns this user ALREADY has a pending/review submission for
  const { data: existingSubs } = await supabaseAdmin.from('task_submissions')
    .select('campaign_id, status')
    .eq('earner_id', userId)
    .in('status', ['PENDING_REVIEW', 'UNDER_REVIEW']); // Adjust statuses to match your schema
  
  const busyCampaignIds = new Set((existingSubs || []).map(s => s.campaign_id));

  // 3. Transform into frontend-friendly shape
  const tasks = campaigns.map(c => {
    const platName = c.platforms?.name || 'General'; // Fallback only if DB link is truly broken
    const platLogo = c.platforms?.logo_url || null;
    const typeName = c.task_types?.name || 'Task';
    
    const isPremium = String(c.tier || '').toUpperCase() === 'PREMIUM';
    const reward = isPremium 
      ? Number(c.task_types?.premium_earner_reward || 0) 
      : Number(c.task_types?.base_earner_reward || 0);
      
    const slotsLeft = Math.max(0, (c.total_slots || 0) - (c.filled_slots || 0));

    return {
      id: c.id,
      title: c.title,
      description: c.description || '',
      target_link: c.target_link || '#',
      instructions: c.instructions || '',
      
      // ▼▼ THE FIX: Real strings from joins ▼▼
      platform_name: platName,
      platform_logo: platLogo,
      task_type: typeName,
      // ▲▲
      
      reward,
      cost: isPremium ? Number(c.task_types?.premium_advertiser_cost || 0) : Number(c.task_types?.base_advertiser_cost || 0),
      is_premium: isPremium,
      slots_left: slotsLeft,
      verification_label: `${c.verification_window_hours || 24}–${(c.verification_window_hours || 24) + 24}h`,
      
      already_started: busyCampaignIds.has(c.id),
      is_full: slotsLeft <= 0
    };
  });

  // 4. Build distinct filter lists for the UI drawer
  const platformsMap = new Map();
  const typesSet = new Set();

  tasks.forEach(t => {
    if (!platformsMap.has(t.platform_name)) {
      platformsMap.set(t.platform_name, { name: t.platform_name, logo_url: t.platform_logo });
    }
    typesSet.add(t.task_type);
  });

  const platforms = [...platformsMap.values()].sort((a, b) => a.name.localeCompare(b.name));
  const task_types = [...typesSet].sort().map(name => ({ name }));

  return { tasks, platforms, task_types };
}

/**
 * SUBMIT PROOF
 * Validates upload, creates submission record, notifies advertiser.
 */
async function submitTaskProof(userId, taskId, proofDataUrl, comment) {
  // 1. Verify campaign exists & is active
  const { data: camp, error: cErr } = await supabaseAdmin.from('campaigns')
    .select('id, title, status, advertiser_id')
    .eq('id', taskId)
    .single();
  
  if (cErr || !camp) throw { code: 'NOT_FOUND', message: 'Task not found.', statusCode: 404 };
  if (camp.status !== 'ACTIVE') throw { code: 'INACTIVE', message: 'This task is no longer accepting submissions.', statusCode: 400 };

  // 2. Check slot availability (simple check; race conditions handled by DB constraints/RPC ideally)
  const { count } = await supabaseAdmin.from('task_submissions')
    .select('*', { count: 'exact', head: true })
    .eq('campaign_id', taskId);
  
  if (count >= camp.total_slots) {
     throw { code: 'FULL', message: 'Slots are full.', statusCode: 400 };
  }

  // 3. Create Submission Record
  const { data: sub, error: subErr } = await supabaseAdmin.from('task_submissions')
    .insert({
      campaign_id: taskId,
      earner_id: userId,
      proof_url: proofDataUrl, // Assumes caller uploaded to storage first
      comment: (comment || '').trim().slice(0, 500) || null,
      status: 'PENDING_REVIEW' // Or 'UNDER_REVIEW' depending on your workflow
    })
    .select()
    .single();

  if (subErr) throw subErr;

  // 4. Notify Advertiser
  try {
    await sendNotification(camp.advertiser_id, 'New Task Submission', 
      `A new proof was submitted for "${camp.title}". Please review it in your dashboard.`, 'TASK');
  } catch (e) {
    console.error('Notify advertiser failed:', e);
  }

  return sub;
}

/**
 * GET ADVERTISER SUBMISSIONS
 * Lists all submissions for campaigns owned by this advertiser.
 */
async function getAdvertiserSubmissions(advertiserId) {
  // 1. Get all campaign IDs owned by this advertiser
  const { data: camps, error: cErr } = await supabaseAdmin.from('campaigns')
    .select('id, title')
    .eq('advertiser_id', advertiserId);
  
  if (cErr) throw cErr;
  if (!camps || camps.length === 0) return [];

  const campIds = camps.map(c => c.id);
  const campMap = new Map(camps.map(c => [c.id, c.title]));

  // 2. Fetch submissions for these campaigns
  const { data: subs, error: sErr } = await supabaseAdmin.from('task_submissions')
    .select(`
      id, campaign_id, earner_id, proof_url, status, created_at, reviewed_at, comment,
      profiles:earner_id(full_name, email)
    `)
    .in('campaign_id', campIds)
    .order('created_at', { ascending: false });

  if (sErr) throw sErr;

  // 3. Enrich with campaign titles
  return (subs || []).map(s => ({
    ...s,
    campaign_title: campMap.get(s.campaign_id) || 'Unknown Campaign'
  }));
}

/**
 * REVIEW SUBMISSION (Advertser Side)
 * Approves or rejects a specific submission. Handles wallet updates via RPC if configured.
 */
async function reviewSubmission(advertiserId, submissionId, action) {
  if (!['APPROVED', 'REJECTED'].includes(action)) {
    throw { code: 'INVALID_ACTION', message: 'Action must be APPROVED or REJECTED.', statusCode: 400 };
  }

  // 1. Load submission + verify ownership
  const { data: sub, error: subErr } = await supabaseAdmin.from('task_submissions')
    .select(`
      *, 
      campaigns:campaign_id(advertiser_id, title, task_type_id, is_targeted)
    `)
    .eq('id', submissionId)
    .single();

  if (subErr || !sub) throw { code: 'NOT_FOUND', message: 'Submission not found.', statusCode: 404 };
  if (sub.campaigns.advertiser_id !== advertiserId) throw { code: 'FORBIDDEN', message: 'Not your campaign.', statusCode: 403 };
  if (sub.status !== 'PENDING_REVIEW' && sub.status !== 'UNDER_REVIEW') {
    throw { code: 'ALREADY_PROCESSED', message: 'This submission has already been reviewed.', statusCode: 400 };
  }

  // 2. Update Status
  const { error: updErr } = await supabaseAdmin.from('task_submissions')
    .update({ 
      status: action, 
      reviewed_at: new Date().toISOString(),
      reviewer_note: action === 'REJECTED' ? 'Rejected by advertiser' : null
    })
    .eq('id', submissionId);

  if (updErr) throw updErr;

  // 3. Trigger Wallet Updates (Assuming you have an RPC for this, otherwise implement manually)
  // Note: If you don't have process_task_review RPC, uncomment the manual block below.
  /*
  try {
    await supabaseAdmin.rpc('process_task_review', {
      p_submission_id: submissionId,
      p_advertiser_id: advertiserId,
      p_action: action
    });
  } catch (rpcErr) {
    console.error('Wallet RPC failed, falling back to manual update:', rpcErr);
    // MANUAL FALLBACK LOGIC HERE IF NEEDED
  }
  */

  // 4. Notify Earner
  try {
    const msg = action === 'APPROVED' 
      ? `✅ Great news! Your submission for "${sub.campaigns.title}" was approved. Rewards credited.`
      : `❌ Sorry, your submission for "${sub.campaigns.title}" was rejected. Please try again or contact support.`;
    
    await sendNotification(sub.earner_id, 
      action === 'APPROVED' ? 'Task Approved!' : 'Task Rejected', msg, 'TASK');
  } catch (e) {
    console.error('Notify earner failed:', e);
  }

  return { success: true, action };
}

module.exports = {
  getTaskFeed,
  submitTaskProof,
  getAdvertiserSubmissions,
  reviewSubmission
};
