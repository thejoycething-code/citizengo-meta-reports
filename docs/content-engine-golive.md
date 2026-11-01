# Content Engine: going live

Chris's checklist for these steps is the Asana task "Content Engine go-live":
https://app.asana.com/1/826488630492934/task/1220084771334351

Everything is built and in dry run. This is the order to switch it on, with a
rehearsal on a test Page before any real account posts. Run the preflight at
each step; it reads only and never prints a token:

```bash
npm run engine:preflight        # on the laptop (needs SUPABASE_URL and SUPABASE_SERVICE_KEY)
```

On the Mini (`cd ~/runner/meta-reports && node scripts/engine-preflight.js`) it also says whether the
publisher and the Inbox sender are in dry run or live.

## 1. Connect Facebook (Chris; the Asana task)

1. In the Meta app (developers.facebook.com), add **Facebook Login for Business** with the redirect URI
   `https://meta-organic-reporting.vercel.app/api/fb/callback`, and ask for: pages_show_list,
   pages_read_engagement, pages_manage_posts, instagram_basic, instagram_content_publish,
   business_management, pages_read_user_content, pages_manage_engagement, pages_messaging,
   instagram_manage_comments, instagram_manage_messages. While the app is in development mode, everyone who
   connects needs a role on the app (add them under App roles); Live mode for everyone needs Meta's App Review.
2. In Vercel (meta-organic-reporting, Production): `FB_APP_ID`, `FB_APP_SECRET`, `FB_REDIRECT_URI` (the URI
   above). Redeploy.
3. Preflight: "Connect Facebook switched on" turns ✓.

## 2. People connect (each person with a Page role)

On the desk, **Connect Facebook**, approve the Pages. Their publishing rights then come from Facebook, and
their sealed Page tokens reach the engine. The nightly re-check on the Mini (03:30) removes rights people lose.
Preflight: "Every Facebook and Instagram account has a connected person" turns ✓. The rights seeded by hand
during the build can then be removed (preflight lists them).

The Inbox fills within 5 minutes of the first connection (it reads only).

## 3. Rehearsal on a test Page (before any real account posts)

1. Create a Facebook Page that isn't published (only its admins see it), e.g. "CitizenGO Engine Test", and
   link a test Instagram account if you have one.
2. Add it as its own team so nothing mixes with the UK (Supabase SQL editor; replace the ids):
   ```sql
   insert into engine_teams (id, name, flag, accounts) values ('test', 'Engine test', '🧪',
     '[{"key":"test-fb","platform":"facebook","page_id":"<PAGE ID>","name":"Engine Test"}]'::jsonb);
   insert into engine_members (team_id, who, role) values ('test', 'chris', 'admin');
   ```
   Connect Facebook again so the test Page's token is sealed.
3. **Pause the real accounts first** (desk › Calendar › Pause everything › "Only United Kingdom", until you
   resume), so switching the publisher on can't post anything real.
4. With Chris's OK, switch the publisher live on the Mini (step 5 below), schedule on the test team: one image
   post with a first comment, a carousel, a Story, and a short Reel; watch `/tmp/content-publisher.log` and the
   desk's Publishing box. Comment on the test post from another account and reply, hide and delete it from the
   Inbox (needs the Inbox sender live too).
5. Switch both back to dry run if anything is wrong; otherwise resume the UK pause when ready for real posts.

## 4. Cutover (the board → the desk)

As in `docs/content-engine-phase2.md`, slice 1 step 6: fresh board dump and re-import, publish the desk onto the
board URL with its 29 tools, `touch content-engine/ENGINE_LIVE`, check the first daily run.

## 5. Switches on the Mini (each with Chris's OK)

Publisher (posts scheduled posts):

```bash
cd ~/runner/meta-reports && grep -q '^ENGINE_PUBLISH_LIVE=' .env || echo 'ENGINE_PUBLISH_LIVE=1' >> .env
sed 's/ --dry-run//' scripts/launchd/net.citizengo.content-publisher.plist > ~/Library/LaunchAgents/net.citizengo.content-publisher.plist
launchctl bootout gui/$(id -u)/net.citizengo.content-publisher; launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/net.citizengo.content-publisher.plist
```

Inbox sender (replies, hides, deletes, likes, automations; check queued actions in Moderation first):

```bash
cd ~/runner/meta-reports && grep -q '^ENGINE_INBOX_LIVE=' .env || echo 'ENGINE_INBOX_LIVE=1' >> .env
sed 's/ --dry-run//' scripts/launchd/net.citizengo.content-inbox-actions.plist > ~/Library/LaunchAgents/net.citizengo.content-inbox-actions.plist
launchctl bootout gui/$(id -u)/net.citizengo.content-inbox-actions; launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/net.citizengo.content-inbox-actions.plist
```

## Going back

- Immediately: **Pause everything** on the desk (holds every scheduled post; nothing is deleted).
- Then on the Mini, reinstall the repo's plists as they are (they pass `--dry-run`) and remove the
  `ENGINE_*_LIVE` lines from `.env`:
  ```bash
  cd ~/runner/meta-reports && sed -i '' '/^ENGINE_PUBLISH_LIVE=/d;/^ENGINE_INBOX_LIVE=/d' .env
  for j in content-publisher content-inbox-actions; do cp scripts/launchd/net.citizengo.$j.plist ~/Library/LaunchAgents/ && launchctl bootout gui/$(id -u)/net.citizengo.$j; launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/net.citizengo.$j.plist; done
  ```
- The board stays as it was at the cutover dump; see the phase 2 doc for undoing the cutover.
