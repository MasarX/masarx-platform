import type { UiCommandInputSchema } from '@masarx/api';

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue => value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

export function financialEvidenceContract(value: unknown): boolean {
  const x=record(value);
  return x.version===1 && x.supervisor_name==='optional_annotation'
    && x.photo_artifact_id==='optional_owned_task_photo'
    && Object.keys(x).length===3;
}
type FinancialEvidenceInput = { supervisorName?: string; photoArtifactId?: string };

export type FinancialTaskContext = {
  version: 1; actor_id: string; organization_id: string; task_id: string;
  task_type_key: string; settlement_id: string; task_status: string;
  evidence_contract?: unknown;
  requires_session: boolean; required_session_type: string | null;
  sessions: { id: string; session_type: string; branch_id: string | null; opened_at: string }[];
};

// Called only for the financial variant after a successful fresh authenticated context query.
// Error/stale cached data must never be passed by the App admission condition.
export function parseFinancialTaskContext(value: unknown, actorId: string, organizationId: string, taskId: string): FinancialTaskContext | null {
  const x=record(value), amount=record(x.amount_contract);
  if(x.version!==1 || x.actor_id!==actorId || x.organization_id!==organizationId || x.task_id!==taskId
    || ![actorId,organizationId,taskId,x.task_type_key,x.settlement_id,x.task_status].every(text)
    || typeof x.requires_session!=='boolean' || (x.requires_session && !text(x.required_session_type))
    || amount.version!==1 || amount.field!=='amount' || amount.minimum!==0 || !Array.isArray(x.sessions)) return null;
  if(x.evidence_contract!=null && !financialEvidenceContract(x.evidence_contract)) return null;
  const sessions: FinancialTaskContext['sessions']=[];
  const ids=new Set<string>();
  for(const raw of x.sessions){
    const s=record(raw);
    if(!text(s.id) || ids.has(s.id) || !text(s.session_type) || s.session_type.toLowerCase()!==x.required_session_type
      || (s.branch_id!==null && !text(s.branch_id)) || !text(s.opened_at)) return null;
    ids.add(s.id);
    sessions.push({id:s.id,session_type:s.session_type as string,branch_id:s.branch_id as string|null,opened_at:s.opened_at});
  }
  return {version:1,actor_id:actorId,organization_id:organizationId,task_id:taskId,
    task_type_key:x.task_type_key as string,settlement_id:x.settlement_id as string,
    task_status:x.task_status as string,requires_session:x.requires_session,
    required_session_type:text(x.required_session_type)?x.required_session_type:null,sessions,
    ...(x.evidence_contract!=null ? {evidence_contract:x.evidence_contract} : {})};
}

export function resolveFinancialTaskSchema(schema: UiCommandInputSchema, context: FinancialTaskContext): UiCommandInputSchema | null {
  const overrides=record(record(schema).task_type_overrides);
  const variant=record(overrides[context.task_type_key]);
  const supportsEvidence=financialEvidenceContract(context.evidence_contract);
  if(supportsEvidence ? !financialEvidenceContract(variant.evidence_contract) : variant.evidence_contract!=null) return null;
  if(variant.normalization!=='financial_amount_v1' || !Array.isArray(variant.fields)
    || variant.fields.length!==(supportsEvidence ? 2 : 1)) return null;
  const field=record(variant.fields[0]);
  if(field.key!=='amount' || field.type!=='number' || field.required!==true || !text(field.label)) return null;
  const annotation=record(variant.fields[1]);
  if(supportsEvidence && (annotation.key!=='supervisor_name' || annotation.type!=='text'
    || annotation.required!==false || !text(annotation.label))) return null;
  if(!text(variant.title) || !text(variant.description)) return null;
  // Only whitelisted schema fields: no RPC/session policy can be injected via variant.
  return {version:1,title:variant.title,description:variant.description,normalization:'financial_amount_v1',
    fields:[{key:'amount',label:field.label,type:'number',required:true},
      ...(supportsEvidence ? [{key:'supervisor_name',label:annotation.label as string,type:'text' as const,required:false}] : [])]};
}

export function financialTaskPayload(amountText: string, selectedSessionId: string, context: FinancialTaskContext, evidence: FinancialEvidenceInput = {}) {
  if(!amountText.trim()) throw new Error('Financial amount is required.');
  const amount=Number(amountText);
  if(!Number.isFinite(amount) || amount<0) throw new Error('Financial amount must be a nonnegative number.');
  const supervisor_name=evidence.supervisorName?.trim();
  const photo_artifact_id=evidence.photoArtifactId?.trim();
  if((supervisor_name || photo_artifact_id) && !financialEvidenceContract(context.evidence_contract))
    throw new Error('Optional financial evidence is unavailable.');
  const payload: {amount:number;ops_session_id?:string;supervisor_name?:string;photo_artifact_id?:string}={amount};
  if(context.requires_session){
    if(!context.sessions.some(s=>s.id===selectedSessionId)) throw new Error('Verified operational session is required.');
    payload.ops_session_id=selectedSessionId;
  }
  if(supervisor_name) payload.supervisor_name=supervisor_name;
  if(photo_artifact_id) payload.photo_artifact_id=photo_artifact_id;
  return payload;
}

export function financialCompletionExpectation(value: unknown): (RecordValue & { action: 'tasks.complete' }) | null {
  const x=record(value);
  if(x.kind!=='financial_amount_v1' || x.action!=='tasks.complete'
    || ![x.taskId,x.settlementId].every(text)
    || !((x.opsSessionId===null && x.sessionType===null) || (text(x.opsSessionId) && text(x.sessionType)))
    || typeof x.amount!=='number' || !Number.isFinite(x.amount) || x.amount<0) return null;
  if((x.supervisorName!==undefined && !text(x.supervisorName))
    || (x.photoArtifactId!==undefined && !text(x.photoArtifactId))) return null;
  return {kind:'financial_amount_v1',action:'tasks.complete',taskId:x.taskId,
    settlementId:x.settlementId,opsSessionId:x.opsSessionId,sessionType:x.sessionType,amount:x.amount,
    ...(x.supervisorName!==undefined ? {supervisorName:x.supervisorName} : {}),
    ...(x.photoArtifactId!==undefined ? {photoArtifactId:x.photoArtifactId} : {})};
}

export function financialReadbackMatches(expected: unknown, value: unknown): boolean {
  const e=record(expected),valid=financialCompletionExpectation(e),r=record(value);
  return Boolean(valid && text(e.taskEventId) && text(e.taskStatus) && text(e.actorId)
    && text(e.organizationId) && r.version===1 && r.actor_id===e.actorId
    && r.organization_id===e.organizationId && r.task_id===e.taskId
    && r.task_event_id===e.taskEventId && r.task_status===e.taskStatus
    && r.event_status==='completed' && r.settlement_id===e.settlementId
    && r.ops_session_id===e.opsSessionId && r.session_type===e.sessionType
    && (r.supervisor_name ?? undefined)===valid.supervisorName
    && (r.photo_artifact_id ?? undefined)===valid.photoArtifactId
    && typeof r.amount==='number' && r.amount===e.amount && text(r.settlement_status));
}
