const mongoose = require('mongoose');

/**
 * InteractiveTemplate — reusable interactive message templates
 * Supports: button, list, carousel (multi-product), product, poll
 *
 * WhatsApp Cloud API interactive types reference:
 *  - button:   up to 3 reply buttons
 *  - list:     expandable menu with sections/rows
 *  - product:  single product from FB catalog
 *  - product_list: multi-product (carousel) from FB catalog
 *  - (poll is not an official interactive type — it's built as buttons)
 */
const interactiveTemplateSchema = new mongoose.Schema(
  {
    tenant_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    created_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

    name: { type: String, required: true, trim: true },
    description: { type: String, default: '', trim: true },

    type: {
      type: String,
      enum: ['button', 'list', 'product', 'product_list', 'poll'],
      required: true,
    },

    // Common fields
    header: {
      type: { type: String, enum: ['text', 'image', 'video', 'document', 'none'], default: 'none' },
      text: { type: String, default: '' },
      media_url: { type: String, default: '' },
    },
    body: { type: String, default: '' },
    footer: { type: String, default: '' },

    // === button type ===
    buttons: [
      {
        id: { type: String, default: '' },
        title: { type: String, default: '' },
      },
    ],

    // === list type ===
    list_button_text: { type: String, default: 'View Options' },
    sections: [
      {
        title: { type: String, default: '' },
        rows: [
          {
            id: { type: String, default: '' },
            title: { type: String, default: '' },
            description: { type: String, default: '' },
          },
        ],
      },
    ],

    // === product / product_list type ===
    catalog_id: { type: String, default: '' },
    product_retailer_ids: [{ type: String }],
    product_sections: [
      {
        title: { type: String, default: '' },
        product_items: [{ product_retailer_id: { type: String, default: '' } }],
      },
    ],

    // === poll type (built as buttons) ===
    poll_question: { type: String, default: '' },
    poll_options: [{ type: String }],

    // Stats
    times_sent: { type: Number, default: 0 },
    last_sent_at: { type: Date },

    // Status
    active: { type: Boolean, default: true },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } },
);

interactiveTemplateSchema.index({ tenant_id: 1, type: 1 });
interactiveTemplateSchema.index({ tenant_id: 1, name: 1 });

module.exports = mongoose.model('InteractiveTemplate', interactiveTemplateSchema);
