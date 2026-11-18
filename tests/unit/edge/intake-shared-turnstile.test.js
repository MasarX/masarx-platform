const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
let verifyMarketingTurnstile;
beforeAll(async () => {
  ({ verifyMarketingTurnstile } = await import(pathToFileURL(path.resolve(__dirname,
    '../../../supabase/functions/_shared/turnstile-local-test.mjs')).href));
});
const valid = {
 token: 'EXAMPLE_PASSWORD', secret: 'EXAMPLE_PASSWORD',
 localContext: true, requestHostname: '127.0.0.1', clientIp: '127.0.0.1',
};
test.each(['127.0.0.1', 'localhost'])('exact local fixture avoids network: %s', async requestHostname => {
 const fetchImpl=jest.fn();
 expect(await verifyMarketingTurnstile({...valid,requestHostname,fetchImpl})).toEqual({
  success:true,hostname:requestHostname,errorCodes:null});
 expect(fetchImpl).not.toHaveBeenCalled();
});
test.each([
 {localContext:false},{localContext:'true'},{requestHostname:'tenant.example'},
 {requestHostname:'localhost.attacker.example'},{token:'different-token'},
 {secret:'different-secret'},
])('every guard independently prevents local admission: %j', async delta => {
 const fetchImpl=jest.fn().mockResolvedValue({json:async()=>({success:false})});
 const result=await verifyMarketingTurnstile({...valid,...delta,fetchImpl});
 expect(result.success).toBe(false);
 expect(fetchImpl).toHaveBeenCalledTimes(1);
 expect(fetchImpl.mock.calls[0][0]).toBe('https://challenges.cloudflare.com/turnstile/v0/siteverify');
 const body=new URLSearchParams(fetchImpl.mock.calls[0][1].body);
 expect(body.get('secret')).toBe(delta.secret||valid.secret);
 expect(body.get('response')).toBe(delta.token||valid.token);
});
test('missing secret fails without network',async()=>{
 const fetchImpl=jest.fn();
 expect((await verifyMarketingTurnstile({...valid,secret:'',fetchImpl})).success).toBe(false);
 expect(fetchImpl).not.toHaveBeenCalled();
});
test('real verifier failure remains rejected',async()=>{
 const fetchImpl=jest.fn().mockRejectedValue(new Error('transport'));
 await expect(verifyMarketingTurnstile({...valid,localContext:false,fetchImpl})).rejects.toThrow('transport');
});
test.each(['tenant','driver'])('%s binds request/CORS-derived context',kind=>{
 const source=fs.readFileSync(path.resolve(__dirname,
  '../../../supabase/functions/'+kind+'-signup-intake/index.ts'),'utf8');
 expect(source).toContain('from "./_shared/turnstile-local-test.mjs"');
 expect(source).toContain('localContext: cors.localContext, requestHostname: new URL(req.url).hostname');
 expect(source).not.toContain('const verifyTurnstile =');
 expect(source).not.toContain('https://challenges.cloudflare.com/turnstile/v0/siteverify');
});
