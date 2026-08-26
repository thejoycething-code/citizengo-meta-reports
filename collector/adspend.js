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
    // Ad-level insights, with the creative expanded so the post id comes back in
    // the same response rather than needing a call per ad.
    const res = await call(`/${acct.id}/insights`, {
      level: 'ad',
      fields: 'ad_id,ad_name,campaign_name,spend,impressions,reach,date_start,date_stop',
      time_range: JSON.stringify({ since, until }),
      limit: 500,
    });
    if (!res.ok) continue;

    const insights = (res.body && res.body.data) || [];
    if (!insights.length) continue;

    // One call maps every ad in the account to its promoted post.
    const creatives = await call(`/${acct.id}/ads`, {
      fields: 'id,creative{effective_object_story_id,object_story_id}',
      limit: 500,
    });
    const postByAd = new Map();
    if (creatives.ok) {
      for (const ad of (creatives.body.data || [])) {
        const c = ad.creative || {};
        const postId = c.effective_object_story_id || c.object_story_id;
        if (postId) postByAd.set(ad.id, postId);
      }
    }

    for (const i of insights) {
      const postId = postByAd.get(i.ad_id);
      // An ad with no page post behind it (a link ad, say) has nothing to join
      // to, so it is deliberately dropped rather than stored unattached.
      if (!postId) continue;
      rows.push({
        post_id: postId,
        page_id: postId.includes('_') ? postId.split('_')[0] : null,
        ad_id: i.ad_id,
        ad_account_id: acct.account_id || acct.id,
        campaign_name: i.campaign_name || null,
        spend: i.spend ? Number(i.spend) : null,
        currency: acct.currency || null,
        impressions: i.impressions ? Number(i.impressions) : null,
        reach: i.reach ? Number(i.reach) : null,
        date_start: i.date_start || since,
        date_stop: i.date_stop || until,
        collected_at: runStarted.toISOString(),
      });
    }
  }

  log(`   ad spend: ${rows.length} ad-to-post link(s)`);
  return { rows, skipped: false };
}

module.exports = { collectAdSpend };
