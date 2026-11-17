import { PDFDocument, PDFArray, PDFRawStream, decodePDFRawStream } from "pdf-lib";
import { buildSignaturePdf } from "../../../apps/fieldops/src/mobile-signature-pdf";
describe("bucket-compatible signature PDF",()=>{
 test("actual PDF preserves page scale, top-left Y orientation and nonblank stroke geometry",async()=>{
  const bytes=await buildSignaturePdf([[{x:10,y:20},{x:80,y:60}]],{width:320,height:160});
  expect(bytes).toBeInstanceOf(ArrayBuffer);
  expect(new TextDecoder().decode(new Uint8Array(bytes).slice(0,5))).toBe("%PDF-");
  const document=await PDFDocument.load(bytes);
  expect(document.getPageCount()).toBe(1);
  expect(document.getPage(0).getSize()).toEqual({width:320,height:160});
  const refs=document.getPage(0).node.Contents() as PDFArray;
  const content=Array.from({length:refs.size()},(_,i)=>{
   const stream=document.context.lookup(refs.get(i),PDFRawStream);
   return new TextDecoder().decode(decodePDFRawStream(stream).decode());
  }).join("\n");
  expect(content).toContain("10 140 m");
  expect(content).toContain("80 100 l");
  expect(content).toContain("2.5 w");
 });
 test("single-point ink and multiple independent strokes are retained",async()=>{
  expect((await buildSignaturePdf([[{x:1,y:2}],[{x:5,y:6},{x:7,y:8}]],{width:320,height:160})).byteLength).toBeGreaterThan(100);
 });
 test.each([{width:0,height:160},{width:Infinity,height:160},{width:320,height:NaN},{width:5000,height:160}])("rejects invalid layout %j",async layout=>{
  await expect(buildSignaturePdf([[{x:1,y:2}]],layout)).rejects.toThrow("signature_dimensions");
 });
 test.each([[],[[]],[[{x:NaN,y:1}]],[[{x:1,y:Infinity}]]].map(strokes=>({strokes})))("rejects blank/nonfinite geometry %#",async ({strokes})=>{
  await expect(buildSignaturePdf(strokes,{width:320,height:160})).rejects.toThrow(/signature_(empty|geometry)/);
 });
 test("caps geometry before loading or encoding and snapshots input across await",async()=>{
  await expect(buildSignaturePdf([Array.from({length:20001},()=>({x:1,y:1}))],{width:320,height:160})).rejects.toThrow("signature_geometry");
  const strokes=[[{x:10,y:20},{x:80,y:60}]];
  const pending=buildSignaturePdf(strokes,{width:320,height:160});
  strokes[0][0].x=NaN;
  await expect(pending).resolves.toBeInstanceOf(ArrayBuffer);
 });
});
