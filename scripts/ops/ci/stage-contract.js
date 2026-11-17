#!/usr/bin/env node
/**
 * stage-contract.js
 *
 * SSOT deployment stage taxonomy for CI/orchestration paths.
 * Hard-cut contract: dev | stg | prod (no legacy aliases).
 */
/* eslint-disable no-console */

const STAGE_DEV = "dev";
const STAGE_STG = "stg";
const STAGE_PROD = "prod";

const STAGES_ALL = Object.freeze([STAGE_DEV, STAGE_STG, STAGE_PROD]);
const STAGES_PROMOTION = Object.freeze([STAGE_STG, STAGE_PROD]);

function normalizeStage(value) {
  return String(value || "").trim().toLowerCase();
}

function isKnownStage(value) {
  const stage = normalizeStage(value);
  return STAGES_ALL.includes(stage);
}

function assertStage(value, { label = "stage", allowed = STAGES_ALL } = {}) {
  const stage = normalizeStage(value);
  if (!allowed.includes(stage)) {
    throw new Error(
      `Invalid ${label} "${stage || "<missing>"}" (expected ${allowed.join("|")}).`
    );
  }
  return stage;
}

module.exports = {
  STAGE_DEV,
  STAGE_STG,
  STAGE_PROD,
  STAGES_ALL,
  STAGES_PROMOTION,
  normalizeStage,
  isKnownStage,
  assertStage,
};
