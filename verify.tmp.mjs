import { chromium } from 'playwright';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args:['--no-sandbox','--use-gl=swiftshader','--enable-unsafe-swiftshader']});
const errs=[];
const page = await (await b.newContext({viewport:{width:900,height:414},deviceScaleFactor:2})).newPage();
page.on('pageerror', e=>errs.push('pageerror: '+e.message));
page.on('console', m=>{ if(m.type()==='error') errs.push('console: '+m.text()); });
// file:// to prove it needs no server at all
await page.goto('file:///home/user/Espaceshooter/dist/grayzone-standalone.html');
await page.waitForTimeout(900);
await page.screenshot({path:'/tmp/single-01.png'});
await page.getByRole('button',{name:'Neues Profil'}).click();
await page.waitForTimeout(600);
await page.getByRole('button',{name:'Einsatz starten'}).click();
await page.waitForTimeout(300);
await page.getByRole('button',{name:'Absetzen'}).click();
await page.waitForTimeout(2500);
await page.screenshot({path:'/tmp/single-02.png'});
// Drag-to-look on the right half must work without pointer lock.
await page.mouse.move(700,200); await page.mouse.down();
await page.mouse.move(560,205,{steps:8}); await page.mouse.up();
await page.waitForTimeout(400);
const st = await page.evaluate(()=>({state:window.game.state, fps:+window.game.loop.stats.fps.toFixed(1)}));
console.log('state:', st.state, 'fps:', st.fps);
console.log('storage available:', await page.evaluate(()=>{try{localStorage.setItem('x','1');localStorage.removeItem('x');return true}catch{return false}}));
await page.screenshot({path:'/tmp/single-03.png'});
console.log('errors:', errs.length? errs.join(' | ') : 'none');
await b.close();
