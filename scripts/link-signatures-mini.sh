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
