// Scope pill: the scope a setting was resolved from (components/ScopePill, #302 slice 28).
// `type` keys are the `scope_type` lookup values; an unknown value falls back to the raw token.

const messages = {
  scopePill: {
    title: 'Resolved from {scope} scope',
    type: {
      global: 'global',
      tenant: 'tenant',
      client: 'client',
      sender: 'sender',
      source: 'source',
      resource: 'resource',
    },
  },
};

export default messages;
