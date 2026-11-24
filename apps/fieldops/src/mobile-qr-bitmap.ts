const qrcode = require("qrcode-generator") as typeof import("qrcode-generator");

export function buildSigningQr(signingUrl: string): { size: number; path: string } {
  const qr = qrcode(0, "M");
  qr.addData(signingUrl);
  qr.make();

  const modules = qr.getModuleCount();
  const quietZone = 4;
  const lines: string[] = [];
  for (let row = 0; row < modules; row += 1) {
    for (let column = 0; column < modules; column += 1) {
      if (qr.isDark(row, column)) {
        lines.push(`M${column + quietZone} ${row + quietZone}h1v1h-1z`);
      }
    }
  }
  return { size: modules + 2 * quietZone, path: lines.join("") };
}
