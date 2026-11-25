import { signInAsMaya, viewport } from './_larkspur.mjs';
export { viewport };
export const title = 'Find a room for six';
export default async function (page, w) {
  await signInAsMaya(page, w);
  await w.step('Open Rooms', 'The room list');
  await page.click(".nav a[href='/rooms']");
  await page.waitForSelector('.room');
  await w.result(true, 'Listed');
  await w.step('Show rooms for six or more', 'Five rooms are left');
  await page.click(".chip[data-min='6']");
  await w.result((await page.locator('.room').count()) === 5, '5 rooms');
}
