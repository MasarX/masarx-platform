const { dialog360 } = require('../../../scripts/clients');

const liveEnabled = process.env.RUN_LIVE_COMMS_TESTS === 'true';
const describeOrSkip = liveEnabled ? describe : describe.skip;

describeOrSkip('Communications workflow', () => {
  beforeAll(async () => {
    await dialog360.getConfig();
  });

  afterAll(async () => {
    if (typeof dialog360.shutdown === 'function') {
      await dialog360.shutdown();
    }
  });

  test('sends WhatsApp text message via 360dialog', async () => {
    const response = await dialog360.sendTextMessage({
      body: `Automation smoke test @ ${new Date().toISOString()}`
    });
    expect(response).toHaveProperty('messages');
    expect(Array.isArray(response.messages)).toBe(true);
  });
});
