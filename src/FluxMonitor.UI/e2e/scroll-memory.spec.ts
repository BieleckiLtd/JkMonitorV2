import { test, expect } from '@playwright/test';

test('route-scoped scroll memory: System → Tunnel → Back preserves scroll position', async ({ page }) => {
  await page.setViewportSize({ width: 400, height: 560 });
  await page.goto('/system');

  const tunnelButton = page.getByRole('button', { name: /Tunnel/i });
  await tunnelButton.waitFor({ state: 'visible' });

  // Scroll the Tunnel button into view using the page scroll position.
  await tunnelButton.evaluate((btn) => btn.scrollIntoView({ block: 'start' }));
  await page.waitForTimeout(150);

  // The document should now be scrolled down.
  const systemScrollBefore = await page.evaluate(() => window.scrollY);
  expect(systemScrollBefore).toBeGreaterThan(0);

  // Click Tunnel.
  await tunnelButton.click();
  await expect(page).toHaveURL('/system/tunnel');

  // The Tunnel page should NOT be scrolled down.
  await expect(async () => {
    const tunnelScroll = await page.evaluate(() => window.scrollY);
    expect(tunnelScroll).toBe(0);
  }).toPass({ timeout: 1000 });

  // Click Back to return to the System menu.
  const backButton = page.getByRole('button', { name: /Back/i });
  await backButton.click();
  await expect(page).toHaveURL('/system');

  // The System page scroll position should be restored exactly.
  await expect(async () => {
    const systemScrollAfter = await page.evaluate(() => window.scrollY);
    expect(systemScrollAfter).toBe(systemScrollBefore);
  }).toPass({ timeout: 1000 });
});
