'use strict';
// Bounded-concurrency map. The collector makes ~7 insights calls per post, so a
// 90-post page is ~630 sequential round trips — 15+ minutes. Rate limits are not
// the constraint here (the budget is 4800 x engaged users per page per day),
// latency is.
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}
module.exports = { mapLimit };
