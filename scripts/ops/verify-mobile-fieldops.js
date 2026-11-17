#!/usr/bin/env node
/* eslint-disable no-console */

const { main } = require('./verify-mobile-fieldops-strict');

if (require.main === module) {
  main();
}

module.exports = {
  main,
};
