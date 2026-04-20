/**
 * Date Trigger Execution Service — BullMQ
 *
 * Runs a repeating job that checks all active date triggers.
 * For each trigger, finds matching contacts and sends template messages.
 *
 * Jobs:
 *   - dateTrigger:check  → Repeating job (every 60s) to find & execute due triggers
 *   - dateTrigger:execute → Individual trigger execution
 */

let Queue, Worker;
try {
  ({ Queue, Worker } = require('bullmq'));
} catch {
  Queue = null;
  Worker = null;
}

const config = require('../config');

const QUEUE_NAME = 'date-triggers';
let triggerQueue = null;
let checkerWorker = null;
let executorWorker = null;
let redisAvailable = false;

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
 * Initialize the date trigger queue and workers.
 */
const initializeDateTriggerQueue = async () => {
  if (!Queue || !Worker) {
    console.log('[DateTriggerService] BullMQ not installed; date trigger queue disabled');
    return false;
  }

  const connection = getRedisConnection();

  try {
    triggerQueue = new Queue(QUEUE_NAME, { connection });
    await triggerQueue.waitUntilReady();
    redisAvailable = true;

    // ── Checker Worker: runs every 60 seconds ──────────────────
    // Finds triggers that are due and adds execution jobs
    await triggerQueue.add(
      'check-triggers',
      {},
      {
        repeat: { every: 60_000 },
        removeOnComplete: true,
        removeOnFail: 5,
      }
    );

    checkerWorker = new Worker(
      QUEUE_NAME,
      async (job) => {
        if (job.name !== 'check-triggers') return;

        const DateTrigger = require('../models/DateTrigger');
        const now = new Date();

        // Find active triggers whose next_run_at has passed
        const dueTriggers = await DateTrigger.find({
          active: true,
          next_run_at: { $lte: now },
        }).lean();

        for (const trigger of dueTriggers) {
          // Add an execution job for each due trigger
          await triggerQueue.add(
            'execute-trigger',
            {
              triggerId: String(trigger._id),
              tenantId: String(trigger.tenant_id),
            },
            {
              jobId: `trigger-${trigger._id}-${now.toISOString().slice(0, 10)}`,
              attempts: 2,
              backoff: { type: 'exponential', delay: 10000 },
              removeOnComplete: 50,
              removeOnFail: 20,
            }
          );
        }
      },
      { connection, concurrency: 1 }
    );

    // ── Executor Worker: processes individual trigger executions ──
    executorWorker = new Worker(
      QUEUE_NAME,
      async (job) => {
        if (job.name !== 'execute-trigger') return;
        await executeTrigger(job.data.triggerId, job.data.tenantId);
      },
      { connection, concurrency: 3 }
    );

    executorWorker.on('failed', (job, err) => {
      console.error(`[DateTriggerService] Job ${job?.id} failed:`, err.message);
    });

    if (config.verboseLogs) {
      console.log('[DateTriggerService] Date trigger queue initialized with Redis');
    }
    return true;
  } catch (err) {
    console.warn('[DateTriggerService] Redis unavailable, date triggers will use fallback:', err.message);
    redisAvailable = false;
    return false;
  }
};

/**
 * Execute a single date trigger — find matching contacts and send templates.
 */
const executeTrigger = async (triggerId, tenantId) => {
  const startTime = Date.now();
  const DateTrigger = require('../models/DateTrigger');
  const DateTriggerLog = require('../models/DateTriggerLog');
  const Message = require('../models/Message');
  const Notification = require('../models/Notification');
  const WhatsAppAccount = require('../models/WhatsAppAccount');
  const { decrypt } = require('./encryptionService');
  const metaService = require('./metaService');
  const { emitToTenant } = require('./socketService');
  const { findMatchingContacts, getContactDateValue, computeNextRunAt } = require('../routes/dateTriggers');

  const trigger = await DateTrigger.findById(triggerId);
  if (!trigger || !trigger.active) return;

  const wa = await WhatsAppAccount.findOne({ tenant_id: tenantId, is_default: true })
    || await WhatsAppAccount.findOne({ tenant_id: tenantId });
  if (!wa) {
    console.error(`[DateTriggerService] No WhatsApp account for tenant ${tenantId}`);
    await DateTriggerLog.create({
      tenant_id: tenantId,
      trigger_id: triggerId,
      trigger_name: trigger.name,
      run_date: new Date(),
      status: 'failed',
      error_details: [{ phone: '-', error: 'No WhatsApp account connected' }],
      duration_ms: Date.now() - startTime,
    });
    trigger.stats.last_error = 'No WhatsApp account connected';
    trigger.last_run_at = new Date();
    trigger.next_run_at = computeNextRunAt(trigger);
    await trigger.save();
    return;
  }

  const accessToken = decrypt(wa.access_token_encrypted);
  const phoneNumberId = wa.phone_number_id;

  // Calculate target date (today + offset reversal)
  const now = new Date();
  const targetDate = new Date(now);
  // If offset_days is -1 (day before), we look for contacts whose date is tomorrow
  // If offset_days is +7 (week after), we look for contacts whose date was 7 days ago
  targetDate.setDate(targetDate.getDate() - (trigger.offset_days || 0));
  const targetMonth = targetDate.getMonth() + 1;
  const targetDay = targetDate.getDate();

  let matched = [];
  try {
    matched = await findMatchingContacts(trigger, targetMonth, targetDay);
  } catch (err) {
    console.error(`[DateTriggerService] Failed to find matching contacts for trigger ${triggerId}:`, err.message);
  }

  const log = {
    tenant_id: tenantId,
    trigger_id: triggerId,
    trigger_name: trigger.name,
    run_date: new Date(),
    matched_contacts: matched.length,
    sent: 0,
    failed: 0,
    error_details: [],
  };

  if (matched.length === 0) {
    log.status = 'no_match';
    log.duration_ms = Date.now() - startTime;
    await DateTriggerLog.create(log);
    trigger.stats.total_runs += 1;
    trigger.stats.last_run_matched = 0;
    trigger.stats.last_run_sent = 0;
    trigger.stats.last_run_failed = 0;
    trigger.last_run_at = new Date();
    trigger.next_run_at = computeNextRunAt(trigger);
    await trigger.save();
    return;
  }

  // Build template components from variable_mapping
  const buildComponents = (contact) => {
    if (!trigger.variable_mapping?.length) return [];
    const bodyParams = [];
    for (const mapping of trigger.variable_mapping) {
      let value = '';
      switch (mapping.source) {
        case 'static':
          value = mapping.static_value || '';
          break;
        case 'contact_name':
          value = contact.name || contact.wa_name || 'Customer';
          break;
        case 'contact_phone':
          value = contact.phone || '';
          break;
        case 'contact_email':
          value = contact.email || '';
          break;
        case 'contact_field':
        case 'custom_field':
          value = String(getContactDateValue(contact, mapping.field_path) || '');
          break;
        default:
          value = mapping.static_value || '';
      }
      bodyParams.push({ type: 'text', text: value || '-' });
    }

    const components = [];
    if (bodyParams.length > 0) {
      components.push({ type: 'body', parameters: bodyParams });
    }

    // Header media if configured
    if (trigger.template_header_type !== 'none' && trigger.template_header_media_url) {
      const headerParam = { type: trigger.template_header_type };
      headerParam[trigger.template_header_type] = { link: trigger.template_header_media_url };
      components.push({ type: 'header', parameters: [headerParam] });
    }

    return components;
  };

  // Send messages to all matched contacts
  for (let i = 0; i < matched.length; i++) {
    const contact = matched[i];
    try {
      const components = buildComponents(contact);
      const result = await metaService.sendTemplateMessage(
        phoneNumberId,
        accessToken,
        contact.phone,
        trigger.template_name,
        trigger.template_language || 'en',
        components
      );

      log.sent += 1;

      // Create message record
      await Message.create({
        tenant_id: tenantId,
        wa_message_id: result?.messages?.[0]?.id || null,
        contact_phone: contact.phone,
        direction: 'outbound',
        type: 'template',
        status: 'accepted',
        timestamp: new Date(),
        metadata: { date_trigger_id: triggerId, date_trigger_name: trigger.name },
      });
    } catch (err) {
      log.failed += 1;
      log.error_details.push({ phone: contact.phone, error: err.message });
    }

    // Rate limit: 150ms between sends
    if (i < matched.length - 1) {
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  // Determine log status
  log.status = log.failed === 0 ? 'success' : log.sent === 0 ? 'failed' : 'partial';
  log.duration_ms = Date.now() - startTime;

  await DateTriggerLog.create(log);

  // Update trigger stats
  trigger.stats.total_runs += 1;
  trigger.stats.total_sent += log.sent;
  trigger.stats.total_failed += log.failed;
  trigger.stats.last_run_matched = matched.length;
  trigger.stats.last_run_sent = log.sent;
  trigger.stats.last_run_failed = log.failed;
  trigger.stats.last_error = log.error_details.length > 0 ? log.error_details[0].error : '';
  trigger.last_run_at = new Date();

  // For one_time triggers, deactivate after execution
  if (trigger.trigger_type === 'one_time') {
    trigger.active = false;
    trigger.next_run_at = null;
  } else {
    trigger.next_run_at = computeNextRunAt(trigger);
  }
  await trigger.save();

  // Create notification
  const severity = log.failed > 0 ? 'warning' : 'success';
  await Notification.create({
    tenant_id: tenantId,
    type: 'date_trigger_complete',
    title: `Date Trigger "${trigger.name}" executed`,
    message: `Matched ${matched.length} contacts. Sent: ${log.sent}, Failed: ${log.failed}`,
    source: 'platform',
    severity,
  }).catch(() => {});

  emitToTenant(tenantId, 'notification:new', {
    type: 'date_trigger_complete',
    title: `Date Trigger "${trigger.name}" executed`,
  });

  if (config.verboseLogs) {
    console.log(`[DateTriggerService] Trigger "${trigger.name}" executed: ${log.sent} sent, ${log.failed} failed`);
  }
};

/**
 * Fallback: run all due triggers in-process (no Redis).
 * Can be called from a setInterval in server.js.
 */
const checkAndExecuteTriggersFallback = async () => {
  const DateTrigger = require('../models/DateTrigger');
  const now = new Date();

  const dueTriggers = await DateTrigger.find({
    active: true,
    next_run_at: { $lte: now },
  }).lean();

  for (const trigger of dueTriggers) {
    try {
      await executeTrigger(String(trigger._id), String(trigger.tenant_id));
    } catch (err) {
      console.error(`[DateTriggerService] Fallback execution failed for ${trigger._id}:`, err.message);
    }
  }
};

const isRedisAvailable = () => redisAvailable;

const shutdownQueue = async () => {
  if (checkerWorker) await checkerWorker.close();
  if (executorWorker) await executorWorker.close();
  if (triggerQueue) await triggerQueue.close();
};

module.exports = {
  initializeDateTriggerQueue,
  executeTrigger,
  checkAndExecuteTriggersFallback,
  isRedisAvailable,
  shutdownQueue,
};
