#!/usr/bin/env node
'use strict';

function stripAt(value) {
  return String(value || '').trim().replace(/^@+/, '').toLowerCase();
}

function normalizeApprovalMarker(value) {
  return String(value || '').trim().toLowerCase();
}

function latestReviewStateByLogin(reviews) {
  const latest = new Map();
  for (const review of Array.isArray(reviews) ? reviews : []) {
    const login = stripAt(review?.user?.login || '');
    if (!login) continue;
    const state = String(review?.state || '').trim().toUpperCase();
    const submittedAt = String(review?.submitted_at || '').trim();
    const ts = submittedAt ? Date.parse(submittedAt) : 0;
    const prev = latest.get(login);
    if (!prev || ts >= prev.ts) {
      latest.set(login, { state, ts });
    }
  }
  return latest;
}

function summarizeApprovalStates({
  reviews,
  comments,
  approverLogins,
  headSha,
  commentApprovalMarker,
}) {
  const latest = latestReviewStateByLogin(reviews);
  const normalizedHeadSha = String(headSha || '').trim().toLowerCase();
  const normalizedMarker = normalizeApprovalMarker(commentApprovalMarker);
  const latestCommentState = new Map();
  const stickyApprovedByComment = new Set();
  for (const comment of Array.isArray(comments) ? comments : []) {
    const login = stripAt(comment?.user?.login || '');
    if (!login) continue;
    const body = String(comment?.body || '').trim().toLowerCase();
    const submittedAt = String(comment?.updated_at || comment?.created_at || '').trim();
    const ts = submittedAt ? Date.parse(submittedAt) : 0;
    const approvedByComment =
      Boolean(normalizedMarker) &&
      Boolean(normalizedHeadSha) &&
      body
        .split(/\r?\n/)
        .map((line) => line.trim())
        .some(
          (line) =>
            line.startsWith(normalizedMarker) &&
            line.slice(normalizedMarker.length).trim() === normalizedHeadSha,
        );
    if (approvedByComment) stickyApprovedByComment.add(login);
    const state = approvedByComment ? 'APPROVED_COMMENT' : 'COMMENTED';
    const prev = latestCommentState.get(login);
    if (!prev || ts >= prev.ts) {
      latestCommentState.set(login, { state, ts, approvedByComment });
    }
  }
  const approvers = Array.isArray(approverLogins) ? approverLogins : [];
  const approvedBy = approvers.filter((login) => {
    const reviewState = latest.get(login)?.state || '';
    if (reviewState === 'APPROVED') return true;
    return stickyApprovedByComment.has(login);
  });
  const stateByApprover = Object.fromEntries(
    approvers.map((login) => {
      const reviewState = latest.get(login)?.state || '';
      if (reviewState) return [login, reviewState];
      if (stickyApprovedByComment.has(login)) return [login, 'APPROVED_COMMENT'];
      return [login, latestCommentState.get(login)?.state || 'NO_REVIEW'];
    }),
  );
  return {
    approved: approvedBy.length > 0,
    approvedBy,
    stateByApprover,
  };
}

module.exports = {
  stripAt,
  normalizeApprovalMarker,
  latestReviewStateByLogin,
  summarizeApprovalStates,
};
