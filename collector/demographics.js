'use strict';
// Audience demographics and video retention.
//
// Both are UNCERTAIN by design. Meta retired a great many page_fans_* and
// post_activity_by_* metrics in 2024, and the surviving set is not reliably
// documented. Rather than assume, every metric is attempted individually and
// whatever fails is simply absent — the collector reports which worked, so the
// answer comes from Meta rather than from guesswork.
//
// This is the same approach that overturned the original scoping assumptions:
// reach turned out to exist when the documentation implied otherwise.

// Candidates. Names deliberately include some likely-retired ones so the run
// tells us definitively which still work, and the fixtures record the answer.
const DEMOGRAPHIC_METRICS = [
  { metric: 'page_fans_country', breakdown: 'country' },
  { metric: 'page_fans_city', breakdown: 'city' },
  { metric: 'page_fans_locale', breakdown: 'locale' },
  { metric: 'page_fans_gender_age', breakdown: 'age_gender' },
  { metric: 'page_follows_by_country', breakdown: 'country' },
  { metric: 'page_follows_by_city', breakdown: 'city' },
  { metric: 'page_audience_country', breakdown: 'country' },
];

// Meta returns these as a single object mapping key -> count, not a series.
async function collectDemographics({ page, as, call, runStarted, log }) {
  const rows = [];
  const worked = [];
  const failed = [];
  const metricDate = runStarted.toISOString().slice(0, 10);

  for (const { metric, breakdown } of DEMOGRAPHIC_METRICS) {
    const res = await call(`/${page.page_id}/insights`, { metric, period: 'lifetime' }, as);
    if (!res.ok) { failed.push(metric); continue; }

    const series = (res.body && res.body.data && res.body.data[0] && res.body.data[0].values) || [];
    const latest = series.length ? series[series.length - 1] : null;
    const value = latest && latest.value;
    // An empty object means the metric name is valid but Meta has nothing for
    // this page — different from the metric being retired, which errors.
    if (!value || typeof value !== 'object' || !Object.keys(value).length) { failed.push(metric); continue; }

    worked.push(metric);
    for (const [key, count] of Object.entries(value)) {
      if (typeof count !== 'number') continue;
      rows.push({
        page_id: page.page_id,
        metric_date: metricDate,
        breakdown,
        metric,
        key: String(key).slice(0, 120),
        value: count,
        collected_at: runStarted.toISOString(),
      });
    }
  }

  if (worked.length) log(`   demographics: ${rows.length} rows from ${worked.join(', ')}`);
  else if (failed.length) log(`   demographics: none available (tried ${failed.length} metrics — all retired or empty)`);
  return { rows, worked, failed };
}

// Retention is a curve, so it is stored whole as jsonb rather than exploded.
// Only worth requesting for video; asking on a photo just wastes a call.
async function collectRetention({ post, as, call }) {
  const isVideo = post.media_type === 'video' || post.status_type === 'added_video';
  if (!isVideo) return null;

  const res = await call(`/${post.id}/insights`, { metric: 'post_video_retention_graph' }, as);
  if (!res.ok) return null;
  const d = res.body && res.body.data && res.body.data[0];
  const v = d && d.values && d.values[0];
  if (!v || !v.value || typeof v.value !== 'object') return null;
  const entries = Object.entries(v.value);
  if (!entries.length) return null;
  return v.value;
}

module.exports = { collectDemographics, collectRetention, DEMOGRAPHIC_METRICS };
