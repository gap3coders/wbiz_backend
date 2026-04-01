const { normalizePhoneNumber } = require('./messagingService');

const buildTemplateComponents = (variables = []) => {
  if (!Array.isArray(variables) || variables.length === 0) {
    return undefined;
  }

  return [
    {
      type: 'body',
      parameters: variables.map((value) => ({
        type: 'text',
        text: String(value ?? ''),
      })),
    },
  ];
};

const buildMessagePayload = (input = {}) => {
  const type = String(input.type || 'text').trim();
  const to = normalizePhoneNumber(input.to || input.phone_number);

  if (!to) {
    throw new Error('Recipient phone number is required');
  }

  if (type === 'text') {
    const body = String(input.text || input.body || '').trim();
    if (!body) {
      throw new Error('Message text is required');
    }

    return {
      to,
      type: 'text',
      text: {
        body,
        preview_url: Boolean(input.preview_url),
      },
    };
  }

  if (['image', 'document', 'video', 'audio'].includes(type)) {
    const link = String(input.link || input.media_url || '').trim();
    if (!link) {
      throw new Error(`A media URL is required for ${type} messages`);
    }

    return {
      to,
      type,
      [type]: {
        link,
        ...(input.caption ? { caption: String(input.caption) } : {}),
        ...(input.filename && type === 'document' ? { filename: String(input.filename) } : {}),
      },
    };
  }

  if (type === 'location') {
    if (input.latitude === undefined || input.longitude === undefined) {
      throw new Error('Latitude and longitude are required for location messages');
    }

    return {
      to,
      type: 'location',
      location: {
        latitude: Number(input.latitude),
        longitude: Number(input.longitude),
        ...(input.name ? { name: String(input.name) } : {}),
        ...(input.address ? { address: String(input.address) } : {}),
      },
    };
  }

  if (type === 'interactive') {
    if (!input.interactive || typeof input.interactive !== 'object') {
      throw new Error('Interactive payload is required for interactive messages');
    }

    return {
      to,
      type: 'interactive',
      interactive: input.interactive,
    };
  }

  if (type === 'template') {
    const templateName = String(input.template_name || input.name || '').trim();
    const languageCode = String(input.language_code || input.language || 'en_US').trim();
    if (!templateName) {
      throw new Error('Template name is required');
    }

    return {
      to,
      type: 'template',
      template: {
        name: templateName,
        language: { code: languageCode },
        ...(input.components ? { components: input.components } : {}),
        ...(!input.components && Array.isArray(input.variables)
          ? { components: buildTemplateComponents(input.variables) }
          : {}),
      },
    };
  }

  throw new Error(`Unsupported message type: ${type}`);
};

module.exports = {
  buildTemplateComponents,
  buildMessagePayload,
};
