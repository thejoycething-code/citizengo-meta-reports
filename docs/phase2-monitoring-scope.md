# Phase 2 scope: trending topic, ally and enemy monitoring

_Drafted 30 Oct 2026 for Asana task 1218618085657974. Status: for a build decision._

## The question this answers

Phase 1 answers "how did **our** posts do". Phase 2 answers **"what is starting
to move out there, and who is moving it"**, early enough to act: join an ally's
campaign while it is still climbing, or answer an opponent's before it sets the
narrative.

Candela's task (1218612679195558, cross-platform topic performance across X,
Meta and Google Trends) answers "how is this topic doing across **our own**
estate". The two share a topic list and Google Trends; they should not share a
build. Phase 2 looks outward; hers looks inward.

## What already exists and can be reused

| Piece | Where | State |
|---|---|---|
| Instagram peer watch: 61 ally accounts (UK 20, US 28, IE, AU, CA...) read free through `business_discovery`, scored against each account's own median | `collector/peers-ig.js`, `config/peers-ig.json`, `sql/peer-schema.sql` (`peer_ig_latest.vs_median`) | Built 7 Oct; weekly; dormant until `PEER_IG_ENABLED` is set |
| X collector with per-read cost ledger and a monthly budget guard | `collector/x.js`, `lib/xschedule.js` | Live, own accounts only |
| X topic labels and hashtags on our posts | `x_topics` tool | Live |
| Breakout alerts to #comm-social-networks, with fact check and dedup of translated copies | `scripts/breakout-alerts.js`, `skills/breakout-alerts` | Live, own posts only |
| Meta Ad Library search | Meta Ads connector (`ads_library_search`) | Available, unused here |

The scoring idea that makes phase 1 fair (every post against its own page's
normal) is exactly what phase 2 needs. Nothing here needs a new architecture.

## What would be monitored

1. **Allies.** Organisations on our side. Start from the 61 Instagram peers and
   add their X handles. Signal: one of their posts doing several times their
   normal, or several of them pushing the same thing.
2. **Opponents.** Organisations, campaigns and public figures **acting in a
   public role** (e.g. pro-abortion NGOs, assisted-dying campaigns, gender-policy
   lobbies, ministers on our issues). Never private individuals. Signal: a new
   campaign, hashtag, petition link or ad burst.
3. **Topics.** A short, curated keyword and hashtag list per issue and language
   (surrogacy, assisted dying, abortion buffer zones, gender self-ID, etc.).
   Signal: volume on X or Google search climbing above its own baseline.

Lists are curated by people, per country, in config files reviewed like
`config/peers-ig.json`. No automatic list growth.

## Sources

| Source | What it gives | Cost | Notes |
|---|---|---|---|
| **X user timelines** (watched accounts) | Their posts and public counts (likes, reposts, replies, quotes, impressions) | ~$0.005 per post returned | The main cost driver; see budget |
| **X post counts** (`/2/tweets/counts/recent`) | Hourly volume of any keyword query over the last 7 days, without paying per post | ~$0.005 **per request**, reported by third parties; **probe first** | The cheap trend signal. One request per keyword covers a week |
| **Instagram `business_discovery`** | Public posts, likes, comments of any Business/Creator account | Free | Already built. Opponents can be added the same way. No reach or shares |
| **Meta Ad Library API** | Active issue/political ads by any Page (all ads in the EU) | Free | Best early sign an opponent is **putting money** behind a campaign |
| **Google Trends** | Search interest per country and term | Official API is alpha, invite-only; pytrends is unofficial and fragile | Apply for alpha; share with Candela's task |
| Facebook Pages of others | Public posts | Needs Page Public Content Access (app review) | **Out of scope** for 2a; revisit only if the above prove insufficient |

## How an emerging campaign is detected

Four rules, each a pure function tested the way `lib/xschedule.js` is:

1. **Outlier.** A watched account's post at ≥ 5× its own median engagement
   within 24 hours (`vs_median`, as in `peer_ig_latest`). Catches "something
   just took off for an ally or an opponent".
2. **Convergence.** The same hashtag, petition/campaign URL or distinctive
   phrase used by **≥ 3 watched accounts within 48 hours**, where it was not
   used in the previous 30 days. This is the signature of a coordinated
   campaign launching and the one X's radar does not give us.
3. **Volume spike.** A tracked keyword's X hourly count, or Google Trends
   interest, above **3× its trailing 14-day median** for its country.
4. **Ad burst.** An opponent Page starting ≥ 3 new ads on one theme in a week
   (Ad Library).

A signal from two different rules on the same theme ranks first.

## How it is surfaced

* **Daily digest, 08:30 local, one Slack channel** (proposed: a new
  `#radar` rather than #comm-social-networks, which stays for our own
  breakouts). Same discipline as breakout alerts: script decides, Claude fact-checks
  claims, only on days something crossed a line, no "all quiet" messages.
  Each item says: what is moving, who is moving it (ally/opponent), the
  evidence (links, multiples of normal), and a suggested response owner by
  country.
* **New connector tools**, so anyone can ask in Claude:
  `watch_outliers` (ally/opponent posts beating their normal),
  `emerging_campaigns` (convergence and ad bursts),
  `topic_volume` (keyword trend per country), and
  `watch_accounts` (who is on the lists).
* **Tables** `watch_accounts`, `watch_x_posts`, `watch_x_metrics`,
  `topic_counts`, `ad_library_ads`, in their own `sql/watch-schema.sql`,
  separate from our own data as the peer and X tables are.

## Budget (X is the only paid source)

The current X ceiling is `X_MONTHLY_BUDGET_USD = 100`, already shared with our
own collection (~$38/month at the owned rate, up to ~$167 if billed at the
ordinary rate). Monitoring needs **its own budget line and guard**.

| Option | Assumption | Approx. per month |
|---|---|---|
| A. Topics only (counts) | 50 keyword queries, 4 reads a day | ~$30 |
| B. A + 30 watched X accounts | ~5 posts/day each, each post read twice (day 0 and day 1) | ~$30 + ~$45 = **~$75** |
| C. A + 80 watched X accounts | same | ~$30 + ~$120 = ~$150 |

Recommendation: **B**, capped at $100/month in its own ledger, with the
watched-account list prioritised by country.

## Phasing

* **2a (≈2 weeks).** Turn on IG peer watch, daily; add opponents to it. Add 30
  X accounts and the counts probe. Ad Library for ~20 opponent Pages. Rules 1, 2
  and 4. Daily digest for the UK only, tied into the UK opposition and narrative
  monitoring work.
* **2b (≈2 weeks).** Topic volume (rule 3) once the counts probe and Google
  Trends access are confirmed. Extend lists to Spain/LatAm, Italy and one more
  country.
* **2c.** Review after 6 weeks: alerts acted on vs ignored; tune thresholds;
  decide whether to widen.

## Decisions needed before building

1. **Budget:** approve option B (~$75, capped at $100/month separately)?
2. **Data protection:** storing posts from opponent organisations and public
   figures. Public-role accounts only, no private individuals, 120-day
   retention. This needs a sign-off from whoever owns GDPR at CitizenGO before
   the opponent list goes live.
3. **Lists:** who curates ally/opponent/topic lists per country (suggest the
   country campaign lead), and who reviews additions.
4. **Channel:** a new `#radar` channel, or reuse #comm-social-networks.
5. **Google Trends:** apply for the official alpha now (shared with Candela).

## Open technical checks

* Probe the X counts endpoint's real billing (per request vs per post) with
  `scripts/probe-x.js` before committing to rule 3 on X.
* Confirm `business_discovery` reads opponent accounts the same way as allies
  (it reads any Business/Creator account).
* Confirm Ad Library coverage for UK issue ads outside election periods.
