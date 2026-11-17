"use client";
import * as React from "react";
import { useTranslations } from "next-intl";
import { createBrowserClient } from "@masarx/auth/browser";
import { createUiClient, type StudioTestStatus } from "@masarx/api";
import { Button } from "../button";
import { Section } from "../section";

type Props = { sourceId: string; payloadText: string; savedRevision: number;
  onEligibilityChange: (value: boolean | undefined) => void; appBasePath: string };
const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
export function MappingTestPanel({sourceId,payloadText,savedRevision,onEligibilityChange,appBasePath}: Props) {
  const t=useTranslations("ui.mappingStudioTest");
  const ui=React.useMemo(()=>createUiClient(),[]);
  const auth=React.useMemo(()=>createBrowserClient().auth,[]);
  const [authority,setAuthority]=React.useState<string|null>(null);
  const generation=React.useRef(0);
  const [enabled,setEnabled]=React.useState(false);
  const [ready,setReady]=React.useState(false);
  const [busy,setBusy]=React.useState(false);
  const [attempt,setAttempt]=React.useState<string|null>(null);
  const [state,setState]=React.useState("checking");
  const [result,setResult]=React.useState<StudioTestStatus|null>(null);
  const alive=React.useRef(true);
  const locked=React.useRef(false);
  React.useEffect(()=>{
    alive.current=true;
    let current: string|null|undefined;
    const {data:{subscription}}=auth.onAuthStateChange((_event,session)=>{
      let next: string|null=null;
      try {
        if(session){
          // JWT claims only partition UI state; server authorization remains authoritative.
          const payloadPart=session.access_token.split(".")[1];
          if(!payloadPart)throw new Error();
          const claims=JSON.parse(atob(payloadPart.replace(/-/g,"+").replace(/_/g,"/")));
          if(claims.sub!==session.user.id || typeof claims.session_id!=="string")throw new Error();
          delete claims.iat;delete claims.exp;delete claims.nbf;delete claims.jti;
          const stable=(value: unknown): unknown=>Array.isArray(value)?value.map(stable):
            value && typeof value==="object"?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,stable(v)])):value;
          next=JSON.stringify(stable(claims));
        }
      }catch{next=null;}
      if(next===current)return;
      current=next;generation.current+=1;
      locked.current=false;setBusy(false);setAttempt(null);setResult(null);
      onEligibilityChange(undefined);
      setEnabled(false);setReady(false);setState(next?"checking":"notEnabled");setAuthority(next);
    });
    return ()=>{alive.current=false;generation.current+=1;subscription.unsubscribe();};
  },[auth,onEligibilityChange]);
  React.useEffect(()=>{
    if(attempt || !authority)return;
    let cancelled=false;
    const issuedGeneration=generation.current;
    setReady(false);setState("checking");
    void ui.mappingStudio.testStatus({source_id:sourceId,external_id:crypto.randomUUID()}).then(data=>{
      if(cancelled || generation.current!==issuedGeneration)return;
      const accepted=data.ok===true && data.source_id===sourceId && data.state==="pending";
      setReady(accepted);setEnabled(accepted);setState(accepted?"ready":"notEnabled");
    }).catch(()=>{if(!cancelled && generation.current===issuedGeneration)setState("notEnabled");});
    return ()=>{cancelled=true;};
  },[sourceId,savedRevision,ui,attempt,authority]);
  async function refresh(eventId: string, issuedGeneration: number) {
    setResult(null);
    const data=await ui.mappingStudio.testStatus({source_id:sourceId,external_id:eventId});
    if(!alive.current || generation.current!==issuedGeneration)return;
    if(data.ok!==true || data.source_id!==sourceId || data.external_id!==eventId
      || !["pending","failed","succeeded"].includes(data.state)
      || (data.state==="succeeded" && (!uuid(data.inbox_id)||!uuid(data.shipment_id)||!uuid(data.workflow_run_id)
        ||!uuid(data.workflow_run_step_id)||!data.decision_log_ids?.length||!data.decision_log_ids.every(uuid)))) {
      setState("unavailable");return;
    }
    setResult(data);setState(data.state);
  }
  async function send() {
    if(locked.current || !ready || !authority || attempt)return;
    const issuedGeneration=generation.current;
    let payload: Record<string,unknown>;
    try {
      const parsed=JSON.parse(payloadText);
      if(!parsed || typeof parsed!=="object" || Array.isArray(parsed)
        || !parsed.event || typeof parsed.event!=="object" || Array.isArray(parsed.event))throw new Error();
      payload=parsed;
    }catch{setState("invalidPayload");return;}
    const eventId=crypto.randomUUID();
    payload={...payload,event:{...(payload.event as Record<string,unknown>),id:eventId}};
    locked.current=true;setBusy(true);setAttempt(eventId);setState("sending");
    try {
      const response=await ui.mappingStudio.testRequest({source_id:sourceId,payload});
      if(!alive.current || generation.current!==issuedGeneration)return;
      if(response.ok!==true || response.accepted!==true || response.source_id!==sourceId || response.external_id!==eventId){setState("unknown");return;}
      setState("pending");await refresh(eventId,issuedGeneration);
    }catch{if(alive.current && generation.current===issuedGeneration)setState("unknown");}
    finally{if(alive.current && generation.current===issuedGeneration){locked.current=false;setBusy(false);}}
  }
  async function check() {
    if(!attempt || locked.current || !authority)return;
    const issuedGeneration=generation.current;
    locked.current=true;setBusy(true);
    try{await refresh(attempt,issuedGeneration);}catch{if(alive.current && generation.current===issuedGeneration)setState("unavailable");}
    finally{if(alive.current && generation.current===issuedGeneration){locked.current=false;setBusy(false);}}
  }
  return <Section title={t("title")} collapsible={false}>
    <p className="text-sm text-ui-muted">{t("help")}</p>
    <p className="break-all text-sm"><span>{t("source")}: </span><bdi>{sourceId}</bdi></p>
    <label className="flex items-center gap-2 py-3">
      <input type="checkbox" checked={enabled} disabled={state==="checking"||busy||Boolean(attempt)} onChange={event=>{
        setEnabled(event.target.checked);setReady(false);setState("saveRequired");onEligibilityChange(event.target.checked);
      }}/><span>{t("enable")}</span>
    </label>
    <div className="flex flex-wrap gap-2">
      <Button type="button" disabled={!ready||busy||Boolean(attempt)} onClick={send}>{t("send")}</Button>
      {attempt?<Button type="button" disabled={busy} onClick={check}>{t("refresh")}</Button>:null}
      {attempt && ["succeeded","failed"].includes(state)?<Button type="button" disabled={busy} onClick={()=>{setAttempt(null);setResult(null);setState("ready");}}>{t("newTest")}</Button>:null}
    </div>
    <p role="status" aria-live="polite" className="mt-3 text-sm">{t(state)}</p>
    {attempt?<p className="break-all text-sm">{t("event")}: <bdi>{attempt}</bdi></p>:null}
    {result?.state==="succeeded"?<dl className="mt-3 space-y-2 break-all text-sm">
      <dt>{t("shipment")}</dt><dd><a href={`${appBasePath}/resources/shipments?id=${encodeURIComponent(result.shipment_id!)}`}><bdi>{result.shipment_id}</bdi></a></dd>
      <dt>{t("inbox")}</dt><dd><bdi>{result.inbox_id}</bdi></dd>
      <dt>{t("workflow")}</dt><dd><bdi>{result.workflow_run_id}</bdi></dd>
      <dt>{t("step")}</dt><dd><bdi>{result.workflow_run_step_id}</bdi></dd>
      <dt>{t("audit")}</dt><dd>{result.decision_log_ids?.map(id=><div key={id}><bdi>{id}</bdi></div>)}</dd>
    </dl>:null}
  </Section>;
}
