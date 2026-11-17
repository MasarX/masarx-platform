const { loadEnv } = require('../../scripts/utils/load-env');

loadEnv();

// Increase default test timeout if not explicitly set (individual tests can still override)
jest.setTimeout(Number(process.env.JEST_TIMEOUT || 90000));
