// Keep portal exception routing anchored to the shared workspace so tenant NDR actions stay row-driven.
export const portalExceptionWorkspaceDefaults = {
  sectionId: "operations",
  resourceSelector: "exceptions",
  workspacePathSegment: "exceptions",
  i18nNamespace: "ui.exceptionInbox",
  testIdPrefix: "portal-exception-inbox",
} as const;
