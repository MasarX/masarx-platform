#!/usr/bin/env node
/* eslint-disable no-console */
const common = require('./pr-validation-focused-common');
const policy = require('./pr-validation-focused-policy');
const isolation = require('./pr-validation-focused-isolation');
const state = require('./pr-validation-focused-state');
const wave = require('./pr-validation-focused-wave');
const scheduler = require('./pr-validation-focused-scheduler');

module.exports = {
  ...common,
  ...policy,
  ...isolation,
  HARD_STOP_PRECEDENCE: state.HARD_STOP_PRECEDENCE,
  buildFocusedCollectionIdentity: state.buildFocusedCollectionIdentity,
  classifyFocusedFileDisposition: state.classifyFocusedFileDisposition,
  decideMigrationRebuild: state.decideMigrationRebuild,
  normalizeFocusedGuardSummary: state.normalizeFocusedGuardSummary,
  redactFocusedFailureExcerpt: state.redactFocusedFailureExcerpt,
  ...wave,
  ...scheduler,
};
