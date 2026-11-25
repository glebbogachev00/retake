// Shared by the Larkspur journeys (a file starting with _ is never run on its own).
// Larkspur is a made-up app with no real accounts, so this signs in by typing;
// a journey against a real app uses the kit's signIn(url) and a saved login.
export const APP = process.env.LARKSPUR_URL || 'http://larkspur.localhost:4471';
export const viewport = { width: 1000, height: 625 };

export async function signInAsMaya(page, w) {
  await w.mask('#password');
  await w.step('Sign in as Maya', 'The Today page opens');
  await page.goto(APP + '/');
  await page.fill('#email', 'maya@corvidlane.example');
  await page.fill('#password', 'correct-horse-battery');
  await page.click('button[type=submit]');
  await page.waitForURL('**/today');
  await w.result(true, 'Signed in');
}
