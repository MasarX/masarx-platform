// Platform configuration and scope ladder: Console V2 copy in English and Arabic (issue #302).

const messages = {
  platformConfig: {
    scopeBox: {
      inherit: 'inherit',
      resolvedFrom: 'resolved_from={resolved_from}',
    },
    resolvedValuePanel: {
      largeSavedPolicyValue: 'Large saved policy value summarized for operator scanning. Full saved policy details are available below when needed.',
      showFullSavedPolicy: 'Show full saved policy details',
    },
    compareScopesBody: {
      resolvesTheSameSetting: 'Resolves the same setting at every scope this category allows. Lower scopes override higher ones; "inherit" means no row exists at that scope (fall through to ladder).',
    },
    configModule: {
      compareScopes: 'Compare scopes · {category}',
      close: 'Close',
      compareScopesFailed: 'Compare scopes failed',
      requestSettingsChange: 'Request settings change',
      changePreviewReady: 'Change preview ready',
      changeRequestSubmitted: 'Change request submitted',
      changePreviewCouldNot: 'Change preview could not be prepared. Review the setting details and try again.',
      settingApplied: 'Setting applied',
      settingCouldNotBe: 'Setting could not be applied. Review the setting details and try again.',
      platform: 'Platform',
      policyResolver: 'Policy resolver',
      youDoNotHave: 'You do not have permission to view configuration & scope ladder.',
      compareScopes2: 'Compare scopes',
      requestChange: 'Request change',
      approvalRequired: 'approval-required',
      noSettingsCategoriesRegistered: 'No settings categories registered.',
      setting: 'Setting',
      schemaIdServerSide: 'schema id (server-side ajv-validates here)',
      autoApply: 'auto-apply',
      scopes: 'scopes: {value}',
      theSavedPolicySource: 'The saved policy source is missing required scope details.',
      resolutionRecorded: 'Resolution recorded',
      openPolicyHistory: 'Open policy history',
      overrideReplaces: 'Override: {resolved_from} replaces {override_of}',
      resolvedValue: 'Resolved value',
      scopeLadder: 'Scope ladder',
      relatedWorkflows: 'Related workflows',
      resolvesAtTheScope: '{value} resolves at the {resolved_from} scope. Related workflows use this saved policy decision automatically.',
      titleAccent: 'Configuration',
      titlePlain: '— scope ladder',
    },
  },
};

export default messages;
