import { signInAsMaya, viewport } from './_larkspur.mjs';
export { viewport };
export const title = 'Sign in';
export default async function (page, w) {
  await signInAsMaya(page, w);
  await w.step('Check the next booking', 'Today shows the next booking');
  await w.result(await page.isVisible('.stat.next'), 'Hiring sync at 11:00');
}
