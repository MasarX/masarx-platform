// Destination tests/ui/mapping-test-panel.test.tsx. Source interactions only, not native proof.
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MappingTestPanel } from "../../packages/ui/src/mapping-studio/mapping-test-panel";
const mockStatus=jest.fn(),mockRequest=jest.fn();
let mockAuthListener: (event:string,session:unknown)=>void;
const mockUnsubscribe=jest.fn();
const mockAuth={onAuthStateChange:jest.fn()};
jest.mock("@masarx/auth/browser",()=>({createBrowserClient:()=>({auth:mockAuth})}));
function session(userId=source,sessionId="session-a",expires=100){
  return {user:{id:userId},access_token:"header."+btoa(JSON.stringify({sub:userId,session_id:sessionId,role:"authenticated",exp:expires,iat:expires-50}))+".signature"};
}
jest.mock("@masarx/api",()=>({createUiClient:()=>({mappingStudio:{testStatus:mockStatus,testRequest:mockRequest}})}));
jest.mock("next-intl",()=>({useTranslations:()=> (key:string)=>key}));
const source="10000000-0000-4000-8000-000000000001";
const event="10000000-0000-4000-8000-000000000002";
const id="10000000-0000-4000-8000-000000000003";
function setup(){
  const onEligibilityChange=jest.fn();
  const props={sourceId:source,payloadText:'{"event":{"type":"shipment.create"}}',savedRevision:0,onEligibilityChange,appBasePath:"/console"};
  return {props,onEligibilityChange,...render(<MappingTestPanel {...props}/>)};
}
beforeEach(()=>{
  jest.clearAllMocks();
  mockAuth.onAuthStateChange.mockImplementation(listener=>{mockAuthListener=listener;listener("INITIAL_SESSION",session());return {data:{subscription:{unsubscribe:mockUnsubscribe}}};});
  Object.defineProperty(globalThis.crypto,"randomUUID",{configurable:true,value:()=>event});
  mockStatus.mockImplementation(async({source_id,external_id})=>({ok:true,state:"pending",source_id,external_id}));
  mockRequest.mockImplementation(async({source_id,payload})=>({ok:true,accepted:true,source_id,external_id:payload.event.id}));
});
test("eligibility remains disabled while initial authority check is pending",async()=>{
  let finish!: (value:unknown)=>void;
  mockStatus.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
  setup();
  const checkbox=screen.getByRole("checkbox");
  expect(checkbox).toBeDisabled();
  await waitFor(()=>expect(mockStatus).toHaveBeenCalledTimes(1));
  await act(async()=>{finish({ok:false});});
  await waitFor(()=>expect(checkbox).toBeEnabled());
  expect(screen.getByRole("status")).toHaveTextContent("notEnabled");
});
test("eligibility checkbox changes only save intent and cannot dispatch",async()=>{
  const f=setup();await screen.findByText("ready");
  fireEvent.click(screen.getByRole("checkbox"));
  expect(f.onEligibilityChange).toHaveBeenCalledWith(false);
  expect(screen.getByRole("button",{name:"send"})).toBeDisabled();
  expect(mockRequest).not.toHaveBeenCalled();
  expect(screen.getByRole("status")).toHaveTextContent("saveRequired");
});
test("one request, 202-like acknowledgement remains pending, readback has original identity",async()=>{
  setup();await screen.findByText("ready");
  fireEvent.click(screen.getByRole("button",{name:"send"}));
  fireEvent.click(screen.getByRole("button",{name:"send"}));
  await waitFor(()=>expect(screen.getByRole("status")).toHaveTextContent("pending"));
  expect(mockRequest).toHaveBeenCalledTimes(1);
  expect(mockStatus).toHaveBeenLastCalledWith({source_id:source,external_id:event});
  expect(screen.queryByRole("link")).not.toBeInTheDocument();
});
test("unknown transport never auto-resends or exposes upstream error",async()=>{
  mockRequest.mockRejectedValue(new Error("PRIVATE TOKEN"));setup();await screen.findByText("ready");
  fireEvent.click(screen.getByRole("button",{name:"send"}));await screen.findByText("unknown");
  expect(screen.getByRole("button",{name:"send"})).toBeDisabled();
  fireEvent.click(screen.getByRole("button",{name:"refresh"}));
  await waitFor(()=>expect(screen.getByRole("status")).toHaveTextContent("pending"));
  expect(mockRequest).toHaveBeenCalledTimes(1);expect(screen.queryByText(/PRIVATE/)).toBeNull();
});
test("success without required audit lineage is rejected",async()=>{
  setup();await screen.findByText("ready");
  mockStatus.mockResolvedValue({ok:true,state:"succeeded",source_id:source,external_id:event,inbox_id:id,shipment_id:id,workflow_run_id:id,workflow_run_step_id:id,decision_log_ids:[]});
  fireEvent.click(screen.getByRole("button",{name:"send"}));await screen.findByText("unavailable");
  expect(screen.queryByRole("link")).toBeNull();
});
test("only complete safe lineage exposes shipment result",async()=>{
  setup();await screen.findByText("ready");
  mockStatus.mockResolvedValue({ok:true,state:"succeeded",source_id:source,external_id:event,inbox_id:id,shipment_id:id,workflow_run_id:id,workflow_run_step_id:id,decision_log_ids:[id],raw_payload:"PRIVATE"});
  fireEvent.click(screen.getByRole("button",{name:"send"}));await screen.findByText("succeeded");
  expect(screen.getByRole("link")).toHaveAttribute("href",`/console/resources/shipments?id=${id}`);
  expect(screen.queryByText(/PRIVATE/)).toBeNull();
});
test("failed intake shows no shipment success and checks the same event without resending",async()=>{
  setup();await screen.findByText("ready");
  mockStatus.mockResolvedValue({ok:true,state:"failed",source_id:source,external_id:event,
    inbox_id:id,shipment_id:id,workflow_run_id:id,workflow_run_step_id:id,decision_log_ids:[id]});
  fireEvent.click(screen.getByRole("button",{name:"send"}));
  await screen.findByText("failed");
  expect(screen.queryByRole("link")).toBeNull();
  expect(screen.queryByText("shipment")).toBeNull();
  expect(screen.queryByText("succeeded")).toBeNull();
  expect(screen.getByText(event).tagName).toBe("BDI");
  expect(screen.getByRole("button",{name:"send"})).toBeDisabled();
  expect(screen.getByRole("button",{name:"newTest"})).toBeEnabled();
  fireEvent.click(screen.getByRole("button",{name:"send"}));
  fireEvent.click(screen.getByRole("button",{name:"refresh"}));
  await waitFor(()=>expect(mockStatus).toHaveBeenCalledTimes(3));
  await waitFor(()=>expect(screen.getByRole("button",{name:"refresh"})).toBeEnabled());
  expect(screen.getByRole("status")).toHaveTextContent("failed");
  expect(screen.queryByRole("link")).toBeNull();
  expect(screen.getByText(event).tagName).toBe("BDI");
  expect(mockStatus.mock.calls.slice(1)).toEqual([
    [{source_id:source,external_id:event}],[{source_id:source,external_id:event}],
  ]);
  expect(mockRequest).toHaveBeenCalledTimes(1);
});
test("ordinary or unauthorized source stays disabled",async()=>{
  mockStatus.mockResolvedValue({ok:false});setup();await screen.findByText("notEnabled");
  expect(screen.getByRole("button",{name:"send"})).toBeDisabled();expect(mockRequest).not.toHaveBeenCalled();
});

test("source switch discards the old submission acknowledgement without reading it back",async()=>{
  let finish!: (value: unknown)=>void;
  mockRequest.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
  const f=setup();await screen.findByText("ready");
  fireEvent.click(screen.getByRole("button",{name:"send"}));
  const other="20000000-0000-4000-8000-000000000001";
  f.rerender(<MappingTestPanel key={other} {...f.props} sourceId={other}/>);
  await screen.findByText("ready");
  await act(async()=>{finish({ok:true,accepted:true,source_id:source,external_id:event});});
  expect(mockStatus.mock.calls.filter(([p])=>p.source_id===source)).toHaveLength(1);
  expect(screen.getByRole("status")).toHaveTextContent("ready");
  expect(screen.queryByRole("button",{name:"refresh"})).toBeNull();
  expect(mockRequest).toHaveBeenCalledTimes(1);
});
test("unmount discards a pending submission without starting a status request",async()=>{
  let finish!: (value: unknown)=>void;
  mockRequest.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
  const f=setup();await screen.findByText("ready");
  fireEvent.click(screen.getByRole("button",{name:"send"}));f.unmount();
  await act(async()=>{finish({ok:true,accepted:true,source_id:source,external_id:event});});
  expect(mockStatus).toHaveBeenCalledTimes(1);
  expect(mockRequest).toHaveBeenCalledTimes(1);
});
test("late successful readback cannot populate a different keyed source",async()=>{
  const f=setup();await screen.findByText("ready");
  let finish!: (value: unknown)=>void;
  mockStatus.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
  fireEvent.click(screen.getByRole("button",{name:"send"}));
  await waitFor(()=>expect(mockStatus).toHaveBeenCalledTimes(2));
  const other="20000000-0000-4000-8000-000000000001";
  f.rerender(<MappingTestPanel key={other} {...f.props} sourceId={other}/>);
  await screen.findByText("ready");
  await act(async()=>{finish({ok:true,state:"succeeded",source_id:source,external_id:event,
    inbox_id:id,shipment_id:id,workflow_run_id:id,workflow_run_step_id:id,decision_log_ids:[id]});});
  expect(screen.queryByRole("link")).toBeNull();
  expect(screen.getByRole("status")).toHaveTextContent("ready");
  expect(mockRequest).toHaveBeenCalledTimes(1);
});

test("denied refresh clears previously verified success lineage",async()=>{
  setup();await screen.findByText("ready");
  mockStatus.mockResolvedValueOnce({ok:true,state:"succeeded",source_id:source,external_id:event,
    inbox_id:id,shipment_id:id,workflow_run_id:id,workflow_run_step_id:id,decision_log_ids:[id]});
  fireEvent.click(screen.getByRole("button",{name:"send"}));
  await screen.findByRole("link");
  mockStatus.mockResolvedValueOnce({ok:false});
  fireEvent.click(screen.getByRole("button",{name:"refresh"}));
  await screen.findByText("unavailable");
  expect(screen.queryByRole("link")).toBeNull();
  expect(screen.queryByText("shipment")).toBeNull();
  expect(mockRequest).toHaveBeenCalledTimes(1);
  expect(mockStatus).toHaveBeenLastCalledWith({source_id:source,external_id:event});
});

test("actor replacement invalidates late acknowledgement on the same source",async()=>{
  let finish!: (value:unknown)=>void;
  mockRequest.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
  const f=setup();await screen.findByText("ready");
  fireEvent.click(screen.getByRole("button",{name:"send"}));
  await act(async()=>{mockAuthListener("SIGNED_IN",session(id,"session-b"));});
  await screen.findByText("ready");
  expect(f.onEligibilityChange).toHaveBeenLastCalledWith(undefined);
  const reads=mockStatus.mock.calls.length;
  await act(async()=>{finish({ok:true,accepted:true,source_id:source,external_id:event});});
  expect(mockStatus).toHaveBeenCalledTimes(reads);
  expect(screen.queryByRole("button",{name:"refresh"})).toBeNull();
  expect(screen.queryByRole("link")).toBeNull();
  expect(mockRequest).toHaveBeenCalledTimes(1);
});
test("same-session token refresh preserves pending attempt and unsubscribe runs on unmount",async()=>{
  const f=setup();await screen.findByText("ready");
  fireEvent.click(screen.getByRole("button",{name:"send"}));
  await screen.findByText("pending");
  const reads=mockStatus.mock.calls.length;
  await act(async()=>{mockAuthListener("TOKEN_REFRESHED",session(source,"session-a",200));});
  expect(screen.getByRole("button",{name:"refresh"})).toBeEnabled();
  expect(screen.getByRole("button",{name:"send"})).toBeDisabled();
  expect(mockStatus).toHaveBeenCalledTimes(reads);
  expect(mockRequest).toHaveBeenCalledTimes(1);
  f.unmount();expect(mockUnsubscribe).toHaveBeenCalledTimes(1);
});
