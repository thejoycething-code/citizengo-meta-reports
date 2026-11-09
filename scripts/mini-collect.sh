#!/bin/zsh
# Scheduled collections on the Mac Mini (launchd: net.citizengo.meta.<job>).
#
# Why (2 Nov 2026): GitHub started the 04:30 nightly collection at 10:30-12:45
# and the 09:00 watchdog at ~15:00, every day. The Mini runs them on time, and
# GitHub's schedules stand down while the repository variable MINI_COLLECTS is
# 'true' (each workflow's job-level `if`). Manual runs on GitHub still work.
#
# Each job mirrors its workflow's SCHEDULED steps; change both together:
#   nightly       nightly-collect.yml       04:30
#   x             x-collect.yml             05:15   (only while X_COLLECT_ENABLED=true)
#   peers         peer-ig-collect.yml       06:10   (only while PEER_IG_ENABLED=true)
#   ig-connected  ig-connected-collect.yml  06:15
#   links         link-registry.yml         06:40
#   listen        listen-collect.yml        06:45
#   stories       (Mini only)               hourly  (Instagram Stories while live)
#   watchdog      watchdog.yml              09:00   (GitHub's watchdog keeps running too,
#                                                    so a dead Mini is still noticed)
#
# Secrets come from .env in this checkout (lib/graph.js loadEnv), never from
# here: META_TOKENS, ALERT_WEBHOOK_URL, X_CLIENT_ID, X_CLIENT_SECRET,
# X_TOKEN_PRIVATE_KEY, plus SUPABASE_URL and SUPABASE_SERVICE_KEY.
#
# Log: ~/runner/logs/meta-<job>.log (appended), last result: meta-<job>.last.
# Run one by hand to test:  zsh ~/runner/meta-reports/scripts/mini-collect.sh nightly
set -u
export PATH=$HOME/.local/bin:$HOME/.local/node/bin:/opt/homebrew/bin:/usr/bin:/bin
REPO="${0:A:h:h}"
JOB="${1:?usage: mini-collect.sh <nightly|x|peers|ig-connected|stories|links|listen|watchdog>}"
LOGS="$HOME/runner/logs"
LOCK="$HOME/runner/locks/meta-$JOB"
mkdir -p "$LOGS" "$HOME/runner/locks"
LOG="$LOGS/meta-$JOB.log"

# One run per job at a time: a slow nightly must not overlap the next one.
if ! mkdir "$LOCK" 2>/dev/null; then
  echo "$(date '+%F %T') $JOB already running (lock $LOCK) - skipped" >> "$LOG"
  exit 0
fi
trap 'rmdir "$LOCK" 2>/dev/null' EXIT
exec >> "$LOG" 2>&1
echo "== $(date '+%F %T') $JOB start"

cd "$REPO" || exit 1
git pull -q --ff-only origin main || echo "git pull failed - running the code already checked out"

# The workflows' repository variables. A line in .env wins over these.
default() { grep -q "^$1=" .env 2>/dev/null || export "$1=$2"; }
default GRAPH_VERSION v23.0
default PEER_IG_VIA_ID 17841422748868275
default OPPONENTS_IG_ENABLED true
default PEER_IG_ENABLED true
default X_COLLECT_ENABLED true
default X_MONTHLY_BUDGET_USD 200
default X_ANNUAL_BUDGET_USD 2000
default X_APP_OWNER_ID 1264712994
env_value() { sed -n "s/^$1=//p" .env 2>/dev/null | tail -1 | sed "s/^[\"']//; s/[\"']\$//"; }
enabled() { local v="${(P)1:-$(env_value $1)}"; [ "$v" = "true" ]; }

run_job() {
  case "$JOB" in
    nightly)
      node collector/collect.js --lookback-days 14 --max-posts 200 --concurrency 6 ;;
    x)
      enabled X_COLLECT_ENABLED || { echo "X_COLLECT_ENABLED is not true - nothing to do"; return 0; }
      node collector/x.js ;;
    peers)
      enabled PEER_IG_ENABLED || { echo "PEER_IG_ENABLED is not true - nothing to do"; return 0; }
      node scripts/test-peers-ig.js && node scripts/test-ad-library.js || return 1
      local rc=0
      node collector/peers-ig.js --list allies --posts 50 || rc=1
      node collector/peers-ig.js --list opponents --posts 50 || rc=1
      node collector/ad-library.js --days 90 || rc=1
      return $rc ;;
    ig-connected)
      node collector/ig-connected.js --days 30 ;;
    stories)
      node collector/ig-stories.js ;;
    links)
      node collector/links.js --days 30 ;;
    listen)
      # As in the workflow: a hashtag failure does not fail the job.
      node collector/listen-hashtags.js || echo "listen-hashtags failed (ignored, as on GitHub)"
      node collector/listen-news.js ;;
    watchdog)
      local rc=0
      node scripts/check-freshness.js --max-age-days 2 || rc=1
      node scripts/check-token-expiry.js --warn-days 21 --fail-days 7 || rc=1
      node scripts/check-access-tokens.js --warn-days 21 --fail-days 7 || rc=1
      node scripts/check-x-health.js || rc=1
      return $rc ;;
    *)
      echo "unknown job: $JOB"; return 2 ;;
  esac
}

run_job
rc=$?
echo "== $(date '+%F %T') $JOB exit $rc"
echo "$(date '+%F %T') exit $rc" > "$LOGS/meta-$JOB.last"

# Failure alert. On GitHub a failed watchdog shows as a red run; here only
# check-freshness.js alerts for itself, so the watchdog alerts too (a stale-data
# failure can therefore alert twice).
#
# ALERT_WEBHOOK_URL was never set on GitHub either (found 2 Nov 2026), so the
# alert that actually reaches Christopher is a Slack DM through the
# parl-monitor runner's bot (tools/alert_failure.py, the same DM its own Mini
# jobs send), quoting the last 15 lines of this job's log. The webhook is
# still posted to when set.
if [ $rc -ne 0 ]; then
  what="collection FAILED"; [ "$JOB" = "watchdog" ] && what="watchdog found a problem"
  hook="$(env_value ALERT_WEBHOOK_URL)"
  if [ -n "$hook" ]; then
    curl -s -X POST -H 'Content-Type: application/json' \
      -d "{\"text\":\"Meta $JOB $what on the Mac Mini (exit $rc). Log: ~/runner/logs/meta-$JOB.log\"}" \
      "$hook" > /dev/null || true
  fi
  PM="$HOME/runner/parl-monitor"
  if [ -f "$PM/tools/alert_failure.py" ]; then
    tail15="$(awk '/^== .* '"$JOB"' start$/{buf=""} {buf=buf $0 "\n"} END{printf "%s", buf}' "$LOG" | tail -n 15)"
    text=":rotating_light: *Meta Reports: $JOB $what* on the Mac Mini (exit $rc).
\`\`\`
${tail15[-2500,-1]}
\`\`\`
Log: ~/runner/logs/meta-$JOB.log · re-run: zsh ~/runner/meta-reports/scripts/mini-collect.sh $JOB"
    # send() never raises: if Slack is down it prints the message instead.
    ( cd "$PM" && printf '%s' "$text" |
      python3 -c 'import sys; sys.path.insert(0, "tools"); import alert_failure; alert_failure.send(sys.stdin.read())' ) ||
      echo "alert DM failed"
  else
    echo "no alert sent: $PM/tools/alert_failure.py not found"
  fi
fi
exit $rc
