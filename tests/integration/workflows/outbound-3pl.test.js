const { logestechs } = require('../../../scripts/clients');

const liveEnabled = process.env.RUN_LIVE_3PL_TESTS === 'true';
const describeOrSkip = liveEnabled ? describe : describe.skip;

describeOrSkip('Outbound 3PL workflow', () => {
  beforeAll(async () => {
    await logestechs.getConfig();
  });

  test('creates a shipment via Logestechs API', async () => {
    const response = await logestechs.createShipment({
      packagePayload: {
        receiverName: 'QA Receiver',
        receiverPhone: '+12025550123',
        quantity: 1,
        description: `Automation order ${Date.now()}`
      },
      destination: {
        village: 'الرياض'
      }
    });

    expect(response).toBeDefined();
    expect(typeof response).toBe('object');
    if (response.error || response.status === 'ERROR') {
      throw new Error(`Logestechs API returned error: ${JSON.stringify(response)}`);
    }
  });
});
