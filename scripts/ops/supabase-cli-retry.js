const { classifyDbPushFailure } = require('./preview/db-drift');

function shouldRetrySupabasePushOutput(output) {
  const v = String(output || '').toLowerCase();
  const classified = classifyDbPushFailure(output);
  if (classified.failureClass === 'preview-db-drift') {
    return false;
  }
  if (classified.failureClass === 'migration-history-conflict') {
    return false;
  }
  const tenantAuthTransient =
    v.includes('tenant or user not found') ||
    v.includes('password authentication failed') ||
    v.includes('too many authentication errors');
  const connectivityTransient =
    v.includes('network is unreachable') ||
    v.includes('fatal: tenant or user not found') ||
    v.includes('could not connect to server') ||
    v.includes('server closed the connection unexpectedly') ||
    v.includes('connection reset by peer') ||
    v.includes('maxclientsinsessionmode') ||
    v.includes('max clients are limited to pool_size') ||
    v.includes('too many clients already') ||
    v.includes('dns lookup failure') ||
    v.includes('getaddrinfo') ||
    v.includes('no route to host') ||
    v.includes('connect timed out') ||
    v.includes('timeout was reached') ||
    v.includes('connection timed out');

  return (
    tenantAuthTransient ||
    connectivityTransient ||
    v.includes('tuple concurrently updated') ||
    v.includes('sqlstate xx000') ||
    v.includes('canceling statement due to lock timeout') ||
    v.includes('lock timeout') ||
    v.includes('sqlstate 55p03') ||
    v.includes('deadlock detected') ||
    v.includes('sqlstate 40p01') ||
    v.includes('could not obtain lock on relation') ||
    v.includes('terminating connection due to administrator command') ||
    v.includes('sqlstate 57p01') ||
    v.includes('the database system is starting up') ||
    v.includes('sqlstate 57p03') ||
    v.includes('the database system is shutting down') ||
    v.includes('server closed the connection unexpectedly') ||
    v.includes('connection terminated unexpectedly') ||
    v.includes('connection reset by peer')
  );
}

module.exports = {
  shouldRetrySupabasePushOutput,
};
