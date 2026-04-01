const express = require('express');
const WhatsAppAccount = require('../models/WhatsAppAccount');
const Message = require('../models/Message');
const { authenticate, requireStatus } = require('../middleware/auth');
const { decrypt } = require('../services/encryptionService');
const metaService = require('../services/metaService');
const { apiResponse } = require('../utils/helpers');

const router = express.Router();

router.use(authenticate, requireStatus('active'));

router.get('/overview', async (req, res) => {
  try {
    const waAccount = await WhatsAppAccount.findOne({ tenant_id: req.tenant._id });
    if (!waAccount) {
      return apiResponse(res, {
        status: 404,
        success: false,
        error: 'No WhatsApp account connected',
      });
    }

    const accessToken = decrypt(waAccount.access_token_encrypted);
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const recentPricedMessagesPromise = Message.find({
      tenant_id: req.tenant._id,
      direction: 'outbound',
      $or: [{ message_timestamp: { $gte: thirtyDaysAgo } }, { timestamp: { $gte: thirtyDaysAgo } }],
      'payload.latest_status_payload.pricing': { $exists: true },
    })
      .sort({ message_timestamp: -1, timestamp: -1 })
      .limit(25)
      .lean();

    const [billingInfo, discoveredWabas, recentPricedMessages] = await Promise.all([
      metaService.fetchWABABillingInfo(waAccount.waba_id, accessToken),
      metaService.fetchWABAs(accessToken),
      recentPricedMessagesPromise,
    ]);

    const matchedWaba = discoveredWabas.find((item) => item.id === waAccount.waba_id) || null;
    const creditLines = matchedWaba?.business_id
      ? await metaService.fetchExtendedCredits(matchedWaba.business_id, accessToken).catch((error) => {
          console.warn('[Billing Route] Failed to fetch extended credits', error.message);
          return [];
        })
      : [];

    const pricingSummary = recentPricedMessages.reduce(
      (accumulator, message) => {
        const pricing = message.payload?.latest_status_payload?.pricing || {};
        const category = String(pricing.category || 'unknown').toLowerCase();
        const pricingModel = String(pricing.pricing_model || 'unknown').toLowerCase();
        const billable = pricing.billable !== false;

        if (billable) {
          accumulator.billable_count += 1;
        } else {
          accumulator.non_billable_count += 1;
        }

        accumulator.by_category[category] = (accumulator.by_category[category] || 0) + 1;
        accumulator.by_pricing_model[pricingModel] = (accumulator.by_pricing_model[pricingModel] || 0) + 1;

        return accumulator;
      },
      {
        billable_count: 0,
        non_billable_count: 0,
        by_category: {},
        by_pricing_model: {},
      }
    );

    const notices = [];

    if (!billingInfo.primary_funding_id && creditLines.length === 0) {
      notices.push({
        id: 'billing_setup_missing',
        title: 'Payment setup not exposed for this WABA yet',
        message:
          'Meta did not return a payment method or shared line of credit for this connected account. This can happen on test resources or when billing is managed outside the current app permissions.',
        source: 'meta',
      });
    }

    notices.push({
      id: 'invoice_api_limit',
      title: 'Invoice history is not available in this portal yet',
      message:
        'The Meta endpoints wired here expose payment setup, funding identifiers, and pricing signals from status webhooks, but not a full invoice/payment ledger for direct portal rendering.',
      source: 'app',
    });

    return apiResponse(res, {
      data: {
        account: {
          waba_id: waAccount.waba_id,
          display_name: waAccount.display_name,
          display_phone_number: waAccount.display_phone_number,
          currency: billingInfo.currency || null,
          business_review_status: billingInfo.account_review_status || null,
          primary_funding_id: billingInfo.primary_funding_id || null,
          purchase_order_number: billingInfo.purchase_order_number || null,
          business_id: matchedWaba?.business_id || null,
          business_name: matchedWaba?.business_name || null,
          line_of_credit_count: creditLines.length,
          credit_lines: creditLines,
          sender_registration_status: waAccount.sender_registration_status || 'unknown',
          messaging_limit_tier: waAccount.messaging_limit_tier || null,
        },
        pricing_summary: pricingSummary,
        recent_priced_messages: recentPricedMessages.map((message) => {
          const pricing = message.payload?.latest_status_payload?.pricing || {};
          return {
            _id: message._id,
            message_timestamp: message.message_timestamp || message.timestamp || null,
            status: message.status,
            to: message.to,
            contact: message.contact_id
              ? message.contact_id
              : {
                  name: message.contact_name || '',
                  profile_name: message.contact_name || '',
                  phone_number: message.contact_phone || message.to || '',
                },
            category: pricing.category || 'unknown',
            pricing_model: pricing.pricing_model || 'unknown',
            billable: pricing.billable !== false,
          };
        }),
        notices,
      },
    });
  } catch (error) {
    console.error('[Billing Route] Failed to load billing overview', error);
    return apiResponse(res, {
      status: error.metaError ? 502 : 500,
      success: false,
      error: error.message || 'Failed to load billing overview',
      meta: error.metaError
        ? {
            source: 'meta',
            code: error.metaError.code || null,
            subcode: error.metaError.error_subcode || null,
            type: error.metaError.type || null,
            trace_id: error.metaError.fbtrace_id || null,
          }
        : {
            source: 'app',
          },
    });
  }
});

module.exports = router;
