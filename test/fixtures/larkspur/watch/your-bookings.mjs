import { signInAsMaya, viewport } from './_larkspur.mjs';
export { viewport };
export const title = 'Your bookings';
export default async function (page, w) {
  await signInAsMaya(page, w);
  await w.step('Open Bookings', 'Today’s and this week’s bookings');
  await page.click(".nav a[href='/bookings']");
  await page.waitForSelector('.booking');
  await w.result((await page.locator('.booking').count()) === 4, '4 coming up');
}
