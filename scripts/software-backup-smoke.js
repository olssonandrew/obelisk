import { _electron as electron } from 'playwright-core';
import {writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));const env={...process.env,OBELISK_HOME:path.join(root,'demo')};delete env.ELECTRON_RUN_AS_NODE;
const app=await electron.launch({executablePath:path.join(root,'dist/Obelisk-darwin-arm64/Obelisk.app/Contents/MacOS/Obelisk'),args:[],env});
try{
 const page=await app.firstWindow();page.setDefaultTimeout(20000);await page.getByRole('heading',{name:'Library',exact:true}).waitFor();
 await page.locator('[data-view=discover]').click(); await page.locator('[data-source=software]').click();
 await page.getByRole('button',{name:/Save (this app to archive|a fresh app copy)/}).click();
 async function poll(test){const end=Date.now()+120000;while(Date.now()<end){try{const s=await page.evaluate(()=>window.obelisk.state());if(test(s))return s;}catch{}await new Promise(resolve=>setTimeout(resolve,500));}throw new Error('Software action timed out');}
 await poll(s=>s.items.some(i=>i.source?.adapter==='self-backup'&&i.source.version===s.appVersion));
 const state=await page.evaluate(()=>window.obelisk.state());const copy=state.items.find(i=>i.source?.adapter==='self-backup'&&i.source.version===state.appVersion);
 if(copy.software.platform!=='darwin'||copy.software.arch!=='arm64'||copy.software.offlineTested)throw new Error('Incorrect app backup metadata');
 await writeFile(path.join(root,'output/desktop/app-backup-path.txt'),path.join(state.archiveRoot,copy.path));
 console.log(JSON.stringify({selfBackup:copy.path,bytes:copy.bytes}));
 await page.getByRole('button',{name:'Save macOS package',exact:true}).click();
 await poll(s=>s.items.some(i=>i.source?.adapter==='software'&&i.source.provider==='Kiwix')||s.jobs.some(j=>j.source?.adapter==='software'&&j.status==='failed'));
 const done=await page.evaluate(()=>window.obelisk.state());const kiwix=done.items.find(i=>i.source?.adapter==='software'&&i.source.provider==='Kiwix');if(!kiwix)throw new Error(done.jobs.find(j=>j.source?.adapter==='software'&&j.status==='failed')?.error||'No Kiwix package');
 await writeFile(path.join(root,'output/desktop/kiwix-package-path.txt'),path.join(done.archiveRoot,kiwix.path));
 console.log(JSON.stringify({kiwix:kiwix.path,bytes:kiwix.bytes,platform:kiwix.software}));
 await page.screenshot({path:path.join(root,'output/desktop/software-saved.png')});
}finally{await app.close();}
