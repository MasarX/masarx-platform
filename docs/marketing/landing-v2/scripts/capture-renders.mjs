import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getFreePort() {
  const { createServer } = await import('node:net');
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitForHttp(url, { timeoutMs = 10000 } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const res = await fetch(url, { method: 'GET' });
      if (res.ok) return;
    } catch {
      // ignore
    }
    // eslint-disable-next-line no-await-in-loop
    await sleep(120);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function captureOne({
  url,
  outPath,
  viewport: { width, height, mobile = false },
  browser,
}) {
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 1,
    isMobile: mobile,
  });
  const page = await context.newPage();

  try {
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForTimeout(160);

    const layout = await page.evaluate(() => ({
      width: Math.ceil(document.documentElement?.scrollWidth || 0),
      height: Math.ceil(document.documentElement?.scrollHeight || 0),
    }));
    const contentWidth = layout?.width || width;
    const contentHeight = layout?.height || height;

    const nextWidth = Math.max(width, Math.min(contentWidth, 3000));
    const nextHeight = Math.max(height, Math.min(contentHeight, 6000));

    if (nextWidth !== width || nextHeight !== height) {
      await page.setViewportSize({ width: nextWidth, height: nextHeight });
      await page.waitForTimeout(90);
    }

    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await page.screenshot({ path: outPath, type: 'png' });
  } finally {
    await context.close().catch(() => {});
  }
}

const here = path.dirname(fileURLToPath(import.meta.url));
const baseDir = path.resolve(here, '..');
const outDir = path.resolve(baseDir, 'renders');
const repoRoot = path.resolve(baseDir, '..', '..', '..');

const shots = [
  { name: 'v2-ai-desktop-en-light.png', viewport: { width: 1440, height: 900, mobile: false }, pathname: '/', query: 'theme=light&motion=off' },
  { name: 'v2-ai-desktop-en-dark.png', viewport: { width: 1440, height: 900, mobile: false }, pathname: '/', query: 'theme=dark&motion=off' },
  { name: 'v2-ai-desktop-ar-light.png', viewport: { width: 1440, height: 900, mobile: false }, pathname: '/ar/', query: 'theme=light&motion=off' },
  { name: 'v2-ai-desktop-ar-dark.png', viewport: { width: 1440, height: 900, mobile: false }, pathname: '/ar/', query: 'theme=dark&motion=off' },
  { name: 'v2-ai-mobile-en-light.png', viewport: { width: 430, height: 900, mobile: true }, pathname: '/', query: 'theme=light&motion=off' },
  { name: 'v2-ai-mobile-en-dark.png', viewport: { width: 430, height: 900, mobile: true }, pathname: '/', query: 'theme=dark&motion=off' },
  { name: 'v2-ai-mobile-ar-light.png', viewport: { width: 430, height: 900, mobile: true }, pathname: '/ar/', query: 'theme=light&motion=off' },
  { name: 'v2-ai-mobile-ar-dark.png', viewport: { width: 430, height: 900, mobile: true }, pathname: '/ar/', query: 'theme=dark&motion=off' },
  // Section capture (hash is appended after query string)
  { name: 'v2-ai-desktop-en-who-light.png', viewport: { width: 1440, height: 900, mobile: false }, pathname: '/', query: 'theme=light&motion=off#who' },
  { name: 'v2-ai-desktop-ar-who-light.png', viewport: { width: 1440, height: 900, mobile: false }, pathname: '/ar/', query: 'theme=light&motion=off#who' },
  { name: 'v2-ai-mobile-en-who-light.png', viewport: { width: 430, height: 900, mobile: true }, pathname: '/', query: 'theme=light&motion=off#who' },
  { name: 'v2-ai-mobile-ar-who-light.png', viewport: { width: 430, height: 900, mobile: true }, pathname: '/ar/', query: 'theme=light&motion=off#who' },
  { name: 'v2-ai-desktop-en-contact-light.png', viewport: { width: 1440, height: 900, mobile: false }, pathname: '/', query: 'theme=light&motion=off#contact' },
  { name: 'v2-ai-desktop-ar-contact-light.png', viewport: { width: 1440, height: 900, mobile: false }, pathname: '/ar/', query: 'theme=light&motion=off#contact' },
  { name: 'v2-ai-mobile-en-contact-light.png', viewport: { width: 430, height: 900, mobile: true }, pathname: '/', query: 'theme=light&motion=off#contact' },
  { name: 'v2-ai-mobile-ar-contact-light.png', viewport: { width: 430, height: 900, mobile: true }, pathname: '/ar/', query: 'theme=light&motion=off#contact' },
];

const httpPort = await getFreePort();
const landingHost = '127.0.0.1';
const baseUrl = `http://${landingHost}:${httpPort}`;

const landingServer = spawn(process.execPath, [
  path.join(repoRoot, 'scripts', 'frontend', 'serve-landing.js'),
  '--port',
  String(httpPort),
], {
  cwd: repoRoot,
  stdio: 'ignore',
  env: {
    ...process.env,
    LANDING_HOST: landingHost,
  },
});

try {
  await waitForHttp(`${baseUrl}/`);
  const browser = await chromium.launch({ headless: true });

  try {
    for (const shot of shots) {
      const query = shot.query ? `?${shot.query}` : '';
      const url = `${baseUrl}${shot.pathname}${query}`;
      // eslint-disable-next-line no-await-in-loop
      await captureOne({
        browser,
        url,
        outPath: path.join(outDir, shot.name),
        viewport: shot.viewport,
      });
    }
  } finally {
    await browser.close().catch(() => {});
  }
} finally {
  try {
    landingServer.kill();
  } catch {
    // ignore
  }
  await sleep(100);
}
