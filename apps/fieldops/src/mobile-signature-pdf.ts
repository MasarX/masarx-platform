type SignaturePoint = { x: number; y: number };
/** Encode the current numeric canvas geometry in a bucket-supported, inert PDF. */
export async function buildSignaturePdf(
  strokes: SignaturePoint[][], layout: { width: number; height: number }
): Promise<ArrayBuffer> {
  const { width, height } = layout;
  if (![width,height].every(v => Number.isFinite(v) && v > 0 && v <= 4096))
    throw new Error("signature_dimensions");
  if (!Array.isArray(strokes) || strokes.length > 1024) throw new Error("signature_geometry");
  let count = 0;
  // Snapshot before the first await; UI mutation cannot change bytes already being encoded.
  const snapshot = strokes.map(stroke => {
    if (!Array.isArray(stroke)) throw new Error("signature_geometry");
    count += stroke.length;
    if (count > 20000) throw new Error("signature_geometry");
    return stroke.map(point => {
      if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y))
        throw new Error("signature_geometry");
      return { x: Math.max(0,Math.min(width,point.x)), y: height-Math.max(0,Math.min(height,point.y)) };
    });
  }).filter(stroke => stroke.length);
  if (!count) throw new Error("signature_empty");
  const { PDFDocument, rgb, LineCapStyle } = await import("pdf-lib");
  const document = await PDFDocument.create();
  const page = document.addPage([width,height]);
  page.drawRectangle({x:0,y:0,width,height,color:rgb(1,1,1)});
  const ink = rgb(15/255,23/255,42/255);
  for (const stroke of snapshot) {
    for (let i=1;i<stroke.length;i++)
      page.drawLine({start:stroke[i-1],end:stroke[i],thickness:2.5,color:ink,lineCap:LineCapStyle.Round});
    // Rounded joins also preserve a deliberate single-point mark.
    for (const point of stroke) page.drawCircle({x:point.x,y:point.y,size:1.25,color:ink});
  }
  const encoded = await document.save();
  // Return only the encoded bytes, never an unrelated backing-buffer prefix/suffix.
  return new Uint8Array(encoded).buffer;
}
