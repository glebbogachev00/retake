import { signInAsMaya, viewport } from './_larkspur.mjs';
export { viewport };
export const title = 'Book a room';
export default async function (page, w) {
  await signInAsMaya(page, w);
  await w.step('Open Rooms', 'All nine rooms, with what is free now');
  await page.click(".nav a[href='/rooms']");
  await page.waitForSelector('.room');
  await w.result((await page.locator('.room').count()) === 9, '9 rooms listed');
  await w.step('Open Juniper', 'The page for Juniper, with today’s schedule');
  await page.click('[data-room=juniper]');
  await page.waitForSelector('#book');
  await w.result(true, 'Free from 14:00 to 16:00');
  await w.step('Press Book Juniper', 'The booking form, with what the room costs');
  await page.click('#book');
  await page.waitForSelector('#form');
  await w.result(true, 'Form open');
  await w.step('Save a design review', 'Your bookings opens, with the new one');
  await page.fill('#title', 'Design review');
  await page.selectOption('#end', '15:00');
  await page.click('#save');
  await page.waitForURL('**/bookings');
  await w.result((await page.locator('.booking.is-new').count()) === 1, 'Saved and listed');
}
