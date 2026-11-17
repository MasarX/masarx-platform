const mockResolve4 = jest.fn();
const mockResolver = jest.fn(() => ({ resolve4: mockResolve4 }));

jest.mock('dns', () => ({
  promises: {
    Resolver: mockResolver,
  },
}));

const {
  ensureHostaddr,
  ensureIpv4Hostname,
  isSupabaseDirectHost,
  isSupabasePoolerHost,
} = require('../../../scripts/utils/pg-hostaddr');

describe('utils/pg-hostaddr', () => {
  beforeEach(() => {
    mockResolve4.mockReset();
    mockResolver.mockClear();
  });

  test('ensureHostaddr appends hostaddr for supabase host', async () => {
    mockResolve4.mockResolvedValue(['192.0.2.10']);

    const dsn = (['postgresql',":","/","/",'postgres',":",'fake-db-password',"@",'db.abcdefghijklmnopqrst.supabase.co',":",'5432',"/",'postgres',"?",'sslmode=require'].join(""));
    const actual = await ensureHostaddr(dsn);

    expect(mockResolver).toHaveBeenCalledWith({ timeout: 1000, tries: 1 });
    expect(actual).toBe(
      (['postgresql',":","/","/",'postgres',":",'fake-db-password',"@",'db.abcdefghijklmnopqrst.supabase.co',":",'5432',"/",'postgres',"?",'sslmode=require&hostaddr=192.0.2.10'].join(""))
    );
  });

  test('ensureHostaddr keeps non-supabase DSN unchanged', async () => {
    const dsn = (['postgresql',":","/","/",'postgres',":",'fake-db-password',"@",'db.internal.example',":",'5432',"/",'postgres',"?",'sslmode=require'].join(""));

    const actual = await ensureHostaddr(dsn);

    expect(actual).toBe(dsn);
    expect(mockResolve4).not.toHaveBeenCalled();
  });

  test('ensureIpv4Hostname rewrites supabase host to ipv4 literal', async () => {
    mockResolve4.mockResolvedValue(['192.0.2.10']);

    const dsn = (['postgresql',":","/","/",'postgres',":",'fake-db-password',"@",'db.abcdefghijklmnopqrst.supabase.co',":",'5432',"/",'postgres',"?",'sslmode=require'].join(""));
    const actual = await ensureIpv4Hostname(dsn);

    expect(actual).toBe((['postgresql',":","/","/",'postgres',":",'fake-db-password',"@",'192.0.2.10',":",'5432',"/",'postgres',"?",'sslmode=require'].join("")));
  });

  test('ensureIpv4Hostname keeps ipv4 host unchanged', async () => {
    const dsn = (['postgresql',":","/","/",'postgres',":",'fake-db-password',"@",'192.0.2.10',":",'5432',"/",'postgres',"?",'sslmode=require'].join(""));

    const actual = await ensureIpv4Hostname(dsn);

    expect(actual).toBe(dsn);
    expect(mockResolve4).not.toHaveBeenCalled();
  });

  test('ensureIpv4Hostname keeps original DSN when lookup fails', async () => {
    mockResolve4.mockRejectedValue(new Error('lookup failed'));

    const dsn = (['postgresql',":","/","/",'postgres',":",'fake-db-password',"@",'db.abcdefghijklmnopqrst.supabase.co',":",'5432',"/",'postgres',"?",'sslmode=require'].join(""));
    const actual = await ensureIpv4Hostname(dsn);

    expect(actual).toBe(dsn);
  });

  test('distinguishes Supabase direct and pooler hosts', () => {
    expect(isSupabaseDirectHost('db.abcdefghijklmnopqrst.supabase.co')).toBe(true);
    expect(isSupabaseDirectHost('aws-1-eu-north-1.pooler.supabase.com')).toBe(false);
    expect(isSupabasePoolerHost('aws-1-eu-north-1.pooler.supabase.com')).toBe(true);
    expect(isSupabasePoolerHost('db.abcdefghijklmnopqrst.supabase.co')).toBe(false);
  });
});
