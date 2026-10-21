// Exercise the real collection UI with enough local cards to cross the page limit.
import assert from "node:assert/strict";

export async function testCollectionBrowsing(page) {
  await page.locator('.primary-nav [data-view=discover]').click();
  const result = await page.evaluate(async () => {
    const {createCollections} = await import('./collections.js');
    const books = Array.from({length: 16}, (_, index) => ({
      id: `sample-${index}`, type: 'books', title: `Sample ${String(index).padStart(2, '0')}`,
      summary: 'A local browsing fixture.', topics: ['literature'], curator: 'Test', entries: [],
    }));
    const data = {collections: [...books, {...books[0], id: 'image', type: 'images', title: 'An image collection'}], featured: books.slice(0, 4).map(c => c.id), status: {}};
    const ui = createCollections({desktop: {collections: async () => data}, toast: () => {}, openImporter: () => {}});
    const originalRandom = Math.random;
    let calls = 0;
    try {
      // Featured cards deliberately rank last. Their priority must apply only at home.
      Math.random = () => calls++ < 4 ? 0.99 : 0.01;
      const home = await ui.homeRow();
      const strip = await ui.strip('documents');
      const names = node => [...node.querySelectorAll('.collection-card strong')].map(n => n.textContent);
      const first = names(strip);
      const again = names(await ui.strip('documents'));
      const seeAll = strip.querySelector('.collection-strip-head button');
      seeAll.click();
      const all = names(document.querySelector('#collections-view'));
      ui.close();
      data.collections = books.slice(0, 12);
      const exact = await ui.strip('documents');
      data.collections = books.slice(0, 5);
      const small = await ui.strip('documents');
      return {home: names(home), first, again, all, link: seeAll.textContent,
        exact: names(exact).length, exactLink: !!exact.querySelector('.collection-strip-head button'),
        small: names(small).length, smallLink: !!small.querySelector('.collection-strip-head button')};
    } finally {
      Math.random = originalRandom;
      ui.close();
    }
  });
  assert.deepEqual(result.home, ['Sample 00', 'Sample 01', 'Sample 02', 'Sample 03']);
  assert.equal(result.first.length, 12);
  assert.ok(result.first.every(title => !result.home.includes(title)), 'internal cards follow the random order without featured priority');
  assert.deepEqual(result.again, result.first, 'cards stay put during the session');
  assert.equal(result.link, 'See all 16');
  assert.deepEqual(result.all, Array.from({length: 16}, (_, i) => `Sample ${String(i).padStart(2, '0')}`), 'See all is alphabetical and stays in this importer');
  assert.equal(result.exact, 12);
  assert.equal(result.exactLink, false);
  assert.equal(result.small, 5);
  assert.equal(result.smallLink, false);

  // Look at the actual catalog as well: all five book/document cards now fit.
  await page.locator('#discover-home [data-type=documents]').click();
  const available = await page.evaluate(async () => (await window.obelisk.collections()).collections.filter(c => ['books', 'documents'].includes(c.type)).length);
  await page.waitForFunction(expected => document.querySelectorAll('#type-collections .collection-card').length === expected, Math.min(12, available));
  await page.locator('#type-collections').scrollIntoViewIfNeeded();
  await page.screenshot({path: '/private/tmp/obelisk-collection-sections.png'});
}
