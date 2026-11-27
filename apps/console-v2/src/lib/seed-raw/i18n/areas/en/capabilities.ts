// Capability names and the permission phrases built from them (lib/capabilities).
// Label keys are the capability keys, split at the dot into resource and action.
// English labels for keys without a hand-written name are the key words, as before.

const messages = {
  capabilities: {
    required: '{label} permission required',
    requires: 'Requires {label} permission',
    fallback: 'permission',
    fallbackTitle: 'Permission',
    or: ' or ',
    scopeAnd: '{scope} and {requirement}',
    scopeRequired: '{scope} required',
    scope: {
      platform: 'Platform scope',
      tenant: 'Tenant scope',
      client: 'Client scope',
      sender: 'Sender scope',
      other: 'Required scope',
    },
    labels: {
      access_policy: {
        approve: 'access approval',
        read: 'access policy',
      },
      addresses: {
        read: 'addresses read',
      },
      agreements: {
        write: 'service level management',
      },
      alerts: {
        read: 'alerts read',
        write: 'alert update',
      },
      api_gateway: {
        read: 'API gateway',
        write: 'API gateway update',
      },
      audit_log: {
        read: 'audit activity',
      },
      baskets: {
        read: 'baskets read',
        write: 'baskets write',
      },
      billing: {
        read: 'billing read',
        write: 'billing update',
      },
      branches: {
        read: 'branches read',
        write: 'branch update',
      },
      clients: {
        read: 'client access',
        write: 'client update',
      },
      cod: {
        read: 'COD',
      },
      comms: {
        write: 'comms write',
      },
      console_metadata: {
        read: 'console metadata read',
      },
      devices: {
        write: 'device management',
      },
      disputes: {
        read: 'disputes read',
        write: 'dispute update',
      },
      feature_flags: {
        read: 'feature flag',
        write: 'feature flag update',
      },
      finance: {
        read: 'finance access',
        write: 'finance update',
      },
      fleet: {
        read: 'fleet read',
        write: 'fleet update',
      },
      imports: {
        read: 'import access',
        write: 'import update',
      },
      insights: {
        read: 'insights read',
      },
      integration_plugins: {
        activate: 'integration plugin activation',
        approve: 'integration plugin approval',
        read: 'integration plugin',
        test: 'integration plugin test',
        write: 'integration plugin update',
      },
      integrations: {
        read: 'integrations read',
        write: 'integration update',
      },
      invoices: {
        refund: 'invoice refund',
        send: 'invoice send',
      },
      label_design: {
        read: 'label design read',
        write: 'label design write',
      },
      labels: {
        download: 'labels download',
        read: 'labels read',
        reprint: 'labels reprint',
        write: 'labels write',
      },
      lookups: {
        read: 'lookup access',
        write: 'lookup update',
      },
      manual_review: {
        resolve: 'manual review resolve',
      },
      mappings: {
        read: 'mappings read',
        write: 'mappings write',
      },
      marketplace: {
        read: 'marketplace read',
        write: 'marketplace write',
      },
      marketplace_participant_requests: {
        read: 'partner application',
        review: 'partner application review',
      },
      network: {
        read: 'network read',
      },
      observability: {
        read: 'observability read',
      },
      organizations: {
        read: 'organizations read',
        write: 'organizations write',
      },
      pickups: {
        read: 'pickups read',
      },
      provider_auth: {
        read: 'provider auth read',
      },
      recipients: {
        read: 'recipient access',
        write: 'recipient update',
      },
      route_plans: {
        read: 'route plan',
        write: 'route plan update',
      },
      routes: {
        read: 'routes read',
        write: 'route update',
      },
      senders: {
        read: 'sender access',
        write: 'sender update',
      },
      service_offerings: {
        read: 'service offering',
        write: 'service offering update',
      },
      settings: {
        read: 'settings access',
        write: 'settings write',
      },
      settlements: {
        read: 'settlement',
        write: 'settlement update',
      },
      shipments: {
        read: 'shipment access',
        write: 'shipment update',
      },
      support: {
        read: 'support read',
        write: 'support update',
      },
      system: {
        write: 'system write',
      },
      tasks: {
        complete: 'task completion',
        read: 'tasks read',
        write: 'task update',
      },
      tenant_signup_requests: {
        read: 'tenant signup',
        review: 'tenant signup review',
      },
      user_devices: {
        read: 'device access',
        write: 'device revocation',
      },
      users: {
        manage: 'user management',
        read: 'user access',
      },
      warehouse: {
        read: 'warehouse read',
        scan: 'warehouse scan',
        write: 'warehouse write',
      },
      webhooks: {
        read: 'webhooks read',
        write: 'webhook update',
      },
      workflows: {
        read: 'workflows read',
        write: 'workflow update',
      },
      zones: {
        read: 'zones read',
        write: 'zones write',
      },
    },
  },
};

export default messages;
