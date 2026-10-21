// Local EPUB fixtures, exercised inside the real sandboxed desktop reader.
import JSZip from "jszip";
import assert from "node:assert/strict";
import {mkdir, writeFile} from "node:fs/promises";
import path from "node:path";

export async function testReader(app, page, home) {
  const input = path.join(home, "reader-fixtures");
  await mkdir(input);
  for (const modern of [false, true]) {
    const zip = new JSZip();
    zip.file("mimetype", "application/epub+zip");
    zip.file("META-INF/container.xml", '<container><rootfiles><rootfile full-path="book/package.opf"/></rootfiles></container>');
    zip.file("book/package.opf", `<package><manifest><item id="one" href="one.xhtml" media-type="application/xhtml+xml"/><item id="two" href="two.xhtml" media-type="application/xhtml+xml"/><item id="toc" href="${modern ? "nav.xhtml" : "toc.ncx"}" media-type="${modern ? "application/xhtml+xml" : "application/x-dtbncx+xml"}" ${modern ? 'properties="nav"' : ''}/></manifest><spine toc="toc"><itemref idref="one"/><itemref idref="two"/></spine></package>`);
    zip.file("book/toc.ncx", '<ncx><navMap><navPoint><navLabel><text>Opening chapter</text></navLabel><content src="one.xhtml"/></navPoint><navPoint><navLabel><text>Closing chapter</text></navLabel><content src="two.xhtml"/></navPoint></navMap></ncx>');
    zip.file("book/nav.xhtml", '<html xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><a href="one.xhtml">Opening chapter</a><a href="two.xhtml">Closing chapter</a></nav><nav epub:type="landmarks"><a href="one.xhtml">Wrong landmark label</a></nav></body></html>');
    zip.file("book/pixel.png", Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==', 'base64'));
    zip.file("book/one.xhtml", `<html><body><h1>Publisher heading</h1><svg xmlns:xlink="http://www.w3.org/1999/xlink" onload="window.bookScriptRan=true"><script>window.bookScriptRan=true</script><image xlink:href="pixel.png"/></svg><a id="bookmark"><p id="prose">Bookmarked prose should read normally.</p></a><p><a id="footnote-link" href="two.xhtml#note%20one">Read the note</a></p><script>window.bookScriptRan=true</script>${'<p>A passage preserved for offline reading.</p>'.repeat(30)}<a name="local note">A named bookmark</a><a id="local-link" href="#local%20note">Local note</a></body></html>`);
    zip.file("book/two.xhtml", `<html><body><h1>Another publisher heading</h1>${'<p>More reading.</p>'.repeat(30)}<p id="note one">The footnote.</p><a id="return-link" href="one.xhtml#bookmark">Return</a></body></html>`);
    await writeFile(path.join(input, `${modern ? "modern" : "older"}-reader.epub`), await zip.generateAsync({type: "nodebuffer"}));
    if (modern) {
      zip.file("book/one.xhtml", '<html><body><svg><path d="M0 0L1 1"/></svg></body></html>');
      await writeFile(path.join(input, 'empty-reader.epub'), await zip.generateAsync({type: 'nodebuffer'}));
    }
  }
  await app.evaluate(({dialog}, folder) => {
    dialog.showOpenDialog = async () => ({canceled: false, filePaths: [folder]});
  }, input);
  await page.locator('.primary-nav [data-view=discover]').click();
  await page.locator('#import-folder').click();
  await page.locator('#review-dialog[open]').waitFor();
  await page.locator('#review-save').click();
  await page.locator('#review-dialog[open]').waitFor({state: 'hidden'});
  for (const title of ["older-reader", "modern-reader", "empty-reader"]) {
    await page.locator('.primary-nav [data-view=library]').click();
    const item = await page.evaluate(async (title) => (await window.obelisk.state()).items.find((item) => item.title === title), title);
    // Open by catalog ID, independent of the import destination/filter.
    await page.evaluate((id) => {
      const frame = document.createElement('iframe');
      frame.id = 'reader-test';
      frame.title = 'Reader regression test';
      frame.style = 'position:fixed;inset:20px;width:calc(100% - 40px);height:calc(100% - 40px);z-index:10000;border:1px solid #ddd';
      frame.src = `reader/index.html?item=${encodeURIComponent(id)}&ext=epub`;
      document.body.append(frame);
    }, item.id);
    const reader = page.frameLocator('#reader-test');

    if (title === 'empty-reader') {
      await reader.locator('#status').filter({hasText: 'This section has no readable content. Choose another chapter.'}).waitFor();
      assert.ok(await reader.locator('#next').isEnabled());
      await reader.locator('#next').click();
      await reader.locator('#position').filter({hasText: '2 / 2'}).waitFor();
      await reader.locator('#status').waitFor({state: 'hidden'});
      assert.ok((await reader.locator('#content').innerText()).includes('The footnote.'));
      await page.evaluate(() => document.querySelector('#reader-test').remove());
      continue;
    }
    await reader.locator('#status').waitFor({state: 'hidden'});
    assert.deepEqual(await reader.locator('#chapters option').allTextContents(), ['Opening chapter', 'Closing chapter']);
    assert.equal(await reader.locator('#bookmark').evaluate((node) => getComputedStyle(node).textDecorationLine), 'none');
    assert.equal(await reader.locator('#footnote-link').evaluate((node) => getComputedStyle(node).textDecorationLine), 'underline');
    assert.equal(await reader.locator('body').evaluate(() => window.bookScriptRan), undefined);
    assert.equal(await reader.locator('#content svg').count(), 0);
    await reader.locator('#content img').evaluate((img) => img.decode());
    await reader.locator('body').evaluate(() => {
      window.revokedImages = [];
      const revoke = URL.revokeObjectURL.bind(URL);
      URL.revokeObjectURL = (url) => { window.revokedImages.push(url); revoke(url); };
      window.previousImage = document.querySelector('#content img').src;
    });
    await reader.locator('#local-link').click();
    assert.ok(await reader.locator('a[name="local note"]').evaluate((node) => node.getBoundingClientRect().top >= 40 && node.getBoundingClientRect().top < innerHeight));
    await reader.locator('#footnote-link').click();
    await reader.locator('#position').filter({hasText: '2 / 2'}).waitFor();
    assert.ok(await reader.locator('body').evaluate(() => window.revokedImages.includes(window.previousImage)));
    assert.ok(await reader.locator('[id="note one"]').evaluate((node) => node.getBoundingClientRect().top >= 40 && node.getBoundingClientRect().top < innerHeight));
    await reader.locator('#return-link').click();
    await reader.locator('#position').filter({hasText: '1 / 2'}).waitFor();
    await reader.locator('#prose').click();
    await page.keyboard.press('ArrowRight');
    await reader.locator('#position').filter({hasText: '2 / 2'}).waitFor();
    await page.keyboard.press('ArrowLeft');
    await reader.locator('#position').filter({hasText: '1 / 2'}).waitFor();
    await reader.locator('#larger').click();
    assert.equal(await reader.locator('#content').evaluate((node) => getComputedStyle(node).fontSize), '18px');
    if (title === 'modern-reader') await page.screenshot({path: '/private/tmp/obelisk-reader-fixed.png'});
    await page.evaluate(() => document.querySelector('#reader-test').remove());
  }
}
