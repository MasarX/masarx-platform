function supabasePoolerHost(shard, region) {
  return `aws-${shard}-${region}.pooler.supabase.com`;
}

function fixtureHost(surface, domain) {
  return `fixture-${surface}.${domain}`;
}

const DIALOG360_FIXTURE_BASE_URL = `https://${fixtureHost('dialog360', 'example.test')}`;

module.exports = { supabasePoolerHost, fixtureHost, DIALOG360_FIXTURE_BASE_URL };
