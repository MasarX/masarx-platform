const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function readFixture(name) {
  const map = {
    basic_shipment_created: 'basic_shipment_created.json',
    hmac_shipment_created: 'hmac_shipment_created.json',
    async_shipment_created: 'async_shipment_created.json',
  };
  const filename = map[name] || name;
  const filePath = path.join(__dirname, '..', 'webhooks', filename);
  const text = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(text);
}

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function buildPayload(fixtureName, patch = {}) {
  const base = readFixture(fixtureName);
  const merged = deepClone(base);
  // naive shallow merge for top-level; callers can supply full structure
  return Object.assign(merged, patch);
}

function signHmac(payload, secret, {
  algorithm = 'sha256',
  encoding = 'hex',
} = {}) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return crypto.createHmac(algorithm, secret).update(body).digest(encoding);
}

module.exports = {
  buildPayload,
  readFixture,
  signHmac,
};

