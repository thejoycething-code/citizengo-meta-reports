#!/bin/zsh
# Nightly on the Mac Mini (launchd: net.citizengo.link-signatures, 10:30 local).
#
# Pulls signatures, new and reactivated members per SOCIAL campaign code from
# Looker (google_analytics_4 / petitions_signatures_3_0) into link_signatures.
# Looker is only reachable through the claude.ai CitizenGO Looker connector,
# which the Mini's Claude Code (work account) has, so Claude makes the one
# read-only query and scripts/load-link-signatures.js reads its result from
# the stream and writes Supabase with the .env credentials in this checkout.
#
# Runs from its own checkout, ~/runner/meta-reports (with a copy of .env):
# launchd jobs cannot read ~/Desktop (macOS privacy protection), so the
# Desktop checkout fails with exit 127 before the first line.
# Run it by hand to test:  zsh ~/runner/meta-reports/scripts/link-signatures-mini.sh
set -u
export PATH=$HOME/.local/bin:$HOME/.local/node/bin:/opt/homebrew/bin:/usr/bin:/bin
REPO="${0:A:h:h}"
WORK="$HOME/bb/link-signatures"
mkdir -p "$WORK"
cd "$REPO" && git pull -q --ff-only origin main 2>>"$WORK/err.txt"
cd "$WORK"
SINCE=$(date -v-400d +%Y/%m/%d)
# Two queries: (1) Copilot social codes (…-FB1, -IG2…) whatever source the
# signer arrived from (WhatsApp shares count); (2) ANY code whose signers
# arrived straight from a social platform, which catches hand-made codes.
FIELDS="petitions_signatures_3_0.utm_campaign, petitions_signatures_3_0.source, petitions_signatures_3_0.sum_signatures, petitions_signatures_3_0.sum_new_members, petitions_signatures_3_0.sum_reactivated_members"
claude -p "Use the CitizenGO Looker connector, read-only. Call its query tool exactly TWICE, both with model google_analytics_4, view (explore) petitions_signatures_3_0, fields ${FIELDS}, sorts petitions_signatures_3_0.sum_signatures desc, limit 50000. Query 1 filters: petitions_signatures_3_0.utm_campaign = '%-fb%,%-ig%,%-tw%,%-tk%,%-yt%,%-tg%' and petitions_signatures_3_0.date_date = 'after ${SINCE}'. Query 2 filters: petitions_signatures_3_0.source = 'fb,ig,tw,tk,yt,tg' and petitions_signatures_3_0.date_date = 'after ${SINCE}'. Do not call any other tool, do not summarise the rows. When both calls return, reply with the single word DONE." \
  --allowedTools "mcp__claude_ai_CitizenGO_Looker__query" --output-format stream-json --verbose > stream.jsonl 2>> err.txt
node "$REPO/scripts/load-link-signatures.js" stream.jsonl >> run.log 2>&1
echo "$(date -u +%FT%TZ) exit $?" >> run.log
# Link in bio [2 Nov 2026]: each petition's Bluebook total and signatures in
# the last 14 days, then the campaigns' Asana projects (complete, archived,
# evaluated, petition status updated), both read-only, into petition_status.
# Either step failing leaves the last values in place.
SINCE2=$(date -v-730d +%Y/%m/%d)
SINCE14=$(date -v-14d +%Y/%m/%d)
claude -p "Use the CitizenGO Looker connector, read-only. In model google_analytics_4, explore petitions_signatures_3_0, find the dimension that holds the petition id (if unsure, list the explore's fields first). Then call the query tool exactly TWICE with fields <that petition id dimension>, petitions_signatures_3_0.sum_signatures, sorts petitions_signatures_3_0.sum_signatures desc, limit 50000. Query 1 filter: petitions_signatures_3_0.date_date = 'after ${SINCE2}'. Query 2 filter: petitions_signatures_3_0.date_date = 'after ${SINCE14}'. Do not summarise the rows. When both calls return, reply with the single word DONE." \
  --allowedTools "mcp__claude_ai_CitizenGO_Looker" --output-format stream-json --verbose > totals.jsonl 2>> err.txt
claude -p "Use the Asana connector, read-only: never create, change or comment on anything. In the Asana team 'Campaigns Global', find every project whose name starts with a list code and a dash, like 'EN_GB - ' or 'EN_IE - ', modified in the last 180 days, archived ones included. For each, check whether its task whose name starts with 'Evaluate the Integrated Campaign' is completed, and whether its task whose name starts with 'Update the status of the Petition on the Landing Page' is completed. Reply with ONLY a JSON array, one object per project: {\"name\": project name, \"completed\": project marked complete, \"archived\": archived, \"evaluated\": evaluate task completed, \"status_updated\": status task completed}. No other text." \
  --allowedTools "mcp__claude_ai_Asana" --output-format stream-json --verbose > asana.jsonl 2>> err.txt
node "$REPO/scripts/load-petition-status.js" totals.jsonl asana.jsonl >> run.log 2>&1
echo "$(date -u +%FT%TZ) petition status exit $?" >> run.log
# Then the desk's Analytics and Listening views, from the data now in Supabase.
cd "$REPO" && node scripts/engine-warm-cache.js >> "$WORK/run.log" 2>&1
