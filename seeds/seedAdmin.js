/**
 * Seed default admin user and plans + email templates.
 * Run once on bootstrap — skips if admin already exists.
 */
const AdminUser = require('../models/AdminUser');
const Plan = require('../models/Plan');
const EmailTemplate = require('../models/EmailTemplate');
const SystemConfig = require('../models/SystemConfig');

const DEFAULT_ADMIN = {
  email: 'admin@wbiz.in',
  password_hash: 'Admin@123',  // will be hashed by pre-save hook
  full_name: 'Super Admin',
  role: 'super_admin',
  status: 'active',
};

const DEFAULT_PLANS = [
  {
    slug: 'starter', name: 'Starter', description: 'Perfect for small businesses getting started with WhatsApp marketing.',
    price_monthly: 999, price_yearly: 9990, currency: 'INR',
    message_limit: 1000, seats_limit: 2, campaign_limit_monthly: 5, template_limit: 10,
    media_storage_mb: 250, auto_response_limit: 5, contact_limit: 1000, trial_days: 14, sort_order: 0,
    features: ['1,000 Messages/mo', '2 Team Seats', '5 Campaigns/mo', 'Basic Analytics', 'Auto Responses (5)', 'Quick Replies'],
  },
  {
    slug: 'pro', name: 'Professional', description: 'Advanced features for growing businesses with higher volume.',
    price_monthly: 2999, price_yearly: 29990, currency: 'INR',
    message_limit: 10000, seats_limit: 10, campaign_limit_monthly: 50, template_limit: 50,
    media_storage_mb: 2000, auto_response_limit: 50, contact_limit: 25000, trial_days: 14, sort_order: 1, is_popular: true,
    features: ['10,000 Messages/mo', '10 Team Seats', '50 Campaigns/mo', 'Advanced Analytics', 'Unlimited Auto Responses', 'Quick Replies', 'Contact Lists', 'Priority Support'],
  },
  {
    slug: 'enterprise', name: 'Enterprise', description: 'Unlimited scale for large businesses and agencies.',
    price_monthly: 9999, price_yearly: 99990, currency: 'INR',
    message_limit: 100000, seats_limit: 50, campaign_limit_monthly: 500, template_limit: 200,
    media_storage_mb: 10000, auto_response_limit: 500, contact_limit: 500000, trial_days: 30, sort_order: 2,
    features: ['100,000 Messages/mo', '50 Team Seats', 'Unlimited Campaigns', 'Custom Analytics & Reports', 'Unlimited Auto Responses', 'API Access', 'Dedicated Account Manager', 'White-label Options', 'SLA Guarantee'],
  },
];

const DEFAULT_EMAIL_TEMPLATES = [
  {
    slug: 'welcome-verification',
    name: 'Welcome - Email Verification',
    subject: 'Verify your email - WBIZ.IN',
    category: 'auth',
    description: 'Sent when a new user registers. Contains email verification link.',
    variables: ['user_name', 'verify_url', 'company_name'],
    html_body: `<div style="font-family:'Segoe UI',sans-serif;max-width:600px;margin:0 auto;padding:40px 20px;"><div style="text-align:center;margin-bottom:32px;"><h1 style="color:#075E54;font-size:28px;margin:0;">WBIZ.IN</h1></div><div style="background:#fff;border-radius:12px;padding:40px;border:1px solid #e5e7eb;"><h2 style="color:#1a1a1a;font-size:22px;margin:0 0 16px;">Welcome, {{user_name}}!</h2><p style="color:#6b7280;font-size:16px;line-height:1.6;margin:0 0 24px;">Thanks for signing up. Please verify your email address to get started with your WhatsApp Business platform.</p><div style="text-align:center;margin:32px 0;"><a href="{{verify_url}}" style="background:#075E54;color:#fff;padding:14px 40px;border-radius:8px;text-decoration:none;font-size:16px;font-weight:600;display:inline-block;">Verify Email Address</a></div><p style="color:#9ca3af;font-size:13px;margin:24px 0 0;text-align:center;">This link expires in 1 hour. If you didn't create an account, you can safely ignore this email.</p></div></div>`,
  },
  {
    slug: 'password-reset',
    name: 'Password Reset',
    subject: 'Reset your password - WBIZ.IN',
    category: 'auth',
    description: 'Sent when a user requests a password reset.',
    variables: ['user_name', 'reset_url'],
    html_body: `<div style="font-family:'Segoe UI',sans-serif;max-width:600px;margin:0 auto;padding:40px 20px;"><div style="text-align:center;margin-bottom:32px;"><h1 style="color:#075E54;font-size:28px;margin:0;">WBIZ.IN</h1></div><div style="background:#fff;border-radius:12px;padding:40px;border:1px solid #e5e7eb;"><h2 style="color:#1a1a1a;font-size:22px;margin:0 0 16px;">Password Reset Request</h2><p style="color:#6b7280;font-size:16px;line-height:1.6;margin:0 0 24px;">Hi {{user_name}}, we received a request to reset your password. Click the button below to choose a new password.</p><div style="text-align:center;margin:32px 0;"><a href="{{reset_url}}" style="background:#075E54;color:#fff;padding:14px 40px;border-radius:8px;text-decoration:none;font-size:16px;font-weight:600;display:inline-block;">Reset Password</a></div><p style="color:#9ca3af;font-size:13px;margin:24px 0 0;text-align:center;">This link expires in 1 hour. If you didn't request this, you can safely ignore this email.</p></div></div>`,
  },
  {
    slug: 'otp-verification',
    name: 'OTP Verification',
    subject: 'Your verification code - WBIZ.IN',
    category: 'auth',
    description: 'Sent for two-factor or login OTP verification.',
    variables: ['user_name', 'otp_code', 'expiry_minutes'],
    html_body: `<div style="font-family:'Segoe UI',sans-serif;max-width:600px;margin:0 auto;padding:40px 20px;"><div style="text-align:center;margin-bottom:32px;"><h1 style="color:#075E54;font-size:28px;margin:0;">WBIZ.IN</h1></div><div style="background:#fff;border-radius:12px;padding:40px;border:1px solid #e5e7eb;"><h2 style="color:#1a1a1a;font-size:22px;margin:0 0 16px;">Your Verification Code</h2><p style="color:#6b7280;font-size:16px;line-height:1.6;margin:0 0 24px;">Hi {{user_name}}, use the code below to verify your identity.</p><div style="text-align:center;margin:32px 0;"><div style="display:inline-block;background:#f3f4f6;border-radius:12px;padding:20px 48px;font-size:36px;letter-spacing:8px;font-weight:800;color:#1a1a1a;">{{otp_code}}</div></div><p style="color:#9ca3af;font-size:13px;margin:24px 0 0;text-align:center;">This code expires in {{expiry_minutes}} minutes.</p></div></div>`,
  },
  {
    slug: 'new-message-notification',
    name: 'New Message Notification',
    subject: 'New WhatsApp message from {{contact_name}} - WBIZ.IN',
    category: 'notification',
    description: 'Sent when a new inbound WhatsApp message is received (if email notifications enabled).',
    variables: ['user_name', 'contact_name', 'contact_phone', 'message_preview', 'inbox_url'],
    html_body: `<div style="font-family:'Segoe UI',sans-serif;max-width:600px;margin:0 auto;padding:40px 20px;"><div style="text-align:center;margin-bottom:32px;"><h1 style="color:#075E54;font-size:28px;margin:0;">WBIZ.IN</h1></div><div style="background:#fff;border-radius:12px;padding:40px;border:1px solid #e5e7eb;"><h2 style="color:#1a1a1a;font-size:18px;margin:0 0 16px;">New message from {{contact_name}}</h2><div style="background:#f9fafb;border-radius:8px;padding:16px;margin:0 0 24px;border-left:4px solid #25D366;"><p style="color:#374151;font-size:14px;line-height:1.6;margin:0;">{{message_preview}}</p><p style="color:#9ca3af;font-size:12px;margin:8px 0 0;">From: +{{contact_phone}}</p></div><div style="text-align:center;"><a href="{{inbox_url}}" style="background:#075E54;color:#fff;padding:12px 32px;border-radius:8px;text-decoration:none;font-size:14px;font-weight:600;display:inline-block;">Reply in Inbox</a></div></div></div>`,
  },
  {
    slug: 'campaign-complete',
    name: 'Campaign Completed',
    subject: 'Campaign "{{campaign_name}}" completed - WBIZ.IN',
    category: 'notification',
    description: 'Sent when a bulk campaign finishes sending.',
    variables: ['user_name', 'campaign_name', 'total_sent', 'total_delivered', 'total_failed', 'dashboard_url'],
    html_body: `<div style="font-family:'Segoe UI',sans-serif;max-width:600px;margin:0 auto;padding:40px 20px;"><div style="text-align:center;margin-bottom:32px;"><h1 style="color:#075E54;font-size:28px;margin:0;">WBIZ.IN</h1></div><div style="background:#fff;border-radius:12px;padding:40px;border:1px solid #e5e7eb;"><h2 style="color:#1a1a1a;font-size:18px;margin:0 0 16px;">Campaign Completed</h2><p style="color:#6b7280;font-size:14px;margin:0 0 20px;">Hi {{user_name}}, your campaign <strong>{{campaign_name}}</strong> has finished.</p><table style="width:100%;border-collapse:collapse;margin:0 0 24px;"><tr><td style="padding:12px;background:#f0fdf4;border-radius:8px 0 0 0;text-align:center;"><p style="color:#16a34a;font-size:20px;font-weight:800;margin:0;">{{total_sent}}</p><p style="color:#6b7280;font-size:11px;margin:4px 0 0;">Sent</p></td><td style="padding:12px;background:#eff6ff;text-align:center;"><p style="color:#2563eb;font-size:20px;font-weight:800;margin:0;">{{total_delivered}}</p><p style="color:#6b7280;font-size:11px;margin:4px 0 0;">Delivered</p></td><td style="padding:12px;background:#fef2f2;border-radius:0 8px 0 0;text-align:center;"><p style="color:#dc2626;font-size:20px;font-weight:800;margin:0;">{{total_failed}}</p><p style="color:#6b7280;font-size:11px;margin:4px 0 0;">Failed</p></td></tr></table><div style="text-align:center;"><a href="{{dashboard_url}}" style="background:#075E54;color:#fff;padding:12px 32px;border-radius:8px;text-decoration:none;font-size:14px;font-weight:600;display:inline-block;">View Dashboard</a></div></div></div>`,
  },
  {
    slug: 'account-suspended',
    name: 'Account Suspended',
    subject: 'Your WBIZ.IN account has been suspended',
    category: 'system',
    description: 'Sent when an admin suspends a tenant account.',
    variables: ['user_name', 'reason', 'support_email'],
    html_body: `<div style="font-family:'Segoe UI',sans-serif;max-width:600px;margin:0 auto;padding:40px 20px;"><div style="text-align:center;margin-bottom:32px;"><h1 style="color:#075E54;font-size:28px;margin:0;">WBIZ.IN</h1></div><div style="background:#fff;border-radius:12px;padding:40px;border:1px solid #e5e7eb;"><h2 style="color:#dc2626;font-size:18px;margin:0 0 16px;">Account Suspended</h2><p style="color:#6b7280;font-size:14px;line-height:1.6;margin:0 0 16px;">Hi {{user_name}}, your WBIZ.IN account has been suspended.</p><div style="background:#fef2f2;border-radius:8px;padding:16px;margin:0 0 24px;border-left:4px solid #dc2626;"><p style="color:#991b1b;font-size:14px;margin:0;"><strong>Reason:</strong> {{reason}}</p></div><p style="color:#6b7280;font-size:14px;margin:0;">If you believe this is an error, please contact us at <a href="mailto:{{support_email}}" style="color:#075E54;font-weight:600;">{{support_email}}</a>.</p></div></div>`,
  },
  {
    slug: 'trial-expiring',
    name: 'Trial Expiring Soon',
    subject: 'Your WBIZ.IN trial expires in {{days_left}} days',
    category: 'transactional',
    description: 'Sent when a tenant trial is about to expire.',
    variables: ['user_name', 'days_left', 'plan_name', 'upgrade_url'],
    html_body: `<div style="font-family:'Segoe UI',sans-serif;max-width:600px;margin:0 auto;padding:40px 20px;"><div style="text-align:center;margin-bottom:32px;"><h1 style="color:#075E54;font-size:28px;margin:0;">WBIZ.IN</h1></div><div style="background:#fff;border-radius:12px;padding:40px;border:1px solid #e5e7eb;"><h2 style="color:#1a1a1a;font-size:18px;margin:0 0 16px;">Your trial expires in {{days_left}} days</h2><p style="color:#6b7280;font-size:14px;line-height:1.6;margin:0 0 24px;">Hi {{user_name}}, your free trial of the <strong>{{plan_name}}</strong> plan is ending soon. Upgrade now to keep all your features.</p><div style="text-align:center;margin:32px 0;"><a href="{{upgrade_url}}" style="background:#075E54;color:#fff;padding:14px 40px;border-radius:8px;text-decoration:none;font-size:16px;font-weight:600;display:inline-block;">Upgrade Now</a></div></div></div>`,
  },
  {
    slug: 'team-invite',
    name: 'Team Invitation',
    subject: 'You\'re invited to join {{company_name}} on WBIZ.IN',
    category: 'auth',
    description: 'Sent when a team member is invited to join a tenant workspace.',
    variables: ['inviter_name', 'company_name', 'role', 'invite_url'],
    html_body: `<div style="font-family:'Segoe UI',sans-serif;max-width:600px;margin:0 auto;padding:40px 20px;"><div style="text-align:center;margin-bottom:32px;"><h1 style="color:#075E54;font-size:28px;margin:0;">WBIZ.IN</h1></div><div style="background:#fff;border-radius:12px;padding:40px;border:1px solid #e5e7eb;"><h2 style="color:#1a1a1a;font-size:18px;margin:0 0 16px;">You're Invited!</h2><p style="color:#6b7280;font-size:14px;line-height:1.6;margin:0 0 24px;">{{inviter_name}} has invited you to join <strong>{{company_name}}</strong> as a <strong>{{role}}</strong> on WBIZ.IN WhatsApp Business Platform.</p><div style="text-align:center;margin:32px 0;"><a href="{{invite_url}}" style="background:#075E54;color:#fff;padding:14px 40px;border-radius:8px;text-decoration:none;font-size:16px;font-weight:600;display:inline-block;">Accept Invitation</a></div><p style="color:#9ca3af;font-size:13px;margin:24px 0 0;text-align:center;">This invitation expires in 7 days.</p></div></div>`,
  },
];

async function seedAdmin() {
  try {
    // Seed default admin
    const existing = await AdminUser.findOne({ email: DEFAULT_ADMIN.email });
    if (!existing) {
      await AdminUser.create(DEFAULT_ADMIN);
      console.info('[Seed] Default admin created: admin@wbiz.in / Admin@123');
    }

    // Seed default plans
    for (const plan of DEFAULT_PLANS) {
      await Plan.findOneAndUpdate({ slug: plan.slug }, plan, { upsert: true, new: true });
    }
    console.info(`[Seed] ${DEFAULT_PLANS.length} plans seeded`);

    // Seed default email templates
    for (const tpl of DEFAULT_EMAIL_TEMPLATES) {
      await EmailTemplate.findOneAndUpdate({ slug: tpl.slug }, { $setOnInsert: tpl }, { upsert: true });
    }
    console.info(`[Seed] ${DEFAULT_EMAIL_TEMPLATES.length} email templates seeded`);

    // Seed default system config
    const configDefaults = [
      { key: 'razorpay_key_id', value: '', description: 'Razorpay Key ID', is_secret: false },
      { key: 'razorpay_key_secret', value: '', description: 'Razorpay Key Secret', is_secret: true },
      { key: 'razorpay_mode', value: 'test', description: 'Razorpay mode (test/live)', is_secret: false },
      { key: 'trial_days', value: 7, description: 'Default trial period in days', is_secret: false },
      { key: 'require_admin_approval', value: true, description: 'Require admin approval for new registrations', is_secret: false },
    ];
    for (const cfg of configDefaults) {
      const existing = await SystemConfig.findOne({ key: cfg.key });
      if (!existing) {
        await SystemConfig.create(cfg);
        console.log(`[Seed] Config: ${cfg.key}`);
      }
    }
  } catch (error) {
    console.error('[Seed] Error:', error.message);
  }
}

module.exports = seedAdmin;
