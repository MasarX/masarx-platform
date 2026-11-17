#!/usr/bin/env node
/* eslint-disable no-console */
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const {
  normalizeNodeId,
  parseFigmaUrl,
  extractTaggedWaybillGeometry,
} = require('./figma/waybill-geometry');

const ROOT = process.cwd();
// objectives:allow LOCALHOST Justification: local-only static server for Puppeteer geometry capture.
const CAPTURE_HOST = '127.0.0.1';

const argv = process.argv.slice(2);

const parseArgs = (list) => {
  const out = {};
  for (let i = 0; i < list.length; i += 1) {
    const token = list[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = list[i + 1];
    if (!next || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
};

const resolvePuppeteer = () => {
  try {
    return require('puppeteer-core');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Missing puppeteer-core dependency. Install it locally (npm i -D puppeteer-core) or use --provider figma to avoid local browser capture.\nUnderlying error: ${message}`
    );
  }
};

const guessChromePath = () => {
  const candidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p));
};

const createStaticServer = (dir, port) => {
  const server = http.createServer((req, res) => {
    const parsed = url.parse(req.url || '/');
    const pathname = decodeURIComponent(parsed.pathname || '/');
    const relPath = pathname === '/' ? '/index.html' : pathname;
    const filePath = path.join(dir, relPath);
    if (!filePath.startsWith(dir)) {
      res.writeHead(403);
      res.end();
      return;
    }
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end();
        return;
      }
      const ext = path.extname(filePath).toLowerCase();
      const contentType = ext === '.html' ? 'text/html'
        : ext === '.js' ? 'application/javascript'
          : ext === '.css' ? 'text/css'
            : ext === '.png' ? 'image/png'
              : 'application/octet-stream';
      res.writeHead(200, { 'content-type': contentType });
      res.end(data);
    });
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, CAPTURE_HOST, () => resolve(server));
  });
};

const getArg = (args, keys, fallback = null) => {
  for (const k of keys) {
    if (args[k] != null) return args[k];
  }
  return fallback;
};

const fetchJson = async (reqUrl, headers) => {
  const res = await fetch(reqUrl, { headers });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} from ${reqUrl}${body ? `: ${body.slice(0, 200)}` : ''}`);
  }
  return await res.json();
};

const captureFromFigma = async (args, outFile) => {
  const token =
    process.env.FIGMA_TOKEN ||
    process.env.FIGMA_API_TOKEN ||
    process.env.FIGMA_PERSONAL_ACCESS_TOKEN;

  const parsed = args.url ? parseFigmaUrl(args.url) : null;
  const fileKey = getArg(args, ['fileKey', 'file-key', 'file_key'], parsed?.fileKey);
  const nodeIdRaw = getArg(args, ['nodeId', 'node-id', 'node_id'], parsed?.nodeId);
  const nodeId = normalizeNodeId(nodeIdRaw);

  if (!token) {
    throw new Error('Missing FIGMA_TOKEN (or FIGMA_API_TOKEN). Set it in your shell/env before running.');
  }
  if (!fileKey || !nodeId) {
    throw new Error('Usage (figma): --provider figma --file-key <fileKey> --node-id <nodeId> [--dpi 203] [--page-width-inch 4] [--page-height-inch 6] [--out file.json]');
  }

  const depth = Number(getArg(args, ['depth'], 12));
  const reqUrl = `https://api.figma.com/v1/files/${encodeURIComponent(fileKey)}/nodes?ids=${encodeURIComponent(nodeId)}&depth=${Number.isFinite(depth) ? depth : 12}`;
  const json = await fetchJson(reqUrl, { 'X-Figma-Token': token });
  const docNode = json?.nodes?.[nodeId]?.document;
  if (!docNode) {
    throw new Error(`Figma node not found in response: nodeId=${nodeId}`);
  }

  const geometry = extractTaggedWaybillGeometry(docNode, {
    dpi: getArg(args, ['dpi'], 203),
    pageWidthInch: getArg(args, ['pageWidthInch', 'page-width-inch', 'page_width_inch'], 4),
    pageHeightInch: getArg(args, ['pageHeightInch', 'page-height-inch', 'page_height_inch'], 6),
    tolerancePx: getArg(args, ['tolerancePx', 'tolerance-px', 'tolerance_px'], 2),
  });

  geometry.figma = { file_key: fileKey, node_id: nodeId };

  const output = JSON.stringify(geometry, null, 2);
  if (outFile) {
    fs.writeFileSync(outFile, `${output}\n`);
    console.log(`[capture-waybill-geometry] wrote ${outFile}`);
  } else {
    process.stdout.write(`${output}\n`);
  }
};

const main = async () => {
  const args = parseArgs(argv);
  const buildDir = args.dir ? path.resolve(ROOT, args.dir) : null;
  const outFile = args.out ? path.resolve(ROOT, args.out) : null;
  const port = Number(args.port || 4173);

  const provider = String(args.provider || '').toLowerCase();
  if (provider === 'figma') {
    await captureFromFigma(args, outFile);
    return;
  }

  if (!buildDir) {
    console.error('[capture-waybill-geometry] Missing --dir for local static capture. Prefer: --provider figma');
    process.exit(1);
  }
  if (!fs.existsSync(buildDir)) {
    console.error(`[capture-waybill-geometry] build dir not found: ${buildDir}`);
    process.exit(1);
  }

  const puppeteer = resolvePuppeteer();
  const executablePath = args.executable || guessChromePath();
  if (!executablePath) {
    console.error('[capture-waybill-geometry] Chrome/Edge executable not found. Set CHROME_PATH or pass --executable.');
    process.exit(1);
  }

  const server = await createStaticServer(buildDir, port);

  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    const page = await browser.newPage();
    let geometryJson = null;

    page.on('console', (msg) => {
      const text = msg.text();
      if (!text.startsWith('WAYBILL_GEOMETRY')) return;
      const payload = text.replace(/^WAYBILL_GEOMETRY\s*/, '');
      try {
        geometryJson = JSON.parse(payload);
      } catch {
        // Sometimes Vite formats as multiple args; fallback to raw.
        geometryJson = payload;
      }
    });

    // objectives:allow LOCALHOST Justification: local-only static server for Puppeteer geometry capture.
    await page.goto(`http://${CAPTURE_HOST}:${port}/`, { waitUntil: 'networkidle0' });

    // Wait briefly for export.
    for (let i = 0; i < 20 && !geometryJson; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 250));
    }

    if (!geometryJson) {
      throw new Error('WAYBILL_GEOMETRY not captured. Ensure build was done with VITE_EXPORT_GEOMETRY=1.');
    }

    const json = typeof geometryJson === 'string' ? geometryJson : JSON.stringify(geometryJson, null, 2);

    if (outFile) {
      fs.writeFileSync(outFile, `${json}\n`);
      console.log(`[capture-waybill-geometry] wrote ${outFile}`);
    } else {
      process.stdout.write(`${json}\n`);
    }
  } finally {
    await browser.close();
    server.close();
  }
};

main().catch((err) => {
  console.error(`[capture-waybill-geometry] failed: ${err.message}`);
  process.exit(1);
});
