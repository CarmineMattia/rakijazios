// Read-only: the owner opens Settings → My hardware; the M1 computer is listed. No clicks on actions.
// RK_OWNER_EMAIL=<owner account> node 51-m2a-owner-view.mjs
import { launch, login, shot, sleep, BASE } from './lib.mjs';
const OWNER = process.env.RK_OWNER_EMAIL;
if (!OWNER) { console.error('set RK_OWNER_EMAIL'); process.exit(2); }
const b = await launch('owner'); const page = await b.newPage();
await login(page, OWNER); await page.goto(BASE + '/app', { waitUntil: 'networkidle2' });
await page.click('[data-testid="user-menu-trigger"]'); await sleep(400);
await page.evaluate(() => [...document.querySelectorAll('button,a')].find(x => x.textContent.trim() === 'Settings')?.click());
await page.waitForSelector('#rk-hw-nav', { timeout: 10000 }); await page.click('#rk-hw-nav'); await sleep(2000);
const cards = await page.$$eval('[data-rk-device]', cs => cs.map(c => ({ text: c.querySelector('.rk-hw-name')?.textContent, state: c.querySelector('[data-rk="hw-state"]')?.textContent, meta: c.querySelector('.rk-hw-meta')?.textContent, models: [...c.querySelectorAll('[data-rk-model]')].map(m => m.getAttribute('data-rk-model') + '=' + m.querySelector('[role=switch]').getAttribute('aria-checked')) })));
console.log(JSON.stringify(cards, null, 1));
await shot(page, 'm2a-10-owner-hardware');
// other native tabs still work
await page.click('[data-testid="settings-nav-models"]'); await sleep(800);
console.log('nativeTabBack', await page.evaluate(() => ({ rkHw: document.querySelector('[data-testid="user-settings"]').getAttribute('data-rk-hw'), panelVisible: getComputedStyle(document.getElementById('rk-hw-panel')).display, section: document.querySelector('[data-testid="user-settings"]').getAttribute('data-settings-section') })));
await shot(page, 'm2a-11-native-models-tab');
await b.close();
