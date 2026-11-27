// Platform auth email URL policy: Console V2 copy in English and Arabic (issue #302).

const messages = {
  platformAuthEmail: {
    copyableUrl: {
      copyUrl: 'Copy URL',
      copy: 'copy',
    },
    authEmailModule: {
      platform: 'Platform',
      youDoNotHave: 'You do not have permission to view the auth-email URL policy.',
      readOnly: 'read-only',
      managedByPlatformRelease: 'Managed by platform release controls',
      copyRawJson: 'Copy raw JSON',
      environment: 'Environment',
      audit: 'audit {audit_status}',
      lastReviewed: 'Last reviewed: {last_audit_at}',
      managedThroughPlatformRelease: 'Managed through platform release controls.',
      copyPolicyReference: 'Copy policy reference',
      copy: 'copy',
      callbackUrls: 'Callback URLs · {length}',
      redirectUrls: 'Redirect URLs · {length}',
      policySummary: 'Policy summary',
      copy2: 'Copy',
      auditStatus: 'Audit status',
      lastReviewed2: 'Last reviewed',
      callbackUrls2: 'Callback URLs',
      redirectUrls2: 'Redirect URLs',
      hostedCallbackUrlsAre: 'Hosted callback URLs are governed by platform release controls. This page is read-only; changes are reviewed outside the console before promotion.',
      titleAccent: 'Auth email',
      titlePlain: 'URL policy',
    },
    copy: {
      copied: 'Copied · {label}',
      copyFailed: 'Copy failed',
      clipboardUnavailable: 'Clipboard unavailable',
      url: 'URL',
      rawPolicyJson: 'raw policy JSON',
      policyReference: 'policy reference',
      policySummary: 'policy summary',
    },
    summary: {
      sourceFile: 'Source file: {value}',
      environment: 'Environment: {value}',
      auditStatus: 'Audit status: {value}',
      callbackUrls: 'Callback URLs: {count}',
      redirectUrls: 'Redirect URLs: {count}',
    },
  },
};

export default messages;
