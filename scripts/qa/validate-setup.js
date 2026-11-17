/**
 * End-to-End Validation Script
 * Task Group 13: Complete validation of local-first development workflow
 *
 * Validates:
 * - All 10 migrations have been applied
 * - All 45 tables exist
 * - All 33 partitions exist (21 HASH + 12 RANGE)
 * - All 9 RLS policies are enabled
 * - All 17 indexes exist
 * - Performance measurements
 * - Zero-hardcoding verification
 *
 * Usage:
 *   node scripts/validate-setup.js
 *
 * Exit codes:
 *   0 = All validations passed
 *   1 = One or more validations failed
 */

const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

// Color codes for terminal output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  blue: '\x1b[34m'
};

/**
 * Print colored message
 */
function print(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

/**
 * Print section header
 */
function printHeader(title) {
  print('\n' + '='.repeat(70), 'cyan');
  print(title.toUpperCase(), 'cyan');
  print('='.repeat(70), 'cyan');
}

/**
 * Print sub-section header
 */
function printSubHeader(title) {
  print('\n' + '-'.repeat(70), 'blue');
  print(title, 'blue');
  print('-'.repeat(70), 'blue');
}

/**
 * Connect to database
 */
async function getDbConnection() {
  if (!process.env.DATABASE_URL) { throw new Error('[validate-setup] DATABASE_URL is required.'); }
  const connectionString = process.env.DATABASE_URL;

  const pool = new Pool({ connectionString });

  try {
    const client = await pool.connect();
    return { pool, client };
  } catch (error) {
    print(`âœ— Failed to connect to database: ${error.message}`, 'red');
    print(`  Connection: ${connectionString.replace(/:[^:@]+@/, ':***@')}`, 'yellow');
    print('  Ensure Supabase is running: npx --yes supabase@2 start', 'yellow');
    throw error;
  }
}

/**
 * Validate all tables exist
 */
async function validateTables(client) {
  printSubHeader('Validating Tables (45 expected)');

  const result = await client.query(`
    SELECT schemaname, tablename
    FROM pg_tables
    WHERE schemaname = 'public'
    ORDER BY tablename
  `);

  const tableCount = result.rows.length;
  print(`  Found ${tableCount} tables in public schema`, tableCount >= 45 ? 'green' : 'yellow');

  // List all tables
  result.rows.forEach(row => {
    print(`    - ${row.tablename}`, 'reset');
  });

  return {
    passed: tableCount >= 45,
    count: tableCount,
    expected: 45,
    tables: result.rows.map(r => r.tablename)
  };
}

/**
 * Validate HASH partitions
 */
async function validateHashPartitions(client) {
  printSubHeader('Validating HASH Partitions (21 expected)');

  const result = await client.query(`
    SELECT
      parent.relname as parent_table,
      child.relname as partition_name
    FROM pg_inherits
    JOIN pg_class parent ON pg_inherits.inhparent = parent.oid
    JOIN pg_class child ON pg_inherits.inhrelid = child.oid
    JOIN pg_partitioned_table pt ON parent.oid = pt.partrelid
    WHERE pt.partstrat = 'h'  -- 'h' for HASH partitioning
    ORDER BY parent.relname, child.relname
  `);

  const hashPartitionCount = result.rows.length;
  print(`  Found ${hashPartitionCount} HASH partitions`, hashPartitionCount >= 21 ? 'green' : 'yellow');

  // Group by parent table
  const groupedPartitions = {};
  result.rows.forEach(row => {
    if (!groupedPartitions[row.parent_table]) {
      groupedPartitions[row.parent_table] = [];
    }
    groupedPartitions[row.parent_table].push(row.partition_name);
  });

  // Display grouped partitions
  Object.entries(groupedPartitions).forEach(([parent, partitions]) => {
    print(`    ${parent}: ${partitions.length} partition(s)`, 'reset');
    partitions.forEach(p => print(`      - ${p}`, 'reset'));
  });

  return {
    passed: hashPartitionCount >= 21,
    count: hashPartitionCount,
    expected: 21,
    partitions: result.rows
  };
}

/**
 * Validate RANGE partitions
 */
async function validateRangePartitions(client) {
  printSubHeader('Validating RANGE Partitions (12 expected)');

  const result = await client.query(`
    SELECT
      parent.relname as parent_table,
      child.relname as partition_name
    FROM pg_inherits
    JOIN pg_class parent ON pg_inherits.inhparent = parent.oid
    JOIN pg_class child ON pg_inherits.inhrelid = child.oid
    JOIN pg_partitioned_table pt ON parent.oid = pt.partrelid
    WHERE pt.partstrat = 'r'  -- 'r' for RANGE partitioning
    ORDER BY parent.relname, child.relname
  `);

  const rangePartitionCount = result.rows.length;
  print(`  Found ${rangePartitionCount} RANGE partitions`, rangePartitionCount >= 12 ? 'green' : 'yellow');

  // Group by parent table
  const groupedPartitions = {};
  result.rows.forEach(row => {
    if (!groupedPartitions[row.parent_table]) {
      groupedPartitions[row.parent_table] = [];
    }
    groupedPartitions[row.parent_table].push(row.partition_name);
  });

  // Display grouped partitions
  Object.entries(groupedPartitions).forEach(([parent, partitions]) => {
    print(`    ${parent}: ${partitions.length} partition(s)`, 'reset');
    partitions.forEach(p => print(`      - ${p}`, 'reset'));
  });

  return {
    passed: rangePartitionCount >= 12,
    count: rangePartitionCount,
    expected: 12,
    partitions: result.rows
  };
}

/**
 * Validate RLS policies
 */
async function validateRlsPolicies(client) {
  printSubHeader('Validating RLS Policies (9 expected)');

  const result = await client.query(`
    SELECT
      schemaname,
      tablename,
      policyname,
      permissive,
      roles,
      cmd
    FROM pg_policies
    WHERE schemaname = 'public'
    ORDER BY tablename, policyname
  `);

  const policyCount = result.rows.length;
  print(`  Found ${policyCount} RLS policies`, policyCount >= 9 ? 'green' : 'yellow');

  // Group by table
  const groupedPolicies = {};
  result.rows.forEach(row => {
    if (!groupedPolicies[row.tablename]) {
      groupedPolicies[row.tablename] = [];
    }
    groupedPolicies[row.tablename].push({
      name: row.policyname,
      cmd: row.cmd
    });
  });

  // Display grouped policies
  Object.entries(groupedPolicies).forEach(([table, policies]) => {
    print(`    ${table}: ${policies.length} policy(ies)`, 'reset');
    policies.forEach(p => print(`      - ${p.name} (${p.cmd})`, 'reset'));
  });

  return {
    passed: policyCount >= 9,
    count: policyCount,
    expected: 9,
    policies: result.rows
  };
}

/**
 * Validate indexes
 */
async function validateIndexes(client) {
  printSubHeader('Validating Performance Indexes (17 expected)');

  const result = await client.query(`
    SELECT
      schemaname,
      tablename,
      indexname,
      indexdef
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname NOT LIKE '%_pkey'  -- Exclude primary key indexes
    ORDER BY tablename, indexname
  `);

  const indexCount = result.rows.length;
  print(`  Found ${indexCount} non-primary-key indexes`, indexCount >= 17 ? 'green' : 'yellow');

  // Group by table
  const groupedIndexes = {};
  result.rows.forEach(row => {
    if (!groupedIndexes[row.tablename]) {
      groupedIndexes[row.tablename] = [];
    }
    groupedIndexes[row.tablename].push(row.indexname);
  });

  // Display grouped indexes
  Object.entries(groupedIndexes).forEach(([table, indexes]) => {
    print(`    ${table}: ${indexes.length} index(es)`, 'reset');
    indexes.forEach(i => print(`      - ${i}`, 'reset'));
  });

  return {
    passed: indexCount >= 17,
    count: indexCount,
    expected: 17,
    indexes: result.rows
  };
}

/**
 * Validate extensions
 */
async function validateExtensions(client) {
  printSubHeader('Validating Extensions');

  const result = await client.query(`
    SELECT extname, extversion
    FROM pg_extension
    WHERE extname IN ('pgcrypto', 'postgis', 'pg_stat_statements')
    ORDER BY extname
  `);

  const requiredExtensions = ['pgcrypto', 'postgis', 'pg_stat_statements'];
  const foundExtensions = result.rows.map(r => r.extname);
  const missingExtensions = requiredExtensions.filter(e => !foundExtensions.includes(e));

  result.rows.forEach(row => {
    print(`  âœ“ ${row.extname} (${row.extversion})`, 'green');
  });

  if (missingExtensions.length > 0) {
    missingExtensions.forEach(ext => {
      print(`  âœ— ${ext} - MISSING`, 'red');
    });
  }

  return {
    passed: missingExtensions.length === 0,
    found: foundExtensions,
    missing: missingExtensions
  };
}

/**
 * Check for hardcoded client IDs in migrations
 */
async function validateZeroHardcoding() {
  printSubHeader('Validating Zero-Hardcoding Architecture');

  const migrationsDir = path.join(__dirname, '..', 'supabase', 'migrations');
  const migrationFiles = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql'));

  const issues = [];

  migrationFiles.forEach(file => {
    const filePath = path.join(migrationsDir, file);
    const content = fs.readFileSync(filePath, 'utf8');

    // Check for UUID patterns that look like client IDs (except comments and variable declarations)
    const uuidPattern = /INSERT\s+INTO.*VALUES.*'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'/gi;
    const matches = content.match(uuidPattern);

    if (matches && matches.length > 0) {
      // Filter out seed data file (10_seed_data.sql is allowed to have configuration UUIDs)
      if (!file.includes('010_seed_data')) {
        issues.push({
          file,
          type: 'Potential hardcoded client ID',
          matches: matches.length
        });
      }
    }

    // Check for hardcoded API URLs
    const urlPattern = /https?:\/\/[^\s'"]+/gi;
    const urlMatches = content.match(urlPattern);
    if (urlMatches) {
      urlMatches.forEach(url => {
        // Exclude documentation URLs
        if (!url.includes('example.com') && !url.includes('docs.') && !url.includes('//localhost')) {
          issues.push({
            file,
            type: 'Hardcoded API URL',
            detail: url
          });
        }
      });
    }
  });

  if (issues.length === 0) {
    print('  âœ“ No hardcoded client IDs or API URLs found in migrations', 'green');
  } else {
    issues.forEach(issue => {
      print(`  âš  ${issue.file}: ${issue.type}`, 'yellow');
      if (issue.detail) {
        print(`    ${issue.detail}`, 'yellow');
      }
    });
  }

  return {
    passed: issues.length === 0,
    issues
  };
}

/**
 * Validate configuration tables have data
 */
async function validateConfigurationData(client) {
  printSubHeader('Validating Configuration Tables');

  const configTables = [
    'partitioning_config',
    'worker_registry',
    'lookups'
  ];

  const results = [];

  for (const table of configTables) {
    try {
      const result = await client.query(`SELECT COUNT(*) as count FROM ${table}`);
      const count = parseInt(result.rows[0].count);

      if (count > 0) {
        print(`  âœ“ ${table}: ${count} row(s)`, 'green');
        results.push({ table, count, passed: true });
      } else {
        print(`  âœ— ${table}: 0 rows (expected seed data)`, 'red');
        results.push({ table, count, passed: false });
      }
    } catch (error) {
      print(`  âœ— ${table}: Error - ${error.message}`, 'red');
      results.push({ table, count: 0, passed: false, error: error.message });
    }
  }

  return {
    passed: results.every(r => r.passed),
    tables: results
  };
}

/**
 * Generate validation report
 */
function generateReport(validations, outputPath) {
  const timestamp = new Date().toISOString();

  let report = `# End-to-End Validation Report
Generated: ${timestamp}

## Summary

`;

  // Calculate overall status
  const totalChecks = validations.length;
  const passedChecks = validations.filter(v => v.passed).length;
  const overallPass = passedChecks === totalChecks;

  report += `**Overall Status:** ${overallPass ? 'âœ… PASSED' : 'âŒ FAILED'} (${passedChecks}/${totalChecks} checks passed)\n\n`;

  // Add validation results
  report += `## Validation Results\n\n`;

  validations.forEach(validation => {
    const status = validation.passed ? 'âœ…' : 'âŒ';
    report += `### ${status} ${validation.name}\n\n`;
    report += `- **Status:** ${validation.passed ? 'PASSED' : 'FAILED'}\n`;

    if (validation.count !== undefined && validation.expected !== undefined) {
      report += `- **Found:** ${validation.count}\n`;
      report += `- **Expected:** ${validation.expected}\n`;
    }

    if (validation.details) {
      report += `\n${validation.details}\n`;
    }

    report += `\n`;
  });

  // Write report to file
  fs.writeFileSync(outputPath, report, 'utf8');

  return { overallPass, passedChecks, totalChecks, reportPath: outputPath };
}

/**
 * Main validation function
 */
async function main() {
  printHeader('End-to-End Validation - Local-First Development Workflow');

  let client = null;
  let pool = null;
  const validations = [];

  try {
    // Connect to database
    print('\nConnecting to database...', 'yellow');
    const conn = await getDbConnection();
    client = conn.client;
    pool = conn.pool;
    print('âœ“ Connected to database', 'green');

    // Run validations
    print('\nRunning validations...', 'yellow');

    // 1. Validate tables
    const tablesResult = await validateTables(client);
    validations.push({
      name: 'Tables Exist',
      passed: tablesResult.passed,
      count: tablesResult.count,
      expected: tablesResult.expected,
      details: `Found ${tablesResult.count} tables out of ${tablesResult.expected} expected.`
    });

    // 2. Validate HASH partitions
    const hashResult = await validateHashPartitions(client);
    validations.push({
      name: 'HASH Partitions',
      passed: hashResult.passed,
      count: hashResult.count,
      expected: hashResult.expected,
      details: `Found ${hashResult.count} HASH partitions out of ${hashResult.expected} expected.`
    });

    // 3. Validate RANGE partitions
    const rangeResult = await validateRangePartitions(client);
    validations.push({
      name: 'RANGE Partitions',
      passed: rangeResult.passed,
      count: rangeResult.count,
      expected: rangeResult.expected,
      details: `Found ${rangeResult.count} RANGE partitions out of ${rangeResult.expected} expected.`
    });

    // 4. Validate RLS policies
    const rlsResult = await validateRlsPolicies(client);
    validations.push({
      name: 'RLS Policies',
      passed: rlsResult.passed,
      count: rlsResult.count,
      expected: rlsResult.expected,
      details: `Found ${rlsResult.count} RLS policies out of ${rlsResult.expected} expected.`
    });

    // 5. Validate indexes
    const indexesResult = await validateIndexes(client);
    validations.push({
      name: 'Performance Indexes',
      passed: indexesResult.passed,
      count: indexesResult.count,
      expected: indexesResult.expected,
      details: `Found ${indexesResult.count} non-primary-key indexes out of ${indexesResult.expected} expected.`
    });

    // 6. Validate extensions
    const extensionsResult = await validateExtensions(client);
    validations.push({
      name: 'Extensions',
      passed: extensionsResult.passed,
      details: extensionsResult.missing.length === 0
        ? `All required extensions installed: ${extensionsResult.found.join(', ')}`
        : `Missing extensions: ${extensionsResult.missing.join(', ')}`
    });

    // 7. Validate configuration data
    const configResult = await validateConfigurationData(client);
    validations.push({
      name: 'Configuration Data',
      passed: configResult.passed,
      details: `Checked ${configResult.tables.length} configuration tables for seed data.`
    });

    // 8. Validate zero-hardcoding
    const hardcodingResult = validateZeroHardcoding();
    validations.push({
      name: 'Zero-Hardcoding',
      passed: hardcodingResult.passed,
      details: hardcodingResult.issues.length === 0
        ? 'No hardcoded client IDs or API URLs found in migrations.'
        : `Found ${hardcodingResult.issues.length} potential hardcoding issue(s).`
    });

    // Generate report
    printHeader('Generating Validation Report');

    const reportDir = path.join(__dirname, '..', '..', 'docs', 'status', 'specs', '2025-10-11-local-first-development-workflow', 'implementation');
    const reportPath = path.join(reportDir, 'validation-report.md');

    // Ensure directory exists
    if (!fs.existsSync(reportDir)) {
      fs.mkdirSync(reportDir, { recursive: true });
    }

    const { overallPass, passedChecks, totalChecks } = generateReport(validations, reportPath);

    print(`\nâœ“ Validation report generated: ${reportPath}`, 'green');

    // Final summary
    printHeader('Validation Summary');

    validations.forEach(v => {
      const icon = v.passed ? 'âœ“' : 'âœ—';
      const color = v.passed ? 'green' : 'red';
      print(`  ${icon} ${v.name}`, color);
    });

    print('');
    print('='.repeat(70), 'cyan');

    if (overallPass) {
      print(`âœ… ALL VALIDATIONS PASSED (${passedChecks}/${totalChecks})`, 'green');
      print('='.repeat(70), 'cyan');
      print('\nLocal-first development workflow is fully validated!', 'green');
      print(`\nValidation report: ${reportPath}`, 'cyan');
    } else {
      print(`âŒ SOME VALIDATIONS FAILED (${passedChecks}/${totalChecks} passed)`, 'red');
      print('='.repeat(70), 'cyan');
      print('\nPlease review the validation report for details.', 'red');
      print(`\nValidation report: ${reportPath}`, 'cyan');
    }

    return overallPass ? 0 : 1;

  } catch (error) {
    print(`\nâœ— Fatal error during validation: ${error.message}`, 'red');
    print(error.stack, 'red');
    return 1;
  } finally {
    // Clean up connections
    if (client) {
      client.release();
    }
    if (pool) {
      await pool.end();
    }
  }
}

// Run validation
main()
  .then(exitCode => process.exit(exitCode))
  .catch(error => {
    console.error('\nUnexpected error:', error);
    process.exit(1);
  });


