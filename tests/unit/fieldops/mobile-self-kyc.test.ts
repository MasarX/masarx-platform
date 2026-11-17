import * as fs from "node:fs";
import * as path from "node:path";
import * as ts from "typescript";
import type { UiCommandDefinition } from "@masarx/api";
import { resolveComposerEvidence, buildComposerEvidenceMap, composerRetryArgs,
 normalizeSelfKycFields, validateSelfKycFields } from "../../../apps/fieldops/src/mobile-composer-evidence";
import { getFieldOpsStrings } from "../../../apps/fieldops/src/i18n";
const root = path.resolve(__dirname, "../../..");
const command = (patch: Record<string, unknown> = {}): UiCommandDefinition => ({
 key: "driver_self_kyc.document", label: "Document", execution: {
  idempotency: "actor_retry_v1",
  evidence: {context:"self",registration_rpc:"register_self_kyc_artifact_v1",bucket:"fieldops-evidence",min_items:1,max_items:1},
  ...patch
 }
});
describe("current self KYC composer contract", () => {
 test("task commands do not acquire KYC evidence or retry arguments", () => {
  const task={key:"tasks.complete",label:"Complete"};
  expect(resolveComposerEvidence(task)).toBeNull();
  expect(composerRetryArgs(task,"outbox_1_abc","actor")).toEqual({});
 });
 test.each(["outbox_175000_abcd","8b09c991-deba-4544-a95d-fd03ad959021"])("retains actual outbox TEXT identity %s", id => {
  expect(composerRetryArgs(command(),id,"actor")).toEqual({p_idempotency_key:id,p_expected_actor_user_id:"actor"});
 });
 test("rejects incomplete evidence row configuration", () => {
  expect(resolveComposerEvidence(command({evidence:{context:"self",bucket:"fieldops-evidence"}}))).toBeNull();
 });
 test.each([0,-1,1.5])("rejects invalid max items %s", max => {
  expect(resolveComposerEvidence(command({evidence:{...command().execution!.evidence,max_items:max}}))).toBeNull();
 });
 test("single evidence uses its declared context without selected task data", () => {
  expect(buildComposerEvidenceMap([{artifactId:"a"}],resolveComposerEvidence(command())!)).toEqual({document:"a"});
 });
 test("missing and excess evidence fail before enqueue", () => {
  const context=resolveComposerEvidence(command())!;
  expect(()=>buildComposerEvidenceMap([],context)).toThrow("evidence_count");
  expect(()=>buildComposerEvidenceMap([{artifactId:"a"},{artifactId:"b"}],context)).toThrow("evidence_count");
 });
 test("named photos preserve every angle including safe object property names", () => {
  const context={...resolveComposerEvidence(command())!,maxItems:20,tagField:"angle"};
  const result=buildComposerEvidenceMap([{artifactId:"a",evidenceTag:"front"},{artifactId:"b",evidenceTag:"__proto__"}],context);
  expect(result.front).toBe("a"); expect(Object.getPrototypeOf(result)).toBeNull();
  expect(Object.hasOwn(result,"__proto__")).toBe(true);
  expect(()=>buildComposerEvidenceMap([{artifactId:"a",evidenceTag:"front"},{artifactId:"b",evidenceTag:"front"}],context)).toThrow("evidence_tag");
  expect(()=>buildComposerEvidenceMap([{artifactId:"a"}],context)).toThrow("evidence_tag");
 });
 test.each(["0000","0012","1899","2026"])("registration preserves four digit year %s", year => {
  const value=normalizeSelfKycFields({plate:"ABCDE",vin:"12345678",model:"Van",year});
  expect(value.year).toBe(year); expect(()=>validateSelfKycFields("vehicle_registration",value)).not.toThrow();
 });
 test.each([2026,{},null,"26",""])("invalid registration year %s fails cheaply", year => {
  expect(()=>validateSelfKycFields("vehicle_registration",{plate:"ABCDE",vin:"12345678",model:"Van",year})).toThrow("registration_fields");
 });
 test("standalone cleaning preserves explicit checklist IDs without a vehicle", () => {
  const value=normalizeSelfKycFields({checked_item_ids:" cab, cargo, cab "});
  expect(value).toEqual({checked_item_ids:["cab","cargo"]});
  expect(()=>validateSelfKycFields("cleaning",value)).not.toThrow();
  expect(()=>validateSelfKycFields("cleaning",{checked_item_ids:[1]})).toThrow();
 });
 test.each(["true","false"])("text shift and health %s need no vehicle or clearance", value => {
  const payload=normalizeSelfKycFields({shift_id:"shift-am-01",health_ok:value});
  expect(payload.health_ok).toBe(value==="true"); expect(()=>validateSelfKycFields("pre_shift",payload)).not.toThrow();
 });
 test.each([undefined,1,{},null])("nontext shift %s fails", shift_id => {
  expect(()=>validateSelfKycFields("pre_shift",{shift_id,health_ok:false})).toThrow("preshift");
 });
 test("field correction produces a fresh valid payload", () => {
  const initial={shift_id:"",health_ok:"false"};
  expect(()=>validateSelfKycFields("pre_shift",normalizeSelfKycFields(initial))).toThrow();
  expect(()=>validateSelfKycFields("pre_shift",normalizeSelfKycFields({...initial,shift_id:"next"}))).not.toThrow();
 });
 test.each(["en","ar"] as const)("locale %s contains submitted-not-approved guidance", locale => {
  const strings=getFieldOpsStrings(locale).selfKyc;
  expect(strings.subtitle).toBeTruthy(); expect(strings.invalid).toBeTruthy(); expect(strings.false).toBeTruthy();
 });
 test("actual App parses and isolates selection, task fields, capture and errors", () => {
  const source=fs.readFileSync(path.join(root,"apps/fieldops/App.tsx"),"utf8");
  const parsed=ts.createSourceFile("App.tsx",source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
  expect((parsed as any).parseDiagnostics).toEqual([]);
  expect(source).toContain('command.selection?.mode === "none" ? null : selectedResourceId');
  expect(source).toContain('if (!composerIsSelfKyc && composerCommand.key !== "tasks.report_incident" && activeDriverShift?.opsSessionId)');
  expect(source).toContain('if (!composerIsSelfKyc && composerSignatureArtifact)');
  expect(source).toContain('metadata: composerSelfEvidence ? {} :');
  expect(source).toContain('captureEpoch !== composerCaptureEpoch.current');
  expect(source).toContain('accessibilityLiveRegion="polite"');
 });
 test("SQL source guards remain explicit; native evidence is a separate lane", () => {
  const sql=fs.readFileSync(path.join(root,"supabase/migrations/202609060400_fieldops_self_kyc_submission_v1.sql"),"utf8");
  for(const token of ["user_has_capability_v1","o.owner=auth.uid() FOR UPDATE","SELECT r.artifact_id INTO v_id",
   "'source_system','fieldops_self_kyc'","self_kyc_retry_conflict","self_kyc_reserved_field","self_kyc_text_required",
   "jsonb_typeof(e)<>'string'","public.workflow_run_triggers","public.driver_compliance_events",
   "upsert_settings_value_v1","security_invoker=TRUE","v_year::int>=1900","'submitted',FALSE"])
   expect(sql).toContain(token);
  expect(sql).not.toContain("user_has_permission_v1");
  expect(sql).not.toMatch(/UPDATE\s+public\.settings_versions/i);
  expect(sql).not.toContain("INSERT INTO public.vehicle_assignments");
 });
});
