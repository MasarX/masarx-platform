let rpcMock: jest.Mock;
let serverClientMock: jest.Mock;
jest.mock("react", () => ({ ...jest.requireActual("react"), cache: (fn: unknown) => fn }));
jest.mock("@masarx/auth/server", () => {
  serverClientMock=jest.fn(() => ({}));
  return {createServerClient: (...args: unknown[]) => serverClientMock(...args),getVerifiedAccessToken: jest.fn(async () => ({accessToken:"test-access-token"}))};
});
jest.mock("../../packages/api/src/rpc", () => {
  rpcMock=jest.fn();
  return {createRpc: () => rpcMock};
});
import { createUiServerClient } from "../../packages/api/src/server";
beforeEach(() => {rpcMock.mockReset();serverClientMock.mockClear();});
test("mapPolicy delegates exact supplied verified context to existing resolver", async () => {
  const row={settings_id:"s",settings_version_id:"v",scope_type:"tenant",scope_id:"org",value:{},version:1,scope_path:[]};
  rpcMock.mockResolvedValue([row]);
  const context={organization_id:"org"};
  await expect(createUiServerClient().mapPolicy(context)).resolves.toEqual(row);
  expect(rpcMock).toHaveBeenCalledWith("resolve_map_policy",{p_context:context});
  expect(serverClientMock).toHaveBeenCalledWith({allowCookieSet:false,accessToken:"test-access-token"});
});
test("empty policy returns null without fabricating defaults", async () => {
  rpcMock.mockResolvedValue([]);
  await expect(createUiServerClient().mapPolicy({})).resolves.toBeNull();
});
test.each([null,{},[{},{}],[{}],[null],[[]]])("malformed or ambiguous resolver output fails closed %j", async rows => {
  rpcMock.mockResolvedValue(rows);
  await expect(createUiServerClient().mapPolicy({})).rejects.toThrow("Invalid map policy resolution");
});
test("resolver rejection propagates without raw-settings fallback", async () => {
  rpcMock.mockRejectedValue(new Error("scope denied"));
  await expect(createUiServerClient().mapPolicy({organization_id:"foreign"})).rejects.toThrow("scope denied");
  expect(rpcMock).toHaveBeenCalledTimes(1);
});
test.each([
  {settings_id:""}, {settings_version_id:null}, {scope_type:""}, {scope_id:undefined},
  {value:null}, {value:[]}, {version:0}, {version:1.5}, {scope_path:{}},
])("malformed singleton field fails closed %j", async invalid => {
  const row={settings_id:"s",settings_version_id:"v",scope_type:"tenant",scope_id:"org",value:{},version:1,scope_path:[],...invalid};
  rpcMock.mockResolvedValue([row]);
  await expect(createUiServerClient().mapPolicy({organization_id:"org"})).rejects.toThrow("Invalid map policy resolution");
});
