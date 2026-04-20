const express = require('express');
const { apiResponse } = require('../utils/helpers');
const { authenticate } = require('../middleware/auth');
const Plan = require('../models/Plan');
const Tenant = require('../models/Tenant');
const Subscription = require('../models/Subscription');
const SystemConfig = require('../models/SystemConfig');
const router = express.Router();

// GET /plans — public endpoint, no auth needed
router.get('/plans', async (req, res) => {
  try {
    const plans = await Plan.find({ is_active: true }).sort({ sort_order: 1 }).lean();
    return apiResponse(res, { data: { plans } });
  } catch (error) {
    return apiResponse(res, { status: 500, success: false, error: 'Failed to fetch plans' });
  }
});

// POST /start-trial — start 7-day free trial
router.post('/start-trial', authenticate, async (req, res) => {
  try {
    const { plan_slug } = req.body;
    const tenant = await Tenant.findById(req.user.tenant_id);
    if (!tenant) return apiResponse(res, { status: 404, success: false, error: 'Tenant not found' });

    // Check if trial already used
    if (tenant.trial_used) {
      return apiResponse(res, { status: 400, success: false, error: 'Free trial has already been used for this account' });
    }

    const trialDays = await SystemConfig.getValue('trial_days', 7);
    const plan = await Plan.findOne({ slug: plan_slug || 'starter', is_active: true });
    if (!plan) return apiResponse(res, { status: 400, success: false, error: 'Invalid plan' });

    const trialEnds = new Date(Date.now() + trialDays * 24 * 60 * 60 * 1000);

    await Tenant.findByIdAndUpdate(tenant._id, {
      plan: plan.slug,
      plan_status: 'trial',
      trial_ends_at: trialEnds,
      trial_used: true,
      message_limit_monthly: plan.message_limit,
      seats_limit: plan.seats_limit,
      setup_status: 'pending_setup',
    });

    // Update user status for first-time onboarding
    const User = require('../models/User');
    if (req.user.status === 'pending_plan') {
      await User.findByIdAndUpdate(req.user._id, { status: 'pending_setup' });
    }

    return apiResponse(res, { data: { message: 'Trial started', trial_ends_at: trialEnds, redirect_to: '/portal/setup' } });
  } catch (error) {
    console.error('[Billing][StartTrial]', error.message);
    return apiResponse(res, { status: 500, success: false, error: 'Failed to start trial' });
  }
});

// POST /create-order — create Razorpay order for plan purchase
router.post('/create-order', authenticate, async (req, res) => {
  try {
    const { plan_slug, billing_cycle = 'monthly' } = req.body;
    const plan = await Plan.findOne({ slug: plan_slug, is_active: true });
    if (!plan) return apiResponse(res, { status: 400, success: false, error: 'Invalid plan' });

    const amount = billing_cycle === 'yearly' ? plan.price_yearly : plan.price_monthly;
    if (!amount || amount <= 0) return apiResponse(res, { status: 400, success: false, error: 'Plan has no valid price' });

    const razorpayKeyId = await SystemConfig.getValue('razorpay_key_id', '');
    const razorpayKeySecret = await SystemConfig.getValue('razorpay_key_secret', '');

    if (!razorpayKeyId || !razorpayKeySecret) {
      return apiResponse(res, { status: 500, success: false, error: 'Payment gateway not configured' });
    }

    const Razorpay = require('razorpay');
    const razorpay = new Razorpay({ key_id: razorpayKeyId, key_secret: razorpayKeySecret });

    const order = await razorpay.orders.create({
      amount: Math.round(amount * 100), // Razorpay expects paise
      currency: plan.currency || 'INR',
      receipt: `sub_${req.user.tenant_id}_${Date.now()}`,
      notes: {
        tenant_id: String(req.user.tenant_id),
        user_id: String(req.user._id),
        plan_slug: plan.slug,
        billing_cycle,
      },
    });

    // Create pending subscription record
    const subscription = await Subscription.create({
      tenant_id: req.user.tenant_id,
      user_id: req.user._id,
      plan_slug: plan.slug,
      plan_name: plan.name,
      billing_cycle,
      amount,
      currency: plan.currency || 'INR',
      status: 'pending',
      razorpay_order_id: order.id,
    });

    return apiResponse(res, {
      data: {
        order_id: order.id,
        amount: order.amount,
        currency: order.currency,
        key_id: razorpayKeyId,
        subscription_id: subscription._id,
        plan,
      },
    });
  } catch (error) {
    console.error('[Billing][CreateOrder]', error.message);
    return apiResponse(res, { status: 500, success: false, error: 'Failed to create payment order' });
  }
});

// POST /verify-payment — verify Razorpay payment and activate subscription
router.post('/verify-payment', authenticate, async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, subscription_id } = req.body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return apiResponse(res, { status: 400, success: false, error: 'Missing payment verification data' });
    }

    const razorpayKeySecret = await SystemConfig.getValue('razorpay_key_secret', '');
    const crypto = require('crypto');
    const expectedSignature = crypto
      .createHmac('sha256', razorpayKeySecret)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest('hex');

    if (expectedSignature !== razorpay_signature) {
      // Mark subscription as failed
      if (subscription_id) {
        await Subscription.findByIdAndUpdate(subscription_id, { status: 'failed' });
      }
      return apiResponse(res, { status: 400, success: false, error: 'Payment verification failed' });
    }

    // Find the subscription
    const subscription = await Subscription.findOne({ razorpay_order_id });
    if (!subscription) return apiResponse(res, { status: 404, success: false, error: 'Subscription not found' });

    // Calculate subscription period
    const now = new Date();
    const endsAt = new Date(now);
    if (subscription.billing_cycle === 'yearly') {
      endsAt.setFullYear(endsAt.getFullYear() + 1);
    } else {
      endsAt.setMonth(endsAt.getMonth() + 1);
    }

    // Update subscription
    subscription.razorpay_payment_id = razorpay_payment_id;
    subscription.razorpay_signature = razorpay_signature;
    subscription.status = 'active';
    subscription.starts_at = now;
    subscription.ends_at = endsAt;
    await subscription.save();

    // Update tenant
    const plan = await Plan.findOne({ slug: subscription.plan_slug });
    await Tenant.findByIdAndUpdate(subscription.tenant_id, {
      plan: subscription.plan_slug,
      plan_status: 'active',
      subscription_ends_at: endsAt,
      message_limit_monthly: plan?.message_limit || 1000,
      seats_limit: plan?.seats_limit || 3,
      setup_status: 'pending_setup',
    });

    // Update user status only for first-time onboarding
    const User = require('../models/User');
    const user = await User.findById(subscription.user_id);
    if (user && user.status === 'pending_plan') {
      await User.findByIdAndUpdate(user._id, { status: 'pending_setup' });
    }

    return apiResponse(res, {
      data: {
        message: 'Payment verified and subscription activated',
        subscription: { id: subscription._id, plan: subscription.plan_name, ends_at: endsAt },
        redirect_to: '/portal/setup',
      },
    });
  } catch (error) {
    console.error('[Billing][VerifyPayment]', error.message);
    return apiResponse(res, { status: 500, success: false, error: 'Failed to verify payment' });
  }
});

// GET /subscription — get current subscription info
router.get('/subscription', authenticate, async (req, res) => {
  try {
    const tenant = await Tenant.findById(req.user.tenant_id).lean();
    if (!tenant) return apiResponse(res, { status: 404, success: false, error: 'Tenant not found' });

    const plan = await Plan.findOne({ slug: tenant.plan }).lean();
    const activeSubscription = await Subscription.findOne({
      tenant_id: tenant._id, status: 'active',
    }).sort({ created_at: -1 }).lean();

    const isExpired = tenant.plan_status === 'expired' ||
      (tenant.plan_status === 'trial' && tenant.trial_ends_at && new Date() > tenant.trial_ends_at) ||
      (tenant.plan_status === 'active' && tenant.subscription_ends_at && new Date() > tenant.subscription_ends_at);

    return apiResponse(res, {
      data: {
        plan: plan || null,
        plan_status: tenant.plan_status,
        trial_ends_at: tenant.trial_ends_at,
        subscription_ends_at: tenant.subscription_ends_at,
        lifetime_access: tenant.lifetime_access,
        trial_used: tenant.trial_used,
        is_expired: isExpired,
        current_subscription: activeSubscription,
      },
    });
  } catch (error) {
    return apiResponse(res, { status: 500, success: false, error: 'Failed to fetch subscription' });
  }
});

// GET /history — get payment history
router.get('/history', authenticate, async (req, res) => {
  try {
    const subscriptions = await Subscription.find({ tenant_id: req.user.tenant_id })
      .sort({ created_at: -1 }).limit(20).lean();
    return apiResponse(res, { data: { subscriptions } });
  } catch (error) {
    return apiResponse(res, { status: 500, success: false, error: 'Failed to fetch history' });
  }
});

// POST /cancel — cancel subscription
router.post('/cancel', authenticate, async (req, res) => {
  try {
    const tenant = await Tenant.findById(req.user.tenant_id);
    if (!tenant) return apiResponse(res, { status: 404, success: false, error: 'Tenant not found' });
    if (tenant.plan_status === 'cancelled') return apiResponse(res, { status: 400, success: false, error: 'Already cancelled' });
    if (tenant.lifetime_access) return apiResponse(res, { status: 400, success: false, error: 'Lifetime access cannot be cancelled' });

    // Mark tenant as cancelled but keep access until subscription_ends_at
    tenant.plan_status = 'cancelled';
    await tenant.save();

    // Update active subscription
    await Subscription.updateMany(
      { tenant_id: req.user.tenant_id, status: 'active' },
      { $set: { status: 'cancelled', cancelled_at: new Date() } }
    );

    return apiResponse(res, { data: { message: 'Subscription cancelled. Access continues until the end of your billing period.' } });
  } catch (error) {
    console.error('[Billing][Cancel]', { error: error.message });
    return apiResponse(res, { status: 500, success: false, error: 'Failed to cancel subscription' });
  }
});

module.exports = router;
