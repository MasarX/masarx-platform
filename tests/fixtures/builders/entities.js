// Reusable entity builders wrapping integration helpers
const {
  createOrganization,
  createClient,
  createShipment,
  createLabel,
} = require('../../integration/helpers/tenant-utils');

async function buildOrg(client, name = `Builder Org ${Date.now()}`) {
  return createOrganization(client, name);
}

async function buildClient(client, orgId, name = `Builder Client ${Date.now()}`) {
  return createClient(client, orgId, name);
}

async function buildShipment(client, params) {
  return createShipment(client, params);
}

async function buildLabel(client, params) {
  return createLabel(client, params);
}

module.exports = {
  buildOrg,
  buildClient,
  buildShipment,
  buildLabel,
};

