import { expect, test, type Page } from '@playwright/test';
import { HARNESS, HTML_URL } from '../../playwright.config';
import { clickText, editText, lastOf, open, received, setMode, toFrame } from './helpers';

const openHtml = (page: Page) => open(page, '', HARNESS, HTML_URL);

test('html: edits page text in place, keeping its source indentation out of the editor', async ({ page }) => {
  const frame = await openHtml(page);
  await setMode(page, 'edit');
  const h1 = frame.locator('h1');
  await editText(h1);
  expect(await h1.locator('span[contenteditable]').evaluate((el) => el.textContent)).toBe('Plain HTML');
  await page.keyboard.type('Hello HTML');
  await page.keyboard.press('Enter');
  await expect(h1).toHaveText('Hello HTML');
  const edit = await lastOf(page, 'le:edit');
  expect(edit.newValue).toBe('\n      Hello HTML\n    ');
  expect((edit.candidates as any[])[0]).toMatchObject({ rel: 'index.html', quote: 'html', raw: '\n      Plain HTML\n    ', line: 9 });
});

test('html: entities and identical texts resolve to their own source', async ({ page }) => {
  const frame = await openHtml(page);
  await setMode(page, 'edit');
  await editText(frame.getByTestId('entity'));
  await page.keyboard.type('Q&A <3');
  await page.keyboard.press('Enter');
  let edit = await lastOf(page, 'le:edit');
  expect(edit.newValue).toBe('Q&A <3');
  expect((edit.candidates as any[])[0]).toMatchObject({ raw: 'Tom &amp; Jerry', value: 'Tom & Jerry' });

  await editText(frame.locator('li').nth(1));
  await page.keyboard.type('Start');
  await page.keyboard.press('Enter');
  edit = await lastOf(page, 'le:edit', 2);
  expect(edit.candidates as any[]).toHaveLength(1);
  expect((edit.candidates as any[])[0]).toMatchObject({ raw: 'Home', line: 17, ordinal: 1, sameValueCount: 2 });
});

test('html: text inside inline markup and cloned from a template is editable; runtime text is not', async ({ page }) => {
  const frame = await openHtml(page);
  await setMode(page, 'edit');
  await editText(frame.getByTestId('mixed').locator('a'));
  await page.keyboard.press('Escape');
  await editText(frame.locator('#cards p.card'));
  await page.keyboard.type('Cloned');
  await page.keyboard.press('Enter');
  const edit = await lastOf(page, 'le:edit');
  expect((edit.candidates as any[])[0]).toMatchObject({ rel: 'index.html', raw: 'From a template' });

  await frame.getByTestId('runtime').click();
  await page.waitForTimeout(300);
  expect(await frame.locator('[contenteditable]').count()).toBe(0);
  expect(await received(page, 'le:edit')).toHaveLength(1);
});

test('html: a dropdown edits option text without its indentation', async ({ page }) => {
  const frame = await openHtml(page);
  await setMode(page, 'edit');
  const select = frame.getByTestId('size');
  const panel = frame.locator('vibe-visual-editor-options');
  await select.click();
  await expect(panel).toHaveCount(1);
  // The field holds only "Small", all selected, so typing replaces it and the indentation stays.
  await page.keyboard.type('Tiny');
  await page.keyboard.press('Enter');
  await expect(panel).toHaveCount(0);
  const edit = await lastOf(page, 'le:edit');
  expect(edit.newValue).toBe('\n          Tiny\n        ');
  expect((edit.candidates as any[])[0]).toMatchObject({ quote: 'html', raw: '\n          Small\n        ' });
});

test('html: select mode points at the element in the page source', async ({ page }) => {
  const frame = await openHtml(page);
  await setMode(page, 'select');
  await clickText(frame.locator('li').first());
  const d = (await lastOf(page, 'le:select')).descriptor as Record<string, any>;
  expect(d.tag).toBe('li');
  expect(d.creationSite).toMatchObject({ rel: 'index.html', line: 16, column: 7 });
  expect(d.creationSiteIsAncestor).toBe(false);
  expect(d.editableText).toMatchObject({ value: 'Home', rel: 'index.html', line: 16 });
  expect(d.outerHTML).toBe('<li>Home</li>');
});

test('html: pending edits revert when discarded', async ({ page }) => {
  const frame = await openHtml(page);
  await setMode(page, 'edit');
  const lead = frame.locator('p.lead');
  await editText(lead);
  await page.keyboard.type('Pending');
  await page.keyboard.press('Enter');
  const edit = await lastOf(page, 'le:edit');
  const candidate = (edit.candidates as any[])[0];
  await toFrame(page, { type: 'le:editApplied', requestId: edit.requestId, literalId: candidate.id, value: 'Pending' });
  await toFrame(page, { type: 'le:pending', edits: [{ literalId: candidate.id, value: 'Pending', original: 'No framework, just a page.' }] });
  await expect(lead).toHaveText('Pending');
  await toFrame(page, { type: 'le:pending', edits: [] });
  await expect(lead).toHaveText('No framework, just a page.');
});
