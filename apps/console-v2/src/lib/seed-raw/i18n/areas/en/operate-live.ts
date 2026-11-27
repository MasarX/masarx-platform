const messages = {
  live: {
    state: {
      syncing: 'Syncing',
      live: 'Live',
      reconnecting: 'Reconnecting',
      offline: 'Offline',
      polling: 'Auto-refresh',
      'not-configured': 'Live refresh not configured',
    },
    statusbar: {
      syncing: 'Realtime syncing',
      live: 'Realtime connected',
      reconnecting: 'Realtime reconnecting',
      offline: 'Offline',
      polling: 'Auto-refresh',
    },
    connectedTitle: 'Connected. Last change {age} ago.',
    missingPolicyTitle: 'Missing or invalid setting {key}',
    detailSeparator: '·',
    lastUpdate: 'last update {age} ago',
    dataFrom: 'data from {time}',
    dataFromLabel: 'Data from {time}',
    pausedBanner: 'Live updates are paused. Data shown is from {time} and may be out of date.',
    offlineBanner: 'You are offline. Showing data from {time}. Edits are paused until you reconnect.',
    reconnectToSave: 'Reconnect to save',
    show: 'Show',
    updated: 'Updated',
    newRuns: {
      zero: 'No new runs',
      one: '1 new run',
      two: '2 new runs',
      few: '{count} new runs',
      many: '{count} new runs',
      other: '{count} new runs',
    },
    newShipments: {
      zero: 'No new shipments',
      one: '1 new shipment',
      two: '2 new shipments',
      few: '{count} new shipments',
      many: '{count} new shipments',
      other: '{count} new shipments',
    },
    conflict: {
      stopTitle: 'This stop changed while you were editing',
      body: 'Someone else updated it. Your unsaved input stays until you close the form.',
      review: 'Review change',
      keep: 'Keep editing',
    },
  },
};

export default messages;
