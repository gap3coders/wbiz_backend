/**
 * Campaign Report Service
 *
 * Generates and sends campaign completion reports via email.
 * Includes: HTML report email, CSV of failed messages, error alerts.
 */

const Message = require('../models/Message');
const User = require('../models/User');
const Tenant = require('../models/Tenant');
const Contact = require('../models/Contact');
const { sendEmail } = require('./emailService');
const config = require('../config');

/* ────────────────────────────────────────────────────────
   CSV Generation — Failed messages
   ──────────────────────────────────────────────────────── */

const generateFailedMessagesCsv = async (campaignId) => {
  const failed = await Message.find({
    campaign_id: campaignId,
    status: 'failed',
  })
    .select({ to: 1, error_message: 1, error_source: 1, timestamp: 1 })
    .lean();

  if (failed.length === 0) return null;

  // Fetch contact names for phone numbers
  const phones = [...new Set(failed.map((m) => m.to).filter(Boolean))];
  const contacts = await Contact.find({ phone: { $in: phones } })
    .select({ phone: 1, name: 1, wa_name: 1 })
    .lean();
  const nameMap = {};
  for (const c of contacts) {
    nameMap[c.phone] = c.name || c.wa_name || '';
  }

  const header = 'Phone Number,Contact Name,Error Message,Error Source,Timestamp';
  const rows = failed.map((m) => {
    const phone = (m.to || '').replace(/"/g, '""');
    const name = (nameMap[m.to] || '').replace(/"/g, '""');
    const err = (m.error_message || 'Unknown error').replace(/"/g, '""');
    const src = (m.error_source || '').replace(/"/g, '""');
    const ts = m.timestamp ? new Date(m.timestamp).toISOString() : '';
    return `"${phone}","${name}","${err}","${src}","${ts}"`;
  });

  return `${header}\n${rows.join('\n')}`;
};

/* ────────────────────────────────────────────────────────
   HTML Email Template — Campaign Completion Report
   ──────────────────────────────────────────────────────── */

const buildReportHtml = (campaign, extraData = {}) => {
  const stats = campaign.stats || {};
  const total = stats.total || 0;
  const sent = stats.sent || 0;
  const delivered = stats.delivered || 0;
  const read = stats.read || 0;
  const failed = stats.failed || 0;

  const successRate = total > 0 ? ((sent / total) * 100).toFixed(1) : '0.0';
  const deliveryRate = sent > 0 ? ((delivered / sent) * 100).toFixed(1) : '0.0';
  const readRate = delivered > 0 ? ((read / delivered) * 100).toFixed(1) : '0.0';
  const failRate = total > 0 ? ((failed / total) * 100).toFixed(1) : '0.0';

  const startedAt = campaign.started_at ? new Date(campaign.started_at) : null;
  const completedAt = campaign.completed_at ? new Date(campaign.completed_at) : new Date();
  const duration = startedAt
    ? Math.round((completedAt - startedAt) / 1000)
    : 0;
  const durationStr = duration > 3600
    ? `${Math.floor(duration / 3600)}h ${Math.floor((duration % 3600) / 60)}m`
    : duration > 60
      ? `${Math.floor(duration / 60)}m ${duration % 60}s`
      : `${duration}s`;

  const formatDate = (d) => d ? new Date(d).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '—';

  const dashboardUrl = `${config.frontendUrl || 'https://app.wbiz.in'}/portal/campaigns`;

  const statusColor = campaign.status === 'completed' ? '#059669' : '#dc2626';
  const statusLabel = campaign.status === 'completed' ? 'Completed' : 'Failed';

  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:'Segoe UI',Roboto,sans-serif;">
<div style="max-width:640px;margin:0 auto;padding:32px 16px;">

  <!-- Header -->
  <div style="text-align:center;margin-bottom:24px;">
    <h1 style="color:#075E54;font-size:24px;margin:0;font-weight:700;">WBIZ.IN</h1>
    <p style="color:#6b7280;font-size:13px;margin:4px 0 0;">Campaign Report</p>
  </div>

  <!-- Main Card -->
  <div style="background:#ffffff;border-radius:12px;border:1px solid #e5e7eb;overflow:hidden;">

    <!-- Campaign Name Bar -->
    <div style="background:#075E54;padding:20px 24px;">
      <h2 style="color:#ffffff;font-size:18px;margin:0;font-weight:600;">${escHtml(campaign.name)}</h2>
      <div style="display:flex;gap:16px;margin-top:8px;">
        <span style="color:rgba(255,255,255,0.8);font-size:12px;">Template: ${escHtml(campaign.template_name)}</span>
        <span style="display:inline-block;background:${statusColor};color:#fff;font-size:11px;font-weight:600;padding:2px 8px;border-radius:4px;">${statusLabel}</span>
      </div>
    </div>

    <!-- Stats Grid -->
    <div style="padding:24px;">
      <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
        <tr>
          <td style="width:25%;text-align:center;padding:12px 4px;">
            <div style="font-size:28px;font-weight:700;color:#075E54;">${sent}</div>
            <div style="font-size:11px;color:#6b7280;margin-top:2px;">Sent</div>
            <div style="font-size:10px;color:#9ca3af;">${successRate}%</div>
          </td>
          <td style="width:25%;text-align:center;padding:12px 4px;">
            <div style="font-size:28px;font-weight:700;color:#059669;">${delivered}</div>
            <div style="font-size:11px;color:#6b7280;margin-top:2px;">Delivered</div>
            <div style="font-size:10px;color:#9ca3af;">${deliveryRate}%</div>
          </td>
          <td style="width:25%;text-align:center;padding:12px 4px;">
            <div style="font-size:28px;font-weight:700;color:#2563eb;">${read}</div>
            <div style="font-size:11px;color:#6b7280;margin-top:2px;">Read</div>
            <div style="font-size:10px;color:#9ca3af;">${readRate}%</div>
          </td>
          <td style="width:25%;text-align:center;padding:12px 4px;">
            <div style="font-size:28px;font-weight:700;color:#dc2626;">${failed}</div>
            <div style="font-size:11px;color:#6b7280;margin-top:2px;">Failed</div>
            <div style="font-size:10px;color:#9ca3af;">${failRate}%</div>
          </td>
        </tr>
      </table>
    </div>

    <!-- Divider -->
    <div style="border-top:1px solid #f3f4f6;margin:0 24px;"></div>

    <!-- Details Table -->
    <div style="padding:20px 24px;">
      <h3 style="font-size:13px;font-weight:600;color:#374151;margin:0 0 12px;">Campaign Details</h3>
      <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:13px;">
        <tr>
          <td style="padding:6px 0;color:#6b7280;width:140px;">Total Recipients</td>
          <td style="padding:6px 0;color:#111827;font-weight:500;">${total}</td>
        </tr>
        <tr>
          <td style="padding:6px 0;color:#6b7280;">Started</td>
          <td style="padding:6px 0;color:#111827;">${formatDate(campaign.started_at)}</td>
        </tr>
        <tr>
          <td style="padding:6px 0;color:#6b7280;">Completed</td>
          <td style="padding:6px 0;color:#111827;">${formatDate(campaign.completed_at || new Date())}</td>
        </tr>
        <tr>
          <td style="padding:6px 0;color:#6b7280;">Duration</td>
          <td style="padding:6px 0;color:#111827;">${durationStr}</td>
        </tr>
        <tr>
          <td style="padding:6px 0;color:#6b7280;">Template</td>
          <td style="padding:6px 0;color:#111827;">${escHtml(campaign.template_name)} (${escHtml(campaign.template_language || 'en')})</td>
        </tr>
        ${failed > 0 ? `
        <tr>
          <td style="padding:6px 0;color:#6b7280;">Failed Numbers</td>
          <td style="padding:6px 0;color:#dc2626;font-weight:500;">${failed} contacts — see attached CSV</td>
        </tr>` : ''}
      </table>
    </div>

    ${failed > 0 && stats.errors?.length > 0 ? `
    <!-- Top Errors -->
    <div style="border-top:1px solid #f3f4f6;margin:0 24px;"></div>
    <div style="padding:20px 24px;">
      <h3 style="font-size:13px;font-weight:600;color:#374151;margin:0 0 12px;">Top Error Reasons</h3>
      <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:12px;">
        ${getTopErrors(stats.errors).map(({ error, count }) => `
        <tr>
          <td style="padding:4px 0;color:#dc2626;">${escHtml(error)}</td>
          <td style="padding:4px 0;color:#6b7280;text-align:right;width:60px;">${count}x</td>
        </tr>`).join('')}
      </table>
    </div>` : ''}

    <!-- CTA Button -->
    <div style="padding:8px 24px 24px;text-align:center;">
      <a href="${dashboardUrl}" style="display:inline-block;background:#075E54;color:#ffffff;padding:12px 32px;border-radius:8px;text-decoration:none;font-size:14px;font-weight:600;">
        View Full Report in Dashboard
      </a>
    </div>
  </div>

  <!-- Footer -->
  <div style="text-align:center;padding:24px 0 0;">
    <p style="color:#9ca3af;font-size:11px;margin:0;">
      This is an automated report from WBIZ.IN — your WhatsApp Business platform.
    </p>
  </div>
</div>
</body>
</html>`;
};

/* ────────────────────────────────────────────────────────
   HTML Email — Campaign Error Alert
   ──────────────────────────────────────────────────────── */

const buildErrorAlertHtml = (campaign, errorDetails) => {
  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:'Segoe UI',Roboto,sans-serif;">
<div style="max-width:640px;margin:0 auto;padding:32px 16px;">
  <div style="text-align:center;margin-bottom:24px;">
    <h1 style="color:#075E54;font-size:24px;margin:0;">WBIZ.IN</h1>
  </div>
  <div style="background:#ffffff;border-radius:12px;border:1px solid #fca5a5;overflow:hidden;">
    <div style="background:#dc2626;padding:16px 24px;">
      <h2 style="color:#ffffff;font-size:16px;margin:0;">Campaign Alert: Critical Error</h2>
    </div>
    <div style="padding:24px;">
      <p style="font-size:14px;color:#374151;margin:0 0 16px;">
        Campaign <strong>"${escHtml(campaign.name)}"</strong> encountered a critical error during execution.
      </p>
      <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:16px;margin-bottom:16px;">
        <p style="font-size:13px;color:#991b1b;margin:0 0 8px;font-weight:600;">Error Details:</p>
        <p style="font-size:13px;color:#dc2626;margin:0;font-family:monospace;word-break:break-all;">${escHtml(errorDetails.message || 'Unknown error')}</p>
        ${errorDetails.impacted_count ? `<p style="font-size:12px;color:#6b7280;margin:8px 0 0;">Impacted contacts: ${errorDetails.impacted_count}</p>` : ''}
      </div>
      <table width="100%" cellpadding="0" cellspacing="0" style="font-size:13px;border-collapse:collapse;">
        <tr><td style="padding:4px 0;color:#6b7280;">Campaign</td><td style="padding:4px 0;color:#111827;">${escHtml(campaign.name)}</td></tr>
        <tr><td style="padding:4px 0;color:#6b7280;">Template</td><td style="padding:4px 0;color:#111827;">${escHtml(campaign.template_name)}</td></tr>
        <tr><td style="padding:4px 0;color:#6b7280;">Time</td><td style="padding:4px 0;color:#111827;">${new Date().toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}</td></tr>
        ${errorDetails.error_code ? `<tr><td style="padding:4px 0;color:#6b7280;">Error Code</td><td style="padding:4px 0;color:#dc2626;">${escHtml(errorDetails.error_code)}</td></tr>` : ''}
      </table>
      <div style="text-align:center;margin-top:20px;">
        <a href="${config.frontendUrl || 'https://app.wbiz.in'}/portal/campaigns" style="display:inline-block;background:#dc2626;color:#ffffff;padding:10px 28px;border-radius:8px;text-decoration:none;font-size:13px;font-weight:600;">
          View Campaign
        </a>
      </div>
    </div>
  </div>
</div>
</body>
</html>`;
};

/* ────────────────────────────────────────────────────────
   Helpers
   ──────────────────────────────────────────────────────── */

const escHtml = (str) => String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const getTopErrors = (errors, limit = 5) => {
  const counts = {};
  for (const e of errors) {
    const key = e.error || 'Unknown';
    counts[key] = (counts[key] || 0) + 1;
  }
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([error, count]) => ({ error, count }));
};

/* ────────────────────────────────────────────────────────
   Main Functions
   ──────────────────────────────────────────────────────── */

/**
 * Send campaign completion report email.
 * Called after campaign.status is set to 'completed' or 'failed'.
 */
const sendCampaignCompletionReport = async (campaign) => {
  try {
    if (!campaign.send_completion_report) {
      console.log(`[CampaignReport] Skipping report for "${campaign.name}" — send_completion_report is off`);
      return null;
    }

    // Get tenant owner email
    const tenant = await Tenant.findById(campaign.tenant_id).lean();
    if (!tenant) {
      console.warn(`[CampaignReport] Tenant not found for campaign ${campaign._id}`);
      return null;
    }

    const owner = await User.findOne({ tenant_id: tenant._id, role: 'owner' })
      .select({ email: 1, full_name: 1 })
      .lean();

    if (!owner?.email) {
      console.warn(`[CampaignReport] No owner email for tenant ${tenant._id}`);
      return null;
    }

    // Build recipient list
    const recipients = new Set([owner.email]);
    if (Array.isArray(campaign.report_recipients)) {
      for (const email of campaign.report_recipients) {
        if (email && email.includes('@')) recipients.add(email.trim().toLowerCase());
      }
    }

    // Build HTML report
    const html = buildReportHtml(campaign);

    // Generate failed CSV if any failures
    let csvContent = null;
    if ((campaign.stats?.failed || 0) > 0) {
      csvContent = await generateFailedMessagesCsv(campaign._id);
    }

    // Build subject
    const stats = campaign.stats || {};
    const statusEmoji = campaign.status === 'completed' ? '✅' : '❌';
    const subject = `${statusEmoji} Campaign Report: ${campaign.name} — ${stats.sent || 0} sent, ${stats.failed || 0} failed`;

    // Send email with or without CSV attachment
    const mailOptions = {
      to: [...recipients].join(', '),
      subject,
      html,
    };

    if (csvContent) {
      // Add CSV as attachment via nodemailer
      const nodemailer = require('nodemailer');
      const { sendEmail: baseSend, ...rest } = require('./emailService');
      // Use the base sendEmail but we need to add attachment — use the raw transporter approach
      const emailConfig = require('../config');
      const transporter = nodemailer.createTransport({
        host: emailConfig.smtp.host,
        port: emailConfig.smtp.port,
        secure: emailConfig.smtp.secure,
        auth: { user: emailConfig.smtp.user, pass: emailConfig.smtp.pass },
      });

      await transporter.sendMail({
        from: `"${emailConfig.smtp.fromName}" <${emailConfig.smtp.fromEmail}>`,
        to: mailOptions.to,
        subject: mailOptions.subject,
        html: mailOptions.html,
        attachments: [
          {
            filename: `campaign-failed-${campaign.name.replace(/[^a-zA-Z0-9]/g, '_')}.csv`,
            content: csvContent,
            contentType: 'text/csv',
          },
        ],
      });
    } else {
      await sendEmail(mailOptions);
    }

    console.log(`[CampaignReport] Report sent for "${campaign.name}" to ${[...recipients].join(', ')}`);
    return { sent_to: [...recipients], has_csv: !!csvContent };
  } catch (error) {
    console.error(`[CampaignReport] Failed to send report for "${campaign.name}":`, error.message);
    return null;
  }
};

/**
 * Send immediate error alert email when a campaign encounters critical issues.
 */
const sendCampaignErrorAlert = async (campaign, errorDetails) => {
  try {
    const tenant = await Tenant.findById(campaign.tenant_id).lean();
    if (!tenant) return null;

    const owner = await User.findOne({ tenant_id: tenant._id, role: 'owner' })
      .select({ email: 1 })
      .lean();

    if (!owner?.email) return null;

    const html = buildErrorAlertHtml(campaign, errorDetails);

    await sendEmail({
      to: owner.email,
      subject: `🚨 Campaign Alert: "${campaign.name}" — Critical Error`,
      html,
    });

    console.log(`[CampaignReport] Error alert sent for "${campaign.name}" to ${owner.email}`);
    return { sent_to: owner.email };
  } catch (error) {
    console.error(`[CampaignReport] Failed to send error alert:`, error.message);
    return null;
  }
};

module.exports = {
  sendCampaignCompletionReport,
  sendCampaignErrorAlert,
  generateFailedMessagesCsv,
  buildReportHtml,
};
