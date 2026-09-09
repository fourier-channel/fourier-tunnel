#!/usr/bin/env bash
set -u
# Let Neru-chan (@tunnel) write the media-tag state event, and NOTHING else.
#
# The tag write-back has never worked in a community room: net.41chan.media.tags
# is not named in any room's power levels, so it falls back to state_default 50,
# and @tunnel sits at users_default 0. It only ever worked in the five control
# rooms where the bot happens to hold 100.
#
# Level 10 rather than 50, and rather than 0:
#   0  would let ANY member write tag state, i.e. forge a post's tags.
#   50 would make the bot a moderator in every room (kick, ban, redact, rename).
#   10 grants exactly this one event. Everything else in these rooms is 50, and
#      events_default is already 0, so PL 10 adds nothing but the line below.
#
# STRICTLY ADDITIVE. It never removes a key and never LOWERS an existing value,
# so the five rooms where @tunnel is 100 keep their 100. A room whose power
# levels cannot be read is skipped rather than written with a partial object --
# power_levels is sent whole, so a bad merge could lock people out of a room.
#
# DRY RUN IS THE DEFAULT. Pass --apply to write:
#
#     ssh host 'bash -s' < this            # plan only
#     ssh host 'bash -s -- --apply' < this # writes
#
# It was DRY=1 as an environment variable, and that was a bug I shipped. ssh
# does not forward the caller's environment to the remote shell, so
# `DRY=1 ssh host 'bash -s' < script` sets the variable on the LOCAL machine and
# the remote script never sees it. Run 2026-09-08 that way: the banner said
# DRY=0 and it wrote to fourteen rooms for real. No harm, because this script is
# strictly additive -- but the flag has to fail SAFE rather than rely on being
# delivered, so the default is now the harmless mode and applying takes an
# explicit argument that travels inside the remote command line.

API=http://localhost:8008/_matrix/client/v3
DEV=plfix-20260908
BOT="@tunnel:41chan.net"
EVENT="net.41chan.media.tags"
LEVEL=10
APPLY=0
case "${1:-}" in
  --apply) APPLY=1 ;;
  "") ;;
  *) echo "usage: bash -s [-- --apply]"; exit 2 ;;
esac
DRY=1; [ "$APPLY" = "1" ] && DRY=0

RAW=$(docker exec synapse-mas-1 /usr/local/bin/mas-cli manage \
        issue-compatibility-token -c /config.yaml saber "$DEV" 2>&1)
TOK=$(printf '%s\n' "$RAW" | grep -oE 'mct_[A-Za-z0-9_-]+' | head -1)
if [ -z "$TOK" ]; then
  echo "ABORT: no token parsed. Raw output, long strings masked:"
  printf '%s\n' "$RAW" | sed -E 's/[A-Za-z0-9_-]{16,}/<MASKED>/g'
  exit 1
fi
WHO=$(curl -s -H "Authorization: Bearer $TOK" "$API/account/whoami")
case "$WHO" in
  *'@saber:41chan.net'*)
    if [ "$DRY" = "1" ]; then
      echo "acting as @saber:41chan.net -- DRY RUN, nothing will be written"
      echo "(re-run with: ssh host 'bash -s -- --apply' < this file)"
    else
      echo "acting as @saber:41chan.net -- APPLYING for real"
    fi
    echo ;;
  *) echo "ABORT: unexpected identity: $WHO"; exit 1 ;;
esac

# Rooms the bot is actually in. Read live so the list cannot go stale.
ROOMS=$(docker exec synapse-postgres-1 psql -U synapse -d synapse -At -c \
  "select room_id from current_state_events
    where type='m.room.member' and state_key='$BOT' and membership='join'
    order by room_id;")

enc() { printf '%s' "$1" | sed -e 's/!/%21/g' -e 's/:/%3A/g'; }

changed=0; skipped=0; failed=0
for room in $ROOMS; do
  name=$(docker exec synapse-postgres-1 psql -U synapse -d synapse -At -c \
    "select coalesce(name,'(unnamed)') from room_stats_state where room_id='$room';")
  cur=$(mktemp)
  code=$(curl -s -o "$cur" -w '%{http_code}' \
    -H "Authorization: Bearer $TOK" \
    "$API/rooms/$(enc "$room")/state/m.room.power_levels/")
  if [ "$code" != "200" ]; then
    printf '%-30s FAILED to read power levels (%s)\n' "$name" "$code"
    failed=$((failed+1)); rm -f "$cur"; continue
  fi

  plan=$(python3 - "$cur" "$BOT" "$EVENT" "$LEVEL" <<'PY'
import json, sys
path, bot, event, level = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
pl = json.load(open(path))
users  = pl.setdefault("users", {})
events = pl.setdefault("events", {})
notes = []
# Never lower an existing grant: the control rooms hold this bot at 100.
if int(users.get(bot, pl.get("users_default", 0))) < level:
    users[bot] = level; notes.append(f"user {bot} -> {level}")
if event not in events:
    events[event] = level; notes.append(f"event {event} -> {level}")
if not notes:
    print("SKIP"); sys.exit(0)
print("CHANGE " + "; ".join(notes))
print(json.dumps(pl))
PY
)
  verdict=$(printf '%s\n' "$plan" | head -1)
  if [ "$verdict" = "SKIP" ]; then
    printf '%-30s already correct\n' "$name"; skipped=$((skipped+1)); rm -f "$cur"; continue
  fi
  printf '%-30s %s\n' "$name" "${verdict#CHANGE }"
  if [ "$DRY" = "1" ]; then rm -f "$cur"; continue; fi

  body=$(printf '%s\n' "$plan" | tail -1)
  out=$(mktemp)
  attempt=1
  while [ "$attempt" -le 4 ]; do
    pc=$(curl -s -o "$out" -w '%{http_code}' -X PUT \
      -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' \
      --data "$body" "$API/rooms/$(enc "$room")/state/m.room.power_levels/")
    if [ "$pc" = "429" ]; then
      ms=$(grep -oE '"retry_after_ms"[ :]*[0-9]+' "$out" | grep -oE '[0-9]+$'); [ -n "$ms" ] || ms=5000
      secs=$(( (ms/1000) + 2 )); printf '%-30s   rate limited, waiting %ss\n' "" "$secs"
      sleep "$secs"; attempt=$((attempt+1)); continue
    fi
    if [ "$pc" = "200" ]; then changed=$((changed+1)); else
      printf '%-30s   WRITE FAILED %s %s\n' "" "$pc" "$(head -c 90 "$out")"; failed=$((failed+1)); fi
    break
  done
  rm -f "$out" "$cur"; sleep 1
done

echo
echo "changed=$changed already-correct=$skipped failed=$failed"
echo
echo '--- verification: rooms where the bot still CANNOT write the tag event ---'
docker exec synapse-postgres-1 psql -U synapse -d synapse -c \
"select coalesce(rss.name,left(cse.room_id,20)) as room,
        coalesce(ej.json::jsonb->'content'->'events'->>'$EVENT',
                 ej.json::jsonb->'content'->>'state_default') as needed,
        coalesce(ej.json::jsonb->'content'->'users'->>'$BOT',
                 ej.json::jsonb->'content'->>'users_default') as bot_has
 from current_state_events cse
 join event_json ej on ej.event_id = cse.event_id
 left join room_stats_state rss on rss.room_id = cse.room_id
 where cse.type='m.room.power_levels'
   and cse.room_id in (select room_id from current_state_events
                        where type='m.room.member' and state_key='$BOT' and membership='join')
   and coalesce((ej.json::jsonb->'content'->'users'->>'$BOT')::int,
                (ej.json::jsonb->'content'->>'users_default')::int)
     < coalesce((ej.json::jsonb->'content'->'events'->>'$EVENT')::int,
                (ej.json::jsonb->'content'->>'state_default')::int)
 order by 1;"

if [ "$DRY" != "1" ]; then
  echo '--- ending the session token ---'
  docker exec synapse-postgres-1 psql -U synapse -d mas -c \
    "update compat_sessions set finished_at = now() where device_id = '$DEV' and finished_at is null;"
fi
