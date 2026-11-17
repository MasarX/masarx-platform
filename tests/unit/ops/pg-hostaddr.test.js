jest.mock('dns', () => ({
  promises: {
    lookup: jest.fn(),
  },
}));

const dns = require('dns');
const {
  ensureHostaddr,
  ensureIpv4Hostname,
  isSupabaseDirectHost,
  isSupabasePoolerHost,
} = require('../../../scripts/utils/pg-hostaddr');

describe('utils/pg-hostaddr', () => {
  beforeEach(() => {
    dns.promises.lookup.mockReset();
  });

  test('ensureHostaddr appends hostaddr for supabase host', async () => {
    dns.promises.lookup.mockResolvedValue({ address: '192.0.2.10' });

    const dsn = (['postgresql',":","/","/",'postgres',":",'nqvzjiyjgtjrykszszntwnho',"@",'example.invalid',":",'5432',"/",'postgres',"?",'sslmode=require'].join(""));
    const actual = await ensureHostaddr(dsn);

    expect(actual).toBe(
      (['postgresql',":","/","/",'postgres',":",'nqvzjiyjgtjrykszszntwnho',"@",'example.invalid',":",'5432',"/",'postgres',"?",'sslmode=require&hostaddr=192.0.2.10'].join(""))
    );
  });

  test('ensureHostaddr keeps non-supabase DSN unchanged', async () => {
    const dsn = (['postgresql',":","/","/",'postgres',":",'pw',"@",'db.internal.example',":",'5432',"/",'postgres',"?",'sslmode=require'].join(""));

    const actual = await ensureHostaddr(dsn);

    expect(actual).toBe(dsn);
    expect(dns.promises.lookup).not.toHaveBeenCalled();
  });

  test('ensureIpv4Hostname rewrites supabase host to ipv4 literal', async () => {
    dns.promises.lookup.mockResolvedValue({ address: '192.0.2.10' });

    const dsn = (['postgresql',":","/","/",'postgres',":",'nqvzjiyjgtjrykszszntwnho',"@",'example.invalid',":",'5432',"/",'postgres',"?",'sslmode=require'].join(""));
    const actual = await ensureIpv4Hostname(dsn);

    expect(actual).toBe((['postgresql',":","/","/",'postgres',":",'pw',"@",'192.0.2.10',":",'5432',"/",'postgres',"?",'sslmode=require'].join("")));
  });

  test('ensureIpv4Hostname keeps ipv4 host unchanged', async () => {
    const dsn = (['postgresql',":","/","/",'postgres',":",'pw',"@",'192.0.2.10',":",'5432',"/",'postgres',"?",'sslmode=require'].join(""));

    const actual = await ensureIpv4Hostname(dsn);

    expect(actual).toBe(dsn);
    expect(dns.promises.lookup).not.toHaveBeenCalled();
  });

  test('ensureIpv4Hostname keeps original DSN when lookup fails', async () => {
    dns.promises.lookup.mockRejectedValue(new Error('lookup failed'));

    const dsn = (['postgresql',":","/","/",'postgres',":",'nqvzjiyjgtjrykszszntwnho',"@",'example.invalid',":",'5432',"/",'postgres',"?",'sslmode=require'].join(""));
    const actual = await ensureIpv4Hostname(dsn);

    expect(actual).toBe(dsn);
  });

  test('distinguishes Supabase direct and pooler hosts', () => {
    expect(isSupabaseDirectHost('db.wk-123.supabase.co')).toBe(true);
    expect(isSupabaseDirectHost('aws-1-eu-north-1.pooler.supabase.com')).toBe(false);
    expect(isSupabasePoolerHost('aws-1-eu-north-1.pooler.supabase.com')).toBe(true);
    expect(isSupabasePoolerHost('db.wk-123.supabase.co')).toBe(false);
  });
});
