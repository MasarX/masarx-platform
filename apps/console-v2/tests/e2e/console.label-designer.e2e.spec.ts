import { test, expect } from '@playwright/test';
import { Buffer } from 'node:buffer';
import { gotoSurfaceBySidebar, settle } from './fixtures';

test('Label Designer workbench @live-readiness opens from visible shell navigation and accepts native asset upload', async ({
  page,
}) => {
  await gotoSurfaceBySidebar(page, /Label Designer & templates/i, '/platform/labels');

  await expect(page.getByRole('heading', { name: /Label Designer & templates/i })).toBeVisible();
  const workbench = page.getByTestId('label-designer-workbench');
  await expect(workbench).toBeVisible();
  await expect(workbench).toContainText('Visual label designer');
  await expect(workbench).toContainText('designer open');

  const composer = page.getByTestId('label-design-composer');
  if ((await composer.count()) === 0) {
    const openDesigner = page.getByRole('button', { name: /Open Label Designer/i });
    await expect(openDesigner).toBeEnabled();
    await openDesigner.click();
    await settle(page, 500);
  }
  await expect(composer).toBeVisible();
  await expect(composer.getByLabel('Label design visual preview')).toBeVisible();
  await expect(composer.getByTestId('label-designer-asset-dropzone')).toContainText(
    'Drop image asset',
  );

  const fileName = `e2e-label-designer-upload-${Date.now()}.png`;
  await composer.getByLabel('Upload label asset').setInputFiles({
    name: fileName,
    mimeType: 'image/png',
    buffer: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/l8S1WAAAAABJRU5ErkJggg==',
      'base64',
    ),
  });

  await expect(composer).toContainText(fileName.replace(/\.png$/i, ''), { timeout: 10_000 });
  await expect(composer.getByLabel(/Design JSON/i)).toContainText(fileName.replace(/\.png$/i, ''));
});
