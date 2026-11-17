#!/usr/bin/env node
const { loadEnv } = require('../utils/load-env');
loadEnv();
const { dialog360 } = require('../clients');

(async () => {
  try {
    const cfg = await dialog360.getConfig();
    if (!cfg.apiKey) {
      throw new Error('Missing 360dialog API key in provider_auth_configs.');
    }
    const to = process.argv[2] || process.env.TEST_WHATSAPP_TO;
    if (!to) {
      throw new Error('Missing recipient phone. Provide argv[2] or set TEST_WHATSAPP_TO.');
    }
    const template = process.argv[3] || process.env.TEST_WHATSAPP_TEMPLATE;
    if (!template) {
      throw new Error('Missing template name. Provide argv[3] or set TEST_WHATSAPP_TEMPLATE.');
    }
    const language = process.argv[4] || process.env.TEST_WHATSAPP_LANG;
    if (!language) {
      throw new Error('Missing language code. Provide argv[4] or set TEST_WHATSAPP_LANG.');
    }
    const res = await dialog360.sendTemplateMessage({ to, templateName: template, language });
    console.log('[send-360dialog] response', JSON.stringify(res));
    process.exit(0);
  } catch (err) {
    console.error('[send-360dialog] error', err.message);
    process.exit(1);
  }
})();
