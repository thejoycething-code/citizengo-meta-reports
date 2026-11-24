'use strict';
// Joins organic posts to what was spent promoting them.
//
// The link is the ad creative's effective_object_story_id, which IS the page
// post id — so a boosted post appears in both datasets under the same key. That
// makes it possible to ask what a post's paid reach cost, and to compare that
// against what the same post earned organically.
//
// Needs ads_read on the token. The Redes HO token has it; a System User token
// scoped only to page insights will not, in which case this is skipped and
// everything else still runs.
//
// ONE ROW PER AD, holding the ad's LIFETIME totals (18 Nov 2026). This used to
// store whatever a rolling "last N days" window returned, keyed on the window's
// dates. The window moves every night, so every night wrote a new row for the
// same ad, and the paid-vs-organic view summed them: one boost showed about
// eight times its real spend after ten nights, and a reach larger than its
// impressions. A window also cuts off the start of any ad that began before
// it, and an ad that stops delivering eventually falls out of it altogether.
//
// So the window is now used only to FIND ads that delivered recently. Their
// totals are then asked for with date_preset=maximum, which Meta answers with
// the whole life of the ad, and the row is overwritten each night under the
// ad_id alone. Reach is unique people over the ad's life, which is why it is
// asked for this way rather than summed from daily rows: daily reach does not
// add up. An ad that has stopped keeps the last lifetime row it was given,
// which is final because a stopped ad's totals no longer change.

const PAGE_LIMIT = 500;
// Meta caps the IN filter's value list; stay well under it.
const ID_CHUNK = 50;

// Follows the after-cursor so an account with more than one page of ads is not
// silently cut off at the first PAGE_LIMIT.
async function readAll(call, pathname, params) {
  const out = [];
  let after = null;
  for (let guard = 0; guard < 100; guard++) {
    const res = await call(pathname, after ? { ...params, after } : params);
    if (!res.ok) return out.length ? out : null;
    out.push(...((res.body && res.body.data) || []));
    after = res.body && res.body.paging && res.body.paging.next
      && res.body.paging.cursors && res.body.paging.cursors.after;
    if (!after) break;
  }
  return out;
}

async function collectAdSpend({ call, lookbackDays, runStarted, log }) {
  const accounts = await call('/me/adaccounts', { fields: 'id,account_id,name,currency', limit: 100 });
  if (!accounts.ok) {
    log(`   ad spend: unavailable (${accounts.error ? accounts.error.message.slice(0, 70) : 'unknown'})`);
    return { rows: [], skipped: true };
  }

  const since = new Date(runStarted.getTime() - lookbackDays * 86400000).toISOString().slice(0, 10);
  const until = runStarted.toISOString().slice(0, 10);
  const rows = [];

  for (const acct of (accounts.body.data || [])) {
    // Which ads delivered in the window. Only the ids are used from this.
    const recent = await readAll(call, `/${acct.id}/insights`, {
      level: 'ad',
      fields: 'ad_id',
      time_range: JSON.stringify({ since, until }),
      limit: PAGE_LIMIT,
    });
    if (!recent || !recent.length) continue;
    const adIds = [...new Set(recent.map((i) => i.ad_id).filter(Boolean))];

    // One call maps every ad in the account to its promoted post.
    const creatives = await readAll(call, `/${acct.id}/ads`, {
      fields: 'id,creative{effective_object_story_id,object_story_id}',
      limit: PAGE_LIMIT,
    });
    const postByAd = new Map();
    for (const ad of creatives || []) {
      const c = ad.creative || {};
      const postId = c.effective_object_story_id || c.object_story_id;
      if (postId) postByAd.set(ad.id, postId);
    }

    // An ad with no page post behind it (a link ad, say) has nothing to join
    // to, so it is deliberately dropped rather than stored unattached.
    const linked = adIds.filter((id) => postByAd.has(id));

    for (let i = 0; i < linked.length; i += ID_CHUNK) {
      const chunk = linked.slice(i, i + ID_CHUNK);
      const lifetime = await readAll(call, `/${acct.id}/insights`, {
        level: 'ad',
        fields: 'ad_id,ad_name,campaign_name,spend,impressions,reach,date_start,date_stop',
        date_preset: 'maximum',
        filtering: JSON.stringify([{ field: 'ad.id', operator: 'IN', value: chunk }]),
        limit: PAGE_LIMIT,
      });
      for (const r of lifetime || []) {
        const postId = postByAd.get(r.ad_id);
        if (!postId) continue;
        rows.push({
          post_id: postId,
          page_id: postId.includes('_') ? postId.split('_')[0] : null,
          ad_id: r.ad_id,
          ad_account_id: acct.account_id || acct.id,
          campaign_name: r.campaign_name || null,
          spend: r.spend ? Number(r.spend) : null,
          currency: acct.currency || null,
          impressions: r.impressions ? Number(r.impressions) : null,
          reach: r.reach ? Number(r.reach) : null,
          // The ad's first and last day of delivery, as Meta reports them for
          // the lifetime preset.
          date_start: r.date_start || null,
          date_stop: r.date_stop || null,
          collected_at: runStarted.toISOString(),
        });
      }
    }
  }

  log(`   ad spend: ${rows.length} ad-to-post link(s), lifetime totals`);
  return { rows, skipped: false };
}

module.exports = { collectAdSpend };
