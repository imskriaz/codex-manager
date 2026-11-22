import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { useWorkspaceDashboardAssets } from './workspace-dashboard-assets.mjs';

const origin = 'http://127.0.0.1:39875';
const output = path.join(tmpdir(), 'codex-manager-api-urls');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const results = [];
try {
  for (const width of [1440,390,320]) {
    const page = await browser.newPage({ viewport: { width, height: 950 }, serviceWorkers: 'block' });
    const errors = [];
    page.on('pageerror', error=>errors.push(error.message));
    if (!process.argv.includes('--installed')) {
    await useWorkspaceDashboardAssets(page,origin);
    // Exercise the workspace build without upgrading or mutating the live host.
    await page.route(/^http:\/\/127\.0\.0\.1:39875\/api(?:\/(?:keys|explorer|proxy))?(?:\?.*)?$/,async route=>{
      if (!route.request().isNavigationRequest()) return route.fallback();
      const response=await route.fetch({url:origin+'/'});
      await route.fulfill({response,body:(await response.text()).replace(/<script(?=\s+src="\/assets\/dashboard\.js)/g,'<script type="module"')});
    });
    }
    const screen=page.getByRole('region',{name:'API access',exact:true});
    const selectView=async label=>{const picker=screen.getByRole('combobox',{name:'API view',exact:true});if(await picker.isVisible())await picker.selectOption({label});else await screen.getByRole('tab',{includeHidden:true,name:label,exact:true}).click();};
    const started=Date.now();
    for (const [view,label] of [['keys','API keys'],['explorer','API Explorer'],['proxy','Proxy']]) {
      await page.goto(origin+'/api/'+view,{waitUntil:'domcontentloaded'});
      await screen.waitFor();
      assert.equal(await screen.getByRole('tab',{includeHidden:true,name:label,exact:true}).getAttribute('aria-selected'),'true','Deep link selects '+view);
      await page.reload({waitUntil:'domcontentloaded'});
      await screen.waitFor();
      assert.equal(await screen.getByRole('tab',{includeHidden:true,name:label,exact:true}).getAttribute('aria-selected'),'true','Refresh retains '+view);
    }
    await selectView('API Explorer');
    await page.waitForURL(origin+'/api/explorer');
    await selectView('API keys');
    await page.waitForURL(origin+'/api/keys');
    await page.goBack();
    assert.equal(await screen.getByRole('tab',{includeHidden:true,name:'API Explorer',exact:true}).getAttribute('aria-selected'),'true');
    await page.goBack();
    assert.equal(await screen.getByRole('tab',{includeHidden:true,name:'Proxy',exact:true}).getAttribute('aria-selected'),'true');
    await page.goForward();
    assert.equal(await screen.getByRole('tab',{includeHidden:true,name:'API Explorer',exact:true}).getAttribute('aria-selected'),'true');
    await selectView('Proxy');
    await page.waitForURL(origin+'/api/proxy');
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2));
    await page.screenshot({path:path.join(output,'proxy-'+width+'.png')});
    await page.goto(origin+'/api',{waitUntil:'domcontentloaded'});
    await screen.waitFor();
    assert.equal(await screen.getByRole('tab',{includeHidden:true,name:'API keys',exact:true}).getAttribute('aria-selected'),'true','Legacy API URL still opens keys');
    assert.deepEqual(errors,[]);
    results.push({width,elapsedMs:Date.now()-started});
    await page.close();
  }
  console.log(JSON.stringify({results,screenshots:output},null,2));
} finally {await browser.close();}
