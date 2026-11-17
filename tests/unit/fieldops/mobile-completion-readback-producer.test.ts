import { submittedCompletionExpectation } from "../../../apps/fieldops/src/mobile-normalized-readback";

test("actual enqueue expectation factory freezes partial proof without secrets", () => {
 const value = submittedCompletionExpectation("tasks.complete","task","stop",{
   delivery_completion:{completion_kind:"partial",delivered_box_numbers:[2,1],
     otp_code:"SECRET",recipient_identity_kind:"id",recipient_identity_last4:"SECRET"},
   artifact_ids:["photo","signature"], signature_artifact_id:"signature",
   pod:{geostamp:{latitude:24,longitude:46}},
   payment_collection:{outcome:"collected",method:"cash",collected_amount:12.5},
 });
 expect(value).toMatchObject({completionKind:"partial",deliveredBoxNumbers:[2,1],
  artifactIds:["photo","signature"],signatureArtifactId:"signature",otpConfirmed:true,
  identityPresent:true,geostampPresent:true,paymentOutcome:"collected",paymentMethod:"cash",collectedAmount:12.5});
 expect(JSON.stringify(value)).not.toContain("SECRET");
 expect(JSON.stringify(value)).not.toContain("latitude");
});
test("exception uses actual exception evidence path and raw canonical reason", () => {
 expect(submittedCompletionExpectation("tasks.exception","task","stop",{
  exception_reason:"no_answer",exception_evidence:{geostamp:{latitude:24,longitude:46}},
 })).toMatchObject({statusReason:"no_answer",geostampPresent:true});
});
test("missing or malformed producer proof cannot reduce to accepted identity", () => {
 expect(submittedCompletionExpectation("tasks.complete","task","stop",{})).toBeNull();
 expect(submittedCompletionExpectation("tasks.complete","task","stop",{
  delivery_completion:{completion_kind:"partial",delivered_box_numbers:["1"]},
 })).toBeNull();
});

test("ordinary pickup handoff freezes quantity and presence, not private text", () => {
 const value=submittedCompletionExpectation("tasks.complete","task","stop",{
  confirmed_quantity:3,handover_contact_name:"PRIVATE",handover_notes:"PRIVATE",receipt_context:"PRIVATE",
 });
 expect(value).toMatchObject({confirmedQuantity:3,handoverContactPresent:true,handoverNotesPresent:true,receiptContextPresent:true});
 expect(JSON.stringify(value)).not.toContain("PRIVATE");
 expect(submittedCompletionExpectation("tasks.complete","task","stop",{confirmed_quantity:"3"})).toBeNull();
});
