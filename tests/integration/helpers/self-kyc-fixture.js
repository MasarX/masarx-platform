const {randomUUID,randomBytes}=require('crypto');
const {createClient}=require('@supabase/supabase-js');
const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PkS9GQAAAABJRU5ErkJggg==','base64');
// Two actual native/browser consumers share fixture creation, not a new lifecycle.
function createSelfKycFixture({proof,fixtures,base,adminKey,anonKey,normalizeDisplayPolicy}) {
 const {query,begin,end,record}=proof;
 base=proof.assertApiConnectionIdentity(base,proof.authority.apiPort);
function client(state,key,token) {
 proof.revalidate(); proof.operationTimeoutMs(state);
 return createClient(base,key,{db:{schema:'api'},auth:{persistSession:false,autoRefreshToken:false},
  global:{...(token?{headers:{Authorization:'Bearer '+token}}:{}),
   fetch:(url,options)=>fetch(url,{...options,signal:AbortSignal.timeout(proof.operationTimeoutMs(state))})}});
}
async function network(state,f,event,run) {
 proof.operationTimeoutMs(state); proof.revalidate();
 record({event:event+'-intent',userId:f?.id,organizationId:f?.org});
 let definiteRejection=false;
 try {
  const result=await run();
  if(result.error){
   const status=Number(result.error.status||result.status),code=String(result.error.code||'');
   definiteRejection=code!=='40003' && ((status>=400&&status<500&&status!==408&&status!==499)||/^(22|23)/.test(code)||code==='42501');
   if(definiteRejection)record({event:event+'-rejected',userId:f?.id,code:code||String(status)});
   throw result.error;
  }
  return result.data;
 }catch(error){
  if(!definiteRejection){if(f)f.uncertain=true;record({event:event+'-outcome-unknown',userId:f?.id,organizationId:f?.org});}
  throw error;
 }
}
async function fixture(state,org,options={}) {
 if(options.locale!==undefined&&!['en','ar'].includes(options.locale))throw Error('Unsupported owned fixture locale');
 if(options.locale!==undefined&&typeof normalizeDisplayPolicy!=='function')throw Error('Canonical display policy normalizer required');
 const f={id:randomUUID(),org:org||randomUUID(),email:'r15-'+randomUUID()+'@example.test',objects:[],submissions:[]};
 fixtures.push(f); record({event:'fixture-intent',userId:f.id,organizationId:f.org});
 if(!org)await query(state,'INSERT INTO public.organizations(id,name,slug) VALUES($1,$2,$3)',
 [f.org,'Self KYC owned proof','r15-'+f.org]);
 await end(state,'COMMIT');
 const password='R15!'+randomBytes(20).toString('hex');
 // Auth account ID is recorded before any network mutation and never printed with credentials.
 const data=await network(state,f,'auth-create',()=>client(state,adminKey).auth.admin.createUser({
  id:f.id,email:f.email,password,email_confirm:true}));
 if(data?.user?.id!==f.id)throw Error('Owned auth user identity mismatch');
 await begin(state);
 await query(state,`INSERT INTO public.users(id,organization_id,email,full_name,user_type,status,access_scope_type,access_scope_id)
 VALUES($1,$2,$3,'R15 owned driver','driver','active','tenant',NULL)
 ON CONFLICT(id) DO UPDATE SET organization_id=EXCLUDED.organization_id,user_type='driver',
 status='active',access_scope_type='tenant',access_scope_id=EXCLUDED.access_scope_id`,[f.id,f.org,f.email]);
 await query(state,`SELECT public.upsert_settings_value_v1('access_control_policy','tenant',$1,
 '{"capabilities":[{"key":"kyc.write"}],"roles":[{"key":"driver","capability_keys":["kyc.write"]}],
 "assignments":{"user_type":{"driver":["driver"]}}}'::jsonb,1,'Owned self KYC policy-only fixture')`,[f.org]);
 const currentMobile=(await query(state,`SELECT p.value,
  (SELECT version FROM public.schema_registry WHERE category='mobile_shell_policy' AND is_active
   ORDER BY version DESC LIMIT 1) schema_version
  FROM public.resolve_mobile_shell_policy(jsonb_build_object('organization_id',$1::uuid)) p
  LIMIT 1`,[f.org])).rows[0];
 if(!currentMobile?.value||typeof currentMobile.value!=='object'||Array.isArray(currentMobile.value)||
  !Number.isInteger(currentMobile.schema_version)||currentMobile.schema_version<1){
  throw Error('Resolved mobile shell policy and active schema required');
 }
 await query(state,`SELECT public.upsert_settings_value_v1(
  'mobile_shell_policy','tenant',$1::uuid,$2::jsonb,$3::int,'Owned self KYC mobile V2 fixture'
 )`,[f.org,JSON.stringify({...currentMobile.value,v2_enabled:true}),currentMobile.schema_version]);
 const resolvedMobile=(await query(state,`SELECT p.scope_type,p.scope_id::text,p.value
  FROM public.resolve_mobile_shell_policy(jsonb_build_object('organization_id',$1::uuid)) p
  LIMIT 1`,[f.org])).rows[0];
 if(resolvedMobile?.scope_type!=='tenant'||resolvedMobile.scope_id!==f.org||
  resolvedMobile.value?.v2_enabled!==true)throw Error('Exact tenant mobile shell policy readback failed');
 if(options.locale!==undefined){
  const config=(await query(state,`SELECT p.value,
   (SELECT version FROM public.schema_registry WHERE category='device_policy' AND is_active ORDER BY version DESC LIMIT 1) schema_version
   FROM public.resolve_device_policy(jsonb_build_object('organization_id',$1::uuid)) p`,[f.org])).rows[0];
  if(!config?.value||typeof config.value!=='object'||Array.isArray(config.value)||
   !Number.isInteger(config.schema_version)||config.schema_version<1)throw Error('Resolved device policy and active schema required');
  const normalized=normalizeDisplayPolicy(config.value);
  if(!normalized.allowedLocales.includes(options.locale))throw Error('Requested locale must already be allowed by device policy');
  const display=config.value.display&&typeof config.value.display==='object'&&!Array.isArray(config.value.display)
   ?config.value.display:{};
  await query(state,"SELECT public.upsert_settings_value_v1('device_policy','tenant',$1,$2,$3,'Owned browser locale fixture')",
   [f.org,JSON.stringify({...config.value,display:{...display,default_locale:options.locale}}),config.schema_version]);
 }
 await end(state,'COMMIT');
 const signed=await network(state,f,'auth-signin',()=>client(state,anonKey).auth.signInWithPassword({email:f.email,password}));
 f.session=signed?.session;f.token=signed?.session?.access_token;if(!f.token)throw Error('Owned driver session unavailable');
 await begin(state);return f;
}
async function asActor(state,f) {
 await query(state,'RESET ROLE');
 await query(state,"SELECT set_config('request.jwt.claims',$1,true)",[JSON.stringify({role:'authenticated',sub:f.id,organization_id:f.org})]);
 await query(state,'SET LOCAL ROLE authenticated');
}
async function asAdmin(state) {
 await query(state,'RESET ROLE');
 await query(state,`SELECT set_config('request.jwt.claims','{"role":"service_role"}',true)`);
}
async function evidence(state,f) {
 const key=f.org+'/'+f.id+'/'+randomUUID()+'.png';f.objects.push(key);
 record({event:'owned-object-intent',userId:f.id,bucket:'fieldops-evidence',key});
 const data=await network(state,f,'storage-upload',()=>client(state,anonKey,f.token).storage.from('fieldops-evidence')
 .upload(key,PNG,{upsert:false,contentType:'image/png'}));
 if(data?.path!==key){f.uncertain=true;throw Error('Upload settlement was not confirmed');}
 await asActor(state,f);
 const result=(await query(state,'SELECT * FROM api.register_self_kyc_artifact_v1($1)',
 [JSON.stringify({storage_bucket:'fieldops-evidence',storage_key:key})])).rows[0];
 if(!result?.artifact_id)throw Error('Artifact registration missing');
 await end(state,'COMMIT');await begin(state);return {id:result.artifact_id,key};
}
 return {create:fixture,evidence,asActor,asAdmin,client,network};
}
module.exports={createSelfKycFixture};
