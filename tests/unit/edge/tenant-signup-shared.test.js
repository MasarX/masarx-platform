const fs = require('fs');
const path = require('path');
const ts = require('typescript');

function loadLookup(moduleName) {
  const file = path.resolve(__dirname, `../../../supabase/functions/_shared/${moduleName}.ts`);
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const declarations = source.statements.filter(ts.isVariableStatement)
    .flatMap(statement => [...statement.declarationList.declarations])
    .filter(declaration => ['asString', 'findAuthUserIdByEmail'].includes(declaration.name.text));
  if (moduleName === 'marketplace_signup') {
    const sharedFile = path.resolve(__dirname, '../../../supabase/functions/_shared/tenant_signup.ts');
    const sharedSource = ts.createSourceFile(sharedFile, fs.readFileSync(sharedFile, 'utf8'), ts.ScriptTarget.Latest, true);
    const asString = sharedSource.statements.filter(ts.isVariableStatement)
      .flatMap(statement => [...statement.declarationList.declarations])
      .find(declaration => declaration.name.text === 'asString');
    if (!asString) throw new Error('shared asString declaration unavailable');
    declarations.unshift(asString);
  }
  if (declarations.length !== 2) throw new Error(`${moduleName} lookup declarations unavailable`);
  const compiled = ts.transpileModule(declarations.map(declaration => 'const ' + declaration.getText() + ';').join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  return new Function(compiled + ';return findAuthUserIdByEmail;')();
}

describe.each(['tenant_signup', 'marketplace_signup'])('%s existing Auth user lookup', moduleName => {
  const findAuthUserIdByEmail = loadLookup(moduleName);
  const client = listUsers => ({
    rpc: jest.fn().mockResolvedValue({ data: null, error: null }),
    auth: { admin: { listUsers } },
  });
  const fullPage = Array.from({ length: 200 }, (_, index) => ({ id: String(index), email: `other-${index}@example.test` }));

  test('finds a normalized email after the first 2,000 users', async () => {
    const listUsers = jest.fn(async ({ page }) => ({
      data: { users: page <= 10 ? fullPage : [{ id: 'existing-user', email: 'Person@Example.Test' }] }, error: null,
    }));
    await expect(findAuthUserIdByEmail(client(listUsers), ' person@example.test ')).resolves.toBe('existing-user');
    expect(listUsers).toHaveBeenCalledTimes(11);
    expect(listUsers).toHaveBeenLastCalledWith({ page: 11, perPage: 200 });
  });

  test('returns no match only after the list is exhausted', async () => {
    const listUsers = jest.fn(async ({ page }) => ({ data: { users: page <= 11 ? fullPage : [] }, error: null }));
    await expect(findAuthUserIdByEmail(client(listUsers), 'missing@example.test')).resolves.toBe('');
    expect(listUsers).toHaveBeenCalledTimes(12);
  });

  test('stops on a final partial page', async () => {
    const listUsers = jest.fn().mockResolvedValue({ data: { users: [] }, error: null });
    await expect(findAuthUserIdByEmail(client(listUsers), 'missing@example.test')).resolves.toBe('');
    expect(listUsers).toHaveBeenCalledTimes(1);
  });

  test.each(['lookup unavailable', ''])('propagates a later-page lookup error (%s)', async message => {
    const listUsers = jest.fn(async ({ page }) => page === 1
      ? { data: { users: fullPage }, error: null }
      : { data: null, error: { message } });
    await expect(findAuthUserIdByEmail(client(listUsers), 'person@example.test'))
      .rejects.toThrow(message || `${moduleName}_auth_user_lookup_failed`);
    expect(listUsers).toHaveBeenCalledTimes(2);
  });

  test('does not call Auth for an empty email', async () => {
    const listUsers = jest.fn();
    const service = client(listUsers);
    await expect(findAuthUserIdByEmail(service, ' ')).resolves.toBe('');
    expect(service.rpc).not.toHaveBeenCalled();
    expect(listUsers).not.toHaveBeenCalled();
  });
});

test('tenant signup resolves a normalized match through the RPC without enumerating Auth users', async () => {
  const rpc = jest.fn().mockResolvedValue({ data: 'existing-user', error: null });
  const listUsers = jest.fn();
  const findAuthUserIdByEmail = loadLookup('tenant_signup');
  await expect(findAuthUserIdByEmail({ rpc, auth: { admin: { listUsers } } }, ' Person@Example.Test '))
    .resolves.toBe('existing-user');
  expect(rpc).toHaveBeenCalledWith('tenant_signup_find_auth_user_id_by_email_v1', { p_email: 'person@example.test' });
  expect(listUsers).not.toHaveBeenCalled();
});
