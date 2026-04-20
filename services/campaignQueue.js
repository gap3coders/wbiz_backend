/**
 * Campaign Queue Service — BullMQ
 *
 * Handles scheduled campaign execution via Redis-backed job queues.
 * Falls back gracefully if Redis is unavailable (campaigns run in-process).
 *
 * Jobs:
 *   - campaign:launch  → Launches a campaign immediately
 *   - campaign:check   → Repeating job to check for due scheduled campaigns
 */

let Queue, Worker;
try {
  ({ Queue, Worker } = require('bullmq'));
} catch {
  Queue = null;
  Worker = null;
}

const config = require('../config');

const QUEUE_NAME = 'campaigns';
let campaignQueue = null;
let campaignWorker = null;
let schedulerWorker = null;
let redisAvailable = false;

/**
 * Parse Redis URL into IORedis connection options.
 */
const getRedisConnection = () => {
  const url = config.redis?.url || 'redis://127.0.0.1:6379';
  try {
    const parsed = new URL(url);
    return {
      host: parsed.hostname || '127.0.0.1',
      port: parseInt(parsed.port || '6379', 10),
      password: parsed.password || undefined,
      maxRetriesPerRequest: null,
    };
  } catch {
    return { host: '127.0.0.1', port: 6379, maxRetriesPerRequest: null };
  }
};

/**
 * Initialize the campaign queue and workers.
 * Called from server.js during bootstrap.
 */
const initializeCampaignQueue = async () => {
  if (!Queue || !Worker) {
    console.log('[CampaignQueue] BullMQ not installed; campaign queue disabled');
    return false;
  }

  const connection = getRedisConnection();

  try {
    campaignQueue = new Queue(QUEUE_NAME, { connection });

    // Test connection
    await campaignQueue.waitUntilReady();
    redisAvailable = true;

    // Worker: processes campaign launch jobs
    campaignWorker = new Worker(
      QUEUE_NAME,
      async (job) => {
        const { campaignId, tenantId } = job.data;

        // Dynamic import to avoid circular deps
        const Campaign = require('../models/Campaign');
        const Contact = require('../models/Contact');
        const Message = require('../models/Message');
        const Notification = require('../models/Notification');
        const WhatsAppAccount = require('../models/WhatsAppAccount');
        const { decrypt } = require('./encryptionService');
        const metaService = require('./metaService');
        const { emitToTenant } = require('./socketService');

        const campaign = await Campaign.findById(campaignId);
        if (!campaign || campaign.status === 'completed') return;

        const wa = await WhatsAppAccount.findOne({ tenant_id: tenantId, is_default: true })
          || await WhatsAppAccount.findOne({ tenant_id: tenantId });
        if (!wa) throw new Error('No WhatsApp account');
        const accessToken = decrypt(wa.access_token_encrypted);
        const phoneNumberId = wa.phone_number_id;

        // Resolve recipients
        let phones = [];
        if (campaign.target_type === 'all') {
          const contacts = await Contact.find({ tenant_id: tenantId, opt_in: { $ne: false } }).select('phone');
          phones = contacts.map((c) => c.phone);
        } else if (campaign.target_type === 'tags') {
          const contacts = await Contact.find({
            tenant_id: tenantId,
            opt_in: { $ne: false },
            $or: [{ labels: { $in: campaign.target_tags } }, { tags: { $in: campaign.target_tags } }],
          }).select('phone');
          phones = contacts.map((c) => c.phone);
        } else {
          phones = campaign.recipients || [];
        }

        const uniquePhones = [...new Set(phones.map((p) => String(p).replace(/[^\d]/g, '')).filter(Boolean))];

        campaign.status = 'running';
        campaign.started_at = new Date();
        campaign.stats = { total: uniquePhones.length, sent: 0, delivered: 0, read: 0, failed: 0, errors: [] };
        await campaign.save();

        emitToTenant(tenantId, 'campaign:progress', {
          campaign_id: campaignId,
          status: 'running',
          stats: campaign.stats,
        });

        // Send messages
        for (let i = 0; i < uniquePhones.length; i++) {
          const phone = uniquePhones[i];
          try {
            const result = await metaService.sendTemplateMessage(accessToken, phoneNumberId, phone, {
              name: campaign.template_name,
              language: { code: campaign.template_language || 'en' },
              components: campaign.template_components || [],
            });

            campaign.stats.sent += 1;

            await Message.create({
              tenant_id: tenantId,
              wa_message_id: result?.messages?.[0]?.id || null,
              contact_phone: phone,
              direction: 'outbound',
              message_type: 'template',
              content: `[Template: ${campaign.template_name}]`,
              template_name: campaign.template_name,
              status: 'accepted',
              campaign_id: campaignId,
              message_source: 'campaign',
              timestamp: new Date(),
            });
          } catch (err) {
            campaign.stats.failed += 1;
            campaign.stats.errors.push({ phone, error: err.message });

            // Send immediate error alert on critical failures (rate limit, API down)
            // Only alert once per campaign (check if we haven't alerted yet)
            const isCritical = /rate.?limit|too.?many|unauthorized|forbidden|server.?error|503|429/i.test(err.message);
            if (isCritical && !campaign._errorAlertSent) {
              campaign._errorAlertSent = true;
              try {
                const { sendCampaignErrorAlert } = require('./campaignReportService');
                await sendCampaignErrorAlert(campaign, {
                  message: err.message,
                  error_code: err.code || err.response?.status || '',
                  impacted_count: uniquePhones.length - i,
                });
              } catch (alertErr) {
                console.error(`[CampaignQueue] Error alert failed:`, alertErr.message);
              }
            }
          }

          // Progress update every 10 messages
          if ((i + 1) % 10 === 0 || i === uniquePhones.length - 1) {
            await campaign.save();
            emitToTenant(tenantId, 'campaign:progress', {
              campaign_id: campaignId,
              status: 'running',
              stats: campaign.stats,
              progress: Math.round(((i + 1) / uniquePhones.length) * 100),
            });
          }

          // Rate limit: 120ms between sends
          if (i < uniquePhones.length - 1) {
            await new Promise((r) => setTimeout(r, 120));
          }
        }

        campaign.status = 'completed';
        campaign.completed_at = new Date();
        await campaign.save();

        // Create completion notification
        await Notification.create({
          tenant_id: tenantId,
          type: 'campaign_complete',
          title: `Campaign "${campaign.name}" completed`,
          message: `Sent ${campaign.stats.sent} of ${campaign.stats.total} messages. ${campaign.stats.failed} failed.`,
          source: 'platform',
          severity: campaign.stats.failed > 0 ? 'warning' : 'success',
        });

        // Send completion report email (non-blocking)
        try {
          const { sendCampaignCompletionReport } = require('./campaignReportService');
          const reportResult = await sendCampaignCompletionReport(campaign);
          if (reportResult) {
            campaign.report_sent_at = new Date();
            await campaign.save();
          }
        } catch (reportErr) {
          console.error(`[CampaignQueue] Report email failed (non-critical):`, reportErr.message);
        }

        // ── Post-Campaign: Tag contacts by delivery status ──
        if (campaign.tag_by_status) {
          try {
            const prefix = campaign.tag_prefix || campaign.name.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
            const sentMessages = await Message.find({
              tenant_id: tenantId,
              campaign_id: campaignId,
              direction: 'outbound',
            }).select('contact_phone status').lean();

            const statusGroups = {};
            for (const msg of sentMessages) {
              const tag = `${prefix}_${msg.status || 'unknown'}`;
              if (!statusGroups[tag]) statusGroups[tag] = [];
              statusGroups[tag].push(msg.contact_phone);
            }

            for (const [tag, phones] of Object.entries(statusGroups)) {
              if (phones.length > 0) {
                await Contact.updateMany(
                  { tenant_id: tenantId, phone: { $in: phones } },
                  { $addToSet: { tags: tag, labels: tag } }
                );
              }
            }
            console.log(`[CampaignQueue] Tagged contacts for campaign ${campaignId}: ${Object.keys(statusGroups).join(', ')}`);
          } catch (tagErr) {
            console.error(`[CampaignQueue] Tag-by-status failed (non-critical):`, tagErr.message);
          }
        }

        // ── Post-Campaign: Auto-unsubscribe on repeated failures ──
        if (campaign.auto_unsubscribe_failures) {
          try {
            const threshold = campaign.auto_unsubscribe_threshold || 3;
            const failedPhones = campaign.stats.errors.map((e) => e.phone).filter(Boolean);

            for (const phone of failedPhones) {
              // Count consecutive campaign failures for this contact
              const recentFails = await Message.countDocuments({
                tenant_id: tenantId,
                contact_phone: phone,
                direction: 'outbound',
                status: 'failed',
                campaign_id: { $ne: null },
              });

              if (recentFails >= threshold) {
                await Contact.updateOne(
                  { tenant_id: tenantId, phone },
                  {
                    opt_in: false,
                    subscription_status: 'unsubscribed',
                    unsubscribed_at: new Date(),
                    unsubscribe_reason: `Auto-unsubscribed: ${recentFails} consecutive campaign failures`,
                  }
                );
                console.log(`[CampaignQueue] Auto-unsubscribed ${phone} after ${recentFails} failures`);
              }
            }
          } catch (unsubErr) {
            console.error(`[CampaignQueue] Auto-unsubscribe failed (non-critical):`, unsubErr.message);
          }
        }

        // ── Post-Campaign: Schedule auto-resend of failed messages ──
        if (campaign.auto_resend_failed && !campaign.auto_resend_completed && campaign.stats.failed > 0) {
          try {
            const delayMs = (campaign.auto_resend_delay_hours || 2) * 60 * 60 * 1000;
            const failedPhones = campaign.stats.errors.map((e) => e.phone).filter(Boolean);

            if (failedPhones.length > 0) {
              // Create a retry campaign
              const retryCampaign = await Campaign.create({
                tenant_id: tenantId,
                name: `${campaign.name} (Retry)`,
                template_name: campaign.template_name,
                template_language: campaign.template_language,
                template_components: campaign.template_components,
                variable_mapping: campaign.variable_mapping,
                status: 'scheduled',
                target_type: 'selected',
                recipients: failedPhones,
                scheduled_at: new Date(Date.now() + delayMs),
                send_completion_report: campaign.send_completion_report,
                report_recipients: campaign.report_recipients,
                auto_resend_failed: false, // Don't chain retries
                created_by: campaign.created_by,
              });

              campaign.auto_resend_completed = true;
              await campaign.save();

              // Schedule the retry
              if (campaignQueue && redisAvailable) {
                await campaignQueue.add(
                  'campaign:launch',
                  { campaignId: retryCampaign._id.toString(), tenantId: tenantId.toString() },
                  { delay: delayMs, jobId: `retry-${retryCampaign._id}` }
                );
              }

              console.log(`[CampaignQueue] Scheduled retry campaign ${retryCampaign._id} for ${failedPhones.length} failed contacts in ${campaign.auto_resend_delay_hours}h`);

              await Notification.create({
                tenant_id: tenantId,
                type: 'campaign_retry',
                title: `Auto-retry scheduled for "${campaign.name}"`,
                message: `${failedPhones.length} failed messages will be retried in ${campaign.auto_resend_delay_hours} hour(s).`,
                source: 'platform',
                severity: 'info',
              });
            }
          } catch (retryErr) {
            console.error(`[CampaignQueue] Auto-resend scheduling failed (non-critical):`, retryErr.message);
          }
        }

        emitToTenant(tenantId, 'campaign:progress', {
          campaign_id: campaignId,
          status: 'completed',
          stats: campaign.stats,
        });

        emitToTenant(tenantId, 'notification:new', {
          type: 'campaign_complete',
          title: `Campaign "${campaign.name}" completed`,
        });
      },
      { connection, concurrency: 2 }
    );

    campaignWorker.on('failed', (job, err) => {
      console.error(`[CampaignQueue] Job ${job?.id} failed:`, err.message);
    });

    // Scheduler: check for due scheduled campaigns every 30 seconds
    await campaignQueue.add(
      'check-scheduled',
      {},
      {
        repeat: { every: 30_000 },
        removeOnComplete: true,
        removeOnFail: 5,
      }
    );

    schedulerWorker = new Worker(
      QUEUE_NAME,
      async (job) => {
        if (job.name !== 'check-scheduled') return;

        const Campaign = require('../models/Campaign');
        const now = new Date();
        const dueCampaigns = await Campaign.find({
          status: 'scheduled',
          scheduled_at: { $lte: now },
        });

        for (const campaign of dueCampaigns) {
          campaign.status = 'queued';
          await campaign.save();
          await addCampaignJob(String(campaign._id), String(campaign.tenant_id));
        }
      },
      { connection, concurrency: 1 }
    );

    if (config.verboseLogs) {
      console.log('[CampaignQueue] Campaign queue initialized with Redis');
    }
    return true;
  } catch (err) {
    console.warn('[CampaignQueue] Redis unavailable, falling back to in-process execution:', err.message);
    redisAvailable = false;
    return false;
  }
};

/**
 * Add a campaign launch job to the queue.
 * If Redis is unavailable, returns false (caller should run in-process).
 */
const addCampaignJob = async (campaignId, tenantId, options = {}) => {
  if (!redisAvailable || !campaignQueue) return false;

  await campaignQueue.add(
    'launch',
    { campaignId, tenantId },
    {
      delay: options.delay || 0,
      attempts: 2,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: 50,
      removeOnFail: 20,
    }
  );
  return true;
};

/**
 * Schedule a campaign for a future time.
 */
const scheduleCampaignJob = async (campaignId, tenantId, scheduledAt) => {
  const delay = Math.max(0, new Date(scheduledAt).getTime() - Date.now());
  return addCampaignJob(campaignId, tenantId, { delay });
};

const isRedisAvailable = () => redisAvailable;

const shutdownQueue = async () => {
  if (campaignWorker) await campaignWorker.close();
  if (schedulerWorker) await schedulerWorker.close();
  if (campaignQueue) await campaignQueue.close();
};

module.exports = {
  initializeCampaignQueue,
  addCampaignJob,
  scheduleCampaignJob,
  isRedisAvailable,
  shutdownQueue,
};
