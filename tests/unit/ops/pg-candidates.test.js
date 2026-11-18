const {
  applyPinnedDbSelectionPreference,
  buildDbConnectionCandidates,
  buildPinnedDbSelectionCandidate,
  buildSupabasePoolerHostVariants,
  buildSupabasePoolerPortVariants,
  buildSupabasePoolerUserVariant,
  resolveSelectedPoolerRoute,
} = require('../../../scripts/utils/pg-candidates');

describe('utils/pg-candidates', () => {
  test('builds ipv4host -> hostaddr -> raw ladder per candidate', async () => {
    const rawDsn = (['postgresql',":","/","/",'postgres',":",'fake-db-password',"@",'db.abcdefghijklmnopqrst.supabase.co',":",'5432',"/",'postgres',"?",'sslmode=require'].join(""));
    const ipv4Dsn = (['postgresql',":","/","/",'postgres',":",'pw',"@",'192.0.2.10',":",'5432',"/",'postgres',"?",'sslmode=require'].join(""));
    const hostaddrDsn =
      (['postgresql',":","/","/",'postgres',":",'fake-db-password',"@",'db.abcdefghijklmnopqrst.supabase.co',":",'5432',"/",'postgres',"?",'sslmode=require&hostaddr=192.0.2.10'].join(""));

    const candidates = await buildDbConnectionCandidates(
      [{ name: 'DATABASE_URL', dsn: rawDsn }],
      {
        ensureIpv4HostnameFn: jest.fn(async () => ipv4Dsn),
        ensureHostaddrFn: jest.fn(async () => hostaddrDsn),
      }
    );

    expect(candidates).toEqual([
      { name: 'DATABASE_URL+ipv4host', dsn: ipv4Dsn },
      { name: 'DATABASE_URL+hostaddr', dsn: hostaddrDsn },
      { name: 'DATABASE_URL', dsn: rawDsn },
    ]);
  });

  test('dedupes identical DSNs and keeps one canonical candidate', async () => {
    const rawDsn = (['postgresql',":","/","/",'postgres',":",'fake-db-password',"@",'db.abcdefghijklmnopqrst.supabase.co',":",'5432',"/",'postgres',"?",'sslmode=require'].join(""));

    const candidates = await buildDbConnectionCandidates(
      [{ name: 'DATABASE_URL', dsn: rawDsn }],
      {
        ensureIpv4HostnameFn: jest.fn(async () => rawDsn),
        ensureHostaddrFn: jest.fn(async () => rawDsn),
      }
    );

    expect(candidates).toEqual([{ name: 'DATABASE_URL', dsn: rawDsn }]);
  });

  test('ignores empty candidates and preserves input source order', async () => {
    const dsn1 = (['postgresql',":","/","/",'postgres',":",'fake-first-password',"@",'first.example.invalid',":",'5432',"/",'postgres',"?",'sslmode=require'].join(""));
    const dsn2 = (['postgresql',":","/","/",'postgres',":",'fake-second-password',"@",'second.example.invalid',":",'5432',"/",'postgres',"?",'sslmode=require'].join(""));

    const candidates = await buildDbConnectionCandidates(
      [
        { name: 'DATABASE_URL', dsn: dsn1 },
        { name: 'DATABASE_URL_DIRECT', dsn: '' },
        { name: 'DATABASE_URL_POOLER', dsn: dsn2 },
      ],
      {
        ensureIpv4HostnameFn: jest.fn(async (dsn) => dsn),
        ensureHostaddrFn: jest.fn(async (dsn) => dsn),
      }
    );

    expect(candidates).toEqual([
      { name: 'DATABASE_URL', dsn: dsn1 },
      { name: 'DATABASE_URL_POOLER', dsn: dsn2 },
    ]);
  });

  test('reorders candidates to a previously selected DSN name without requiring the DSN to be re-passed', () => {
    const reordered = applyPinnedDbSelectionPreference(
      [
        { name: 'SYNCED_DB_URL_POOLER+poolerport:6543', dsn: 'postgresql://pooler-6543' },
        { name: 'SYNCED_DB_URL_POOLER+hostaddr', dsn: 'postgresql://pooler-hostaddr' },
        { name: 'SYNCED_DB_URL_DIRECT', dsn: 'postgresql://direct' },
      ],
      {
        DB_SMOKE_SELECTED_DSN_NAME: 'SYNCED_DB_URL_POOLER+hostaddr',
      },
    );

    expect(reordered.map((candidate) => candidate.name)).toEqual([
      'SYNCED_DB_URL_POOLER+hostaddr',
      'SYNCED_DB_URL_POOLER+poolerport:6543',
      'SYNCED_DB_URL_DIRECT',
    ]);
  });

  test('accepts preview env selected DSN metadata as the pinned candidate source', () => {
    const env = {
      DATABASE_URL: 'postgresql://preview-hostaddr',
      DATABASE_URL_SELECTED_DSN_NAME: 'DATABASE_URL_POOLER+hostaddr',
    };

    expect(buildPinnedDbSelectionCandidate(env)).toEqual({
      name: 'DATABASE_URL_POOLER+hostaddr',
      dsn: 'postgresql://preview-hostaddr',
    });

    const reordered = applyPinnedDbSelectionPreference(
      [
        { name: 'DATABASE_URL_POOLER', dsn: 'postgresql://raw-pooler' },
        { name: 'DATABASE_URL_POOLER+hostaddr', dsn: 'postgresql://preview-hostaddr' },
        { name: 'DATABASE_URL_DIRECT', dsn: 'postgresql://direct' },
      ],
      env,
    );

    expect(reordered.map((candidate) => candidate.name)).toEqual([
      'DATABASE_URL_POOLER+hostaddr',
      'DATABASE_URL_POOLER',
      'DATABASE_URL_DIRECT',
    ]);
  });

  test('adds Supabase pooler shard-host variants after standard ladder', async () => {
    const dsn =
      (['postgresql',":","/","/",'postgres.abcdefghijklmnopqrst',":",'fake-pooler-password',"@",'aws-1-us-east-1.pooler.supabase.com',":",'5432',"/",'postgres',"?",'sslmode=require'].join(""));
    const prevProjectRef = process.env.SUPABASE_PROJECT_ID;
    delete process.env.SUPABASE_PROJECT_ID;

    try {
      const candidates = await buildDbConnectionCandidates(
        [{ name: 'DATABASE_URL', dsn }],
        {
          ensureIpv4HostnameFn: jest.fn(async (value) => value),
          ensureHostaddrFn: jest.fn(async (value) => value),
        }
      );

      expect(candidates).toEqual([
        { name: 'DATABASE_URL', dsn },
        {
          name: 'DATABASE_URL+poolerhost:aws-0',
          dsn: (['postgresql',":","/","/",'postgres.abcdefghijklmnopqrst',":",'fake-pooler-password',"@",'aws-0-us-east-1.pooler.supabase.com',":",'5432',"/",'postgres',"?",'sslmode=require'].join("")),
        },
        {
          name: 'DATABASE_URL+poolerhost:aws-0+poolerport:6543',
          dsn: (['postgresql',":","/","/",'postgres.abcdefghijklmnopqrst',":",'fake-pooler-password',"@",'aws-0-us-east-1.pooler.supabase.com',":",'6543',"/",'postgres',"?",'sslmode=require'].join("")),
        },
        {
          name: 'DATABASE_URL+poolerport:6543',
          dsn: (['postgresql',":","/","/",'postgres.abcdefghijklmnopqrst',":",'fake-pooler-password',"@",'aws-1-us-east-1.pooler.supabase.com',":",'6543',"/",'postgres',"?",'sslmode=require'].join("")),
        },
      ]);
    } finally {
      if (prevProjectRef === undefined) delete process.env.SUPABASE_PROJECT_ID;
      else process.env.SUPABASE_PROJECT_ID = prevProjectRef;
    }
  });

  test('pooler host variant helper ignores non-supabase pooler hosts', () => {
    expect(
      buildSupabasePoolerHostVariants(
        (['postgresql',":","/","/",'postgres',":",'fake-db-password',"@",'db.abcdefghijklmnopqrst.supabase.co',":",'5432',"/",'postgres',"?",'sslmode=require'].join("")),
      ),
    ).toEqual([]);
  });

  test('pooler host variant helper prefers paired shard index fallback', () => {
    expect(
      buildSupabasePoolerHostVariants(
        (['postgresql',":","/","/",'postgres.abcdefghijklmnopqrst',":",'fake-pooler-password',"@",'aws-0-us-east-1.pooler.supabase.com',":",'5432',"/",'postgres',"?",'sslmode=require'].join("")),
      ),
    ).toEqual([
      {
        nameSuffix: 'poolerhost:aws-1',
        dsn: (['postgresql',":","/","/",'postgres.abcdefghijklmnopqrst',":",'fake-pooler-password',"@",'aws-1-us-east-1.pooler.supabase.com',":",'5432',"/",'postgres',"?",'sslmode=require'].join("")),
      },
    ]);
  });

  test('pooler host variants drop stale hostaddr and add only a freshly resolved hostaddr', async () => {
    const staleDsn =
      (['postgresql',":","/","/",'postgres.abcdefghijklmnopqrst',":",'fake-pooler-password',"@",'aws-1-us-east-1.pooler.supabase.com',":",'5432',"/",'postgres',"?",'sslmode=require&hostaddr=192.0.2.10'].join(""));
    const candidates = await buildDbConnectionCandidates(
      [{ name: 'DATABASE_URL', dsn: staleDsn }],
      {
        ensureIpv4HostnameFn: jest.fn(async (value) => value),
        ensureHostaddrFn: jest.fn(async (value) => {
          const parsed = new URL(value);
          if (parsed.hostname !== 'aws-0-us-east-1.pooler.supabase.com') return value;
          parsed.searchParams.set('hostaddr', '192.0.2.20');
          return parsed.toString();
        }),
      },
    );

    const rewritten = candidates.filter((candidate) => candidate.name.includes('poolerhost:aws-0'));
    expect(rewritten).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'DATABASE_URL+poolerhost:aws-0',
        dsn: expect.stringContaining('aws-0-us-east-1.pooler.supabase.com'),
      }),
      expect.objectContaining({
        name: 'DATABASE_URL+poolerhost:aws-0+hostaddr',
        dsn: expect.stringContaining('hostaddr=192.0.2.20'),
      }),
    ]));
    expect(rewritten.some((candidate) => candidate.dsn.includes('hostaddr=192.0.2.10'))).toBe(false);
  });

  test('resolves a logical shard host from a selected ipv4 pooler candidate', () => {
    expect(resolveSelectedPoolerRoute({
      connectionString: (['postgresql',":","/","/",'postgres.abcdefghijklmnopqrst',":",'pw',"@",'192.0.2.10',":",'5432',"/",'postgres'].join("")),
      candidateName: 'DATABASE_URL_POOLER+poolerhost:aws-0+ipv4host',
      fallbackHost: 'aws-1-us-east-1.pooler.supabase.com',
      fallbackPort: '5432',
      fallbackUser: 'postgres.abcdefghijklmnopqrst',
    })).toEqual({
      candidateName: 'DATABASE_URL_POOLER+poolerhost:aws-0+ipv4host',
      host: 'aws-0-us-east-1.pooler.supabase.com',
      port: '5432',
      user: 'postgres.abcdefghijklmnopqrst',
    });
  });

  test('preserves canonical pooler metadata when a direct database candidate wins readiness', () => {
    expect(resolveSelectedPoolerRoute({
      connectionString: (['postgresql',":","/","/",'postgres',":",'fake-db-password',"@",'db.abcdefghijklmnopqrst.supabase.co',":",'5432',"/",'postgres'].join("")),
      candidateName: 'DATABASE_URL_DIRECT',
      fallbackHost: 'aws-1-us-east-1.pooler.supabase.com',
      fallbackPort: '6543',
      fallbackUser: 'postgres.abcdefghijklmnopqrst',
    })).toEqual({
      candidateName: 'DATABASE_URL_DIRECT',
      host: '',
      port: '6543',
      user: 'postgres.abcdefghijklmnopqrst',
    });
  });

  test('pooler port variant helper toggles between transaction and session ports', () => {
    expect(
      buildSupabasePoolerPortVariants(
        (['postgresql',":","/","/",'postgres.abcdefghijklmnopqrst',":",'fake-pooler-password',"@",'aws-1-us-east-1.pooler.supabase.com',":",'5432',"/",'postgres',"?",'sslmode=require'].join("")),
      ),
    ).toEqual([
      {
        nameSuffix: 'poolerport:6543',
        dsn: (['postgresql',":","/","/",'postgres.abcdefghijklmnopqrst',":",'fake-pooler-password',"@",'aws-1-us-east-1.pooler.supabase.com',":",'6543',"/",'postgres',"?",'sslmode=require'].join("")),
      },
    ]);

    expect(
      buildSupabasePoolerPortVariants(
        (['postgresql',":","/","/",'postgres.abcdefghijklmnopqrst',":",'fake-pooler-password',"@",'aws-1-us-east-1.pooler.supabase.com',":",'6543',"/",'postgres',"?",'sslmode=require'].join("")),
      ),
    ).toEqual([
      {
        nameSuffix: 'poolerport:5432',
        dsn: (['postgresql',":","/","/",'postgres.abcdefghijklmnopqrst',":",'fake-pooler-password',"@",'aws-1-us-east-1.pooler.supabase.com',":",'5432',"/",'postgres',"?",'sslmode=require'].join("")),
      },
    ]);
  });

  test('pooler user variant helper normalizes bare postgres user for Supabase pooler hosts', () => {
    expect(
      buildSupabasePoolerUserVariant(
        (['postgresql',":","/","/",'postgres',":",'fake-pooler-password',"@",'aws-1-us-east-1.pooler.supabase.com',":",'5432',"/",'postgres',"?",'sslmode=require'].join("")),
        { projectRef: 'abcdefghijklmnopqrst' },
      ),
    ).toEqual({
      nameSuffix: 'pooleruser',
      dsn: (['postgresql',":","/","/",'postgres.abcdefghijklmnopqrst',":",'fake-pooler-password',"@",'aws-1-us-east-1.pooler.supabase.com',":",'5432',"/",'postgres',"?",'sslmode=require'].join("")),
    });
  });

  test('prefers pooler-user-normalized ladder when project ref is known', async () => {
    const dsn = (['postgresql',":","/","/",'postgres',":",'fake-pooler-password',"@",'aws-1-us-east-1.pooler.supabase.com',":",'5432',"/",'postgres',"?",'sslmode=require'].join(""));
    const candidates = await buildDbConnectionCandidates(
      [{ name: 'DATABASE_URL', dsn }],
      {
        projectRef: 'abcdefghijklmnopqrst',
        ensureIpv4HostnameFn: jest.fn(async (value) => value),
        ensureHostaddrFn: jest.fn(async (value) => value),
      },
    );
    expect(candidates).toEqual([
      {
        name: 'DATABASE_URL+pooleruser',
        dsn: (['postgresql',":","/","/",'postgres.abcdefghijklmnopqrst',":",'fake-pooler-password',"@",'aws-1-us-east-1.pooler.supabase.com',":",'5432',"/",'postgres',"?",'sslmode=require'].join("")),
      },
      {
        name: 'DATABASE_URL+pooleruser+poolerhost:aws-0',
        dsn: (['postgresql',":","/","/",'postgres.abcdefghijklmnopqrst',":",'fake-pooler-password',"@",'aws-0-us-east-1.pooler.supabase.com',":",'5432',"/",'postgres',"?",'sslmode=require'].join("")),
      },
      {
        name: 'DATABASE_URL+pooleruser+poolerhost:aws-0+poolerport:6543',
        dsn: (['postgresql',":","/","/",'postgres.abcdefghijklmnopqrst',":",'fake-pooler-password',"@",'aws-0-us-east-1.pooler.supabase.com',":",'6543',"/",'postgres',"?",'sslmode=require'].join("")),
      },
      {
        name: 'DATABASE_URL+pooleruser+poolerport:6543',
        dsn: (['postgresql',":","/","/",'postgres.abcdefghijklmnopqrst',":",'fake-pooler-password',"@",'aws-1-us-east-1.pooler.supabase.com',":",'6543',"/",'postgres',"?",'sslmode=require'].join("")),
      },
      { name: 'DATABASE_URL', dsn },
    ]);
  });
});
