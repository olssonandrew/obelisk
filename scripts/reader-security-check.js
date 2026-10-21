import { _electron as electron } from 'playwright-core';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { openLibrary } from '../packages/core/library.js';
const root=fileURLToPath(new URL('../',import.meta.url));
const home=await mkdtemp(path.join(root,'demo/reader-check-'));
const archive=path.join(home,'archive');
const library=await openLibrary(archive,home);
const malicious='<h1>Safe reading</h1><script>window.readerEscaped=true</script><img src="https://invalid.example/track" onerror="window.readerEscaped=true"><iframe src="https://invalid.example/frame"></iframe><form action="https://invalid.example/post"><input name="x"></form><p>Kept as text.</p>';
const markdown=path.join(home,'security.md');await writeFile(markdown,malicious);
const zip=new JSZip();
zip.file('META-INF/container.xml','<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>');
zip.file('book.opf','<package><manifest><item id="a" href="chapter.xhtml"/></manifest><spine><itemref idref="a"/></spine></package>');
zip.file('chapter.xhtml',malicious);
const book=path.join(home,'security.epub');await writeFile(book,await zip.generateAsync({type:'nodebuffer'}));
await library.importPaths([markdown,book]);await library.close();
const env={...process.env,OBELISK_HOME:home};delete env.ELECTRON_RUN_AS_NODE;
const app=await electron.launch({args:[root],env});
try {
 const page=await app.firstWindow();const external=[];
 page.context().on('request',request=>{if(/^https?:/.test(request.url()))external.push(request.url());});
 for(const name of ['security.md','security.epub']){
  await page.getByRole('button',{name:'Preview '+name,exact:true}).click();
  const frame=page.frameLocator('#preview iframe');
  await frame.getByRole('heading',{name:'Safe reading',exact:true}).waitFor();
  const state=await frame.locator('body').evaluate(()=>({escaped:window.readerEscaped===true,bridge:typeof window.obelisk,node:typeof process,active:document.querySelectorAll('#content script,#content iframe,#content form,#content [onerror],#content img[src]').length}));
  if(state.escaped||state.bridge!=='undefined'||state.node!=='undefined'||state.active)throw new Error(JSON.stringify(state));
 }
 if(external.length)throw new Error('Reader requested remote resources: '+external.join(','));
 console.log('EPUB and Markdown: active content removed, no Node/desktop bridge, no remote requests.');
} finally {await app.close();await rm(home,{recursive:true,force:true});}
