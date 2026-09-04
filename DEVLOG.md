<!-- coherence:hydrated -- canon is fourier-basis/docs/repos/fourier-tunnel/DEVLOG.md
     Edit canon and run `coherence hydrate`, never this delivered copy.
     An edit here is drift: hydration will refuse to overwrite it and the
     doc axis reports it edited-in-place until someone promotes or discards it. -->
# Fourier — BMB (Booru-Matrix Bridge) Dev Log

**Project:** Fourier (targeted data aggregation, classification, storage)
**Component:** BMB (Booru-Matrix Bridge)
**Location:** /opt/fourier/tunnel/  ·  Repo: fourier-channel/fourier-tunnel
**Status:** Core pipeline built, deployed, and verified end to end.

---

## 1. What this is

Fourier BMB connects the Matrix homeserver (Synapse, 41chan.net) to the Danbooru instance
so that images posted in Matrix rooms are automatically mirrored into Danbooru, auto-tagged,
and have their tags written back into the Matrix room as a queryable state event. It runs as
a Matrix application service (appservice), not a bot user logging in with a password.

"Fourier" is the umbrella project; "BMB" is the first component. Component-level identifiers
(bmb, the bot user, the container, the Danbooru account) stay named bmb; project-level
concerns (directory root, appservice id, branding) carry the Fourier name.

---

## 2. Final architecture

A user posts an image in a Matrix room. Synapse stores the media (in R2 via the authenticated
media API) and the appservice pushes the event to the bridge. The bridge then:

1. Downloads the image bytes from Synapse (authenticated media endpoint, using the as_token).
2. POSTs the bytes to Danbooru as a multipart upload.
3. Polls the upload until processing completes.
4. Creates a Danbooru post referencing the processed upload_media_asset.
5. Reads the post's tags back.
6. Writes the tags into the room as a state event (net.41chan.media.tags, keyed by MXC URI).

A future custom Matrix client renders and edits those tags.

Key design decisions:

- No duplicate storage by design. The bridge stores the MXC URI as the link between systems.
  Synapse owns the media (in R2); Danbooru is fed a copy for processing/tagging. Permission
  enforcement stays with Synapse's authenticated media API — possessing an MXC URI does not
  grant access to the bytes.
- Authenticated media confirmed on (enable_authenticated_media: true), so the legacy
  unauthenticated media endpoint is not a leak vector for exposed MXC URIs.
- Tags live in Matrix room state (net.41chan.media.tags), keyed by MXC URI, so they are
  mutable, room-scoped, and readable by any authorized client.

---

## 3. Files

All under /opt/fourier/bmb/:

- index.js — Main bridge: appservice setup, event routing, image pipeline, invite routing,
  admin commands, avatar flow.
- danbooru.js — Danbooru API client: multipart byte upload, poll, create post, read/update tags.
- invites.js — Invite authorization: strike state, audit log, Fibonacci timeouts, power-level
  extraction, rejection messages.
- config.yaml — Settings, Danbooru credentials, admin list, power-level thresholds, DM toggle.
- bmb-registration.yaml — Appservice registration (also copied into Synapse's data dir).
- Dockerfile — Node 20 image build.
- docker-compose.yaml — Runs as container bmb on synapse_default and danbooru_default networks.
- strikes.json (runtime) — persistent per-user strike counts.
- audit.log (runtime) — JSONL audit trail of invite decisions.

---

## 4. Invite authorization model

The bot only operates in rooms it is invited to, and self-polices who may invite it.

- Anyone may attempt to invite the bot. The bot reads only the room's m.room.power_levels
  event to decide — nothing else — preserving privacy.
- Required power level to invite: 100 (configurable via invite_power_level).
- Fast path: the bot reads the inviter's power level from the invite's stripped state
  (invite_room_state), which Synapse includes by default, and decides without joining. So
  rejected invites touch no room data at all.
- Fallback: if stripped state lacks power levels, the bot joins, reads power-levels state,
  then leaves if the inviter is under threshold (join-then-verify).
- Race protection: a per-user in-flight lock drops concurrent duplicate invites; the cooldown
  check-and-set is synchronous before any await, so a flood cannot force multiple joins.

### Strike system

- Timeout for strike N = the Nth Fibonacci number, in minutes (1, 1, 2, 3, 5, 8, ...), uncapped.
- Attempts during an active cooldown are ignored (logged, not counted).
- Strikes do not decay. A successful authorized invite clears the active cooldown but preserves
  the strike count, so a chronically-failing user resumes climbing.
- Rejection messages tell the user the current cooldown and the next one, and whether the bot
  "left" (join-then-verify) or "isn't joining" (fast path).
- Admin reset: an admin in strike_reset_admins sends !resetstrikes @user:domain in a DM to the
  bot. DM-only (verified by 2-member room).

All invite decisions are appended to audit.log as JSONL for later abuse analysis.

---

## 5. Tagging pipeline notes

- The bot must be power level 50 in a room to write the net.41chan.media.tags state event
  (Matrix state_default). Current approach: the inviting admin grants the bot PL 50 on invite.
- Auto-created posts use a default rating of q (questionable) — the most conservative sensible
  default for arbitrary uploads; correct later via tag editing.
- Danbooru's autotagger (danbooru-autotagger-1, reachable as autotagger:5000) runs automatically
  during Danbooru's own upload processing — the bridge does not call it directly.
- Posts created by the bmb Danbooru account (Builder level) land as is_pending: true (moderation
  queue). Worth revisiting if auto-approval is desired.

### Danbooru API specifics (this fork)

- Upload is a multipart POST to /uploads.json with field upload[files][0]. Supplying file bytes
  (not a source URL) makes Danbooru process synchronously.
- Post creation: POST /posts.json with upload_media_asset_id at the top level (the
  upload_media_assets[0].id, NOT the media_asset_id), and post: { rating, tag_string, source }
  nested. Getting this wrong returns a 404 (RecordNotFound in PostsController#create).
- rating is mandatory; a post cannot be created without one.

---

## 6. DM handling

- DM tagging is off by default (tag_in_dms: false): images in 2-member rooms are not fed to
  Danbooru. Toggle to true to tag DMs.
- Avatar setting via DM: an admin sends !setavatar in a DM, then posts an image within 2 minutes;
  the bot points its avatar at that image's MXC URI. The pending request expires after 2 minutes.
  Avatar images are never tagged regardless of the DM-tagging toggle. (Element has no reliable
  image-caption field, so the flow is command-then-image.)
- Display name is set to Fourier on startup.

---

## 7. Deployment specifics / gotchas encountered

- Node version: the container runs Node 20, not 24. matrix-appservice-bridge depends on nedb,
  which calls the removed util.isDate and crashes on Node 22+. Node 20 is the practical ceiling
  while that dependency remains.
- Cross-project Docker networking: the bridge is its own compose project but attaches to
  synapse_default and danbooru_default as external networks. container_name: bmb is mandatory so
  Synapse can resolve http://bmb:8009 from the registration.
- MTU: synapse_default uses MTU 1300, danbooru_default uses 1500. The bridge has one interface
  per network and each connection negotiates its own MSS, so the mismatch is benign here.
- Appservice user provisioning: the bot user @bmb had to be explicitly registered via the
  appservice /register endpoint (m.login.application_service with the as_token) before invites
  worked — ensureRegistered() reported success from cache without writing a user row, causing
  profile lookups to 404.
- Image storage permissions: Danbooru's /images bind mount (/mnt/storage/danbooru-images) was
  root-owned; the container runs as uid 1000, so it could not write variant directories. Fixed
  with chown -R 1000:1000. Note uid 1000 on the host is the user's dev account, so that account co-owns the
  directory (benign on a single-admin host).
- Config path inside container: index.js loads config.yaml via path.join(__dirname, ...), not an
  absolute host path, so it resolves to /app inside the container.

---

## 8. Operational reference

Project location: /opt/fourier/tunnel

Rebuild + restart the bridge:
  docker compose up -d --build

Follow logs:
  docker compose logs -f --tail 20

Restart Synapse (needed when the registration changes):
  cd /opt/synapse && docker compose restart synapse

- Appservice id: fourier-tunnel
- Bot user: @tunnel:41chan.net (display name "Fourier")
- Danbooru bot account: tunnel (user id 4, level 35)
- Tag state event type: net.41chan.media.tags (state key = image MXC URI)
- Bridge listens on port 8009 (internal to the Docker networks; not published to host)

---

## 9. What's next / deferred

1. Reverse tag sync (Matrix -> Danbooru). Only the forward path is built. Editing the Matrix
   state event does not yet push back to Danbooru. danbooru.js already has updateTags() with
   old_tag_string concurrency handling ready for this.
2. Tag-edit permissions. Intended model: power level >= 25 may edit tags. Threshold exists in
   config (tag_edit_power_level: 25) but enforcement lives in the not-yet-built Matrix client.
3. Per-room tagging disable flag. disabled_rooms exists in config and is honored, but there is
   no command to manage it yet.
4. is_pending posts. Builder-level uploads queue for moderation. Decide whether the bridge
   account should auto-approve.
5. Secret rotation. The Danbooru API key for bmb appeared in setup history; rotate it once
   convenient.
6. Future Fourier components. The /opt/fourier/<component>/ structure is set up for additional
   components (e.g. fourier-auth, fourier-dmb). Decide whether future components are independent
   appservices or modules within one appservice.

---

Development log for the Fourier BMB build.

---

## 10. Incident: bot tagged images from rooms it was never invited to (2026-06-14)

**Symptom:** BMB created Danbooru posts for images uploaded in rooms it had
never been invited to, despite being a member of only one real room.

**Root cause (the actual leak):** `bmb-registration.yaml` had a second `users`
namespace entry — `{ exclusive: false, regex: "@.*" }` — alongside the intended
exclusive `@bmb` claim. Appservice event routing delivers a service all events
in any room containing a user that matches its user namespace. `@.*` matches
every user, so every room matched, and Synapse firehosed ALL room events
homeserver-wide to BMB. The invite gate was never involved because no
invite/join was needed — events arrived directly. `rooms: []` was correct and
not the cause; the leak was entirely the wildcard user namespace.

**Fix (two layers, defense-in-depth):**
1. Registration: removed the `@.*` entry, leaving only the exclusive `@bmb`
   claim. Now Synapse only delivers events for rooms the bot is actually in.
   (This file is gitignored; the fix is not in git history — recorded here.)
2. Code (committed): added `botIsJoined()` and an `onEvent` guard that returns
   early — ACKing the transaction — for any non-invite event from a room the bot
   isn't joined to, instead of trying to act/join and erroring. Sits after the
   invite block so invite authorization is unaffected.

**Secondary issues untangled during the fix:**
- **Token rotation.** The appservice `as_token`/`hs_token` were rotated (they had
  been exposed). Both must be byte-identical in `/opt/synapse/data/bmb-registration.yaml`
  AND `/opt/fourier/bmb/bmb-registration.yaml`. After editing, the Synapse copy
  must be re-`chown 991:991` + `chmod 600` (sed -i resets ownership; Synapse
  reads it as uid 991 and crash-loops on PermissionError otherwise).
- **Stuck transaction backlog.** While the namespace was still wide and BMB was
  erroring, Synapse queued appservice transactions and could not advance
  (delivery is in-order; the stream blocks until the bridge returns 200). The
  `botIsJoined` guard let BMB ACK the un-actionable foreign-room events and drain.
- **Orphan registration.** Synapse held appservice state for a stale id
  `booru-matrix-bridge` (the pre-Fourier id) in addition to the current
  `fourier-bmb`. The orphan had permanently-undeliverable txns (no consumer).
  Purged with:
    DELETE FROM application_services_txns WHERE as_id = 'booru-matrix-bridge';
    DELETE FROM application_services_state WHERE as_id = 'booru-matrix-bridge';
- **Recoverer backoff.** An appservice marked `down` after failures is retried by
  Synapse's recoverer on a backoff timer, not instantly. Mid-diagnosis the
  streams looked permanently stuck when they were just inside the backoff window;
  the recoverer then drained all pending txns (200s) and flipped `fourier-bmb`
  back to `up` on its own. Inspect with:
    SELECT as_id, state FROM application_services_state;
    SELECT as_id, COUNT(*) FROM application_services_txns GROUP BY as_id;

**Verified:** image posted in the legitimate room tags correctly; re-uploads of
the same md5 are deduped by Danbooru; no foreign-room rooms produce any activity.

**Note for later:** BMB's startup still calls `ensureRegistered()`
(`/_matrix/client/v3/register`, m.login.application_service). Under MSC3861 MAS
owns registration, so this can log `M_UNKNOWN_TOKEN: failed to register bot
user`. `@bmb` already exists, so it's a harmless no-op, but the call should be
made tolerant of that rejection (catch + log "skipped, MAS-owned") to avoid a
misleading startup error.

---

## 11. Image dedup by md5 (2026-06-14)

**Problem:** Re-posting an already-uploaded image produced `[error] onEvent:
Request failed with status code 500`. Danbooru-side cause (this fork):
`PG::InFailedSqlTransaction` at `upload.rb:187 process_upload!` — a duplicate
md5 trips a failed statement, and the transaction stays poisoned, returning 500
rather than a clean duplicate response.

**Fix (BMB side, the correct place):**
- `danbooru.js`: `findPostByMd5(md5)` — queries `GET /posts.json?tags=md5:<hash>`
  and returns the existing post or null.
- `index.js` `handleImageEvent`: after downloading the bytes, compute the md5
  (`crypto`), call `findPostByMd5`. If a post exists, write the room's
  `net.41chan.media.tags` state event pointing at the EXISTING post (so the new
  room is still correctly tagged) and `return` with `[skip] duplicate md5 ->
  existing post #N`, skipping the upload that would 500. Uses the existing post's
  actual `rating` (falling back to default), since a known post may already have
  a corrected rating.

**Why BMB-side (not Synapse):** BMB sees images only after they're in Matrix, so
this prevents duplicate *Danbooru posts*. It does NOT prevent duplicate *Matrix
uploads* (Synapse mints a fresh MXC per upload by design). Pre-upload dedup at
drag time is a planned feature for the custom Matrix client, where the md5 check
can happen before the bytes reach Synapse and an existing MXC can be reused.

**Verified:** new images tag normally (#19–#21); a re-post of #21 logged
`[skip] duplicate md5 ... -> existing post #21` with no 500; md5 granularity
correctly distinguished a lowres vs highres variant as separate posts.

---

## Renamed to fourier-tunnel (2026-08-13)

Operator decision, taken deliberately before launch because one part of it
cannot be taken after: **Synapse has no rename for a user id.** `@bmb` could
only be abandoned and replaced, and at the time of the change that cost 9 room
memberships, 42 events and one access token. After launch it would have cost
every room the bridge sits in and every message it had ever sent.

The narrative sections above are left exactly as written. They describe things
that happened to a component called BMB, and editing them so the name was always
"tunnel" would make the record lie about the moment it is recording.

What changed:

| | before | after |
|---|---|---|
| repo | fourier-channel/fourier-bmb | fourier-channel/fourier-tunnel |
| path | /opt/fourier/bmb | /opt/fourier/tunnel |
| container | bmb | fourier-tunnel |
| appservice id | fourier-bmb | fourier-tunnel |
| bot user | @bmb:41chan.net | @tunnel:41chan.net |
| registration | bmb-registration.yaml | tunnel-registration.yaml |
| booru account | bridge (id 4) | tunnel (id 4) |

The container name is load-bearing, not cosmetic: Synapse resolves the bridge by
the hostname in the registration's `url`, so `container_name: fourier-tunnel`
and `url: http://fourier-tunnel:8009` are one fact written twice.

### Two things this uncovered

**The registration copies had drifted, in the direction of the section 9
incident.** The repo copy still carried the `- exclusive: false / regex: "@.*"`
entry whose removal WAS the fix for that incident; only Synapse's copy had been
corrected. Nothing could have caught it: the file is gitignored because it holds
the tokens, so there was no tracked copy to diff against. The new pair is
byte-identical and carries the reason in a comment, so the next person to look
at it is told why the namespace is one user before they are tempted to widen it.

**`ensureRegistered()` has been failing since MAS was introduced.**
matrix-appservice-bridge posts a plain appservice registration; this homeserver
answers `IO.ELEMENT.MSC4190.M_APPSERVICE_LOGIN_UNSUPPORTED` -- "this server uses
OAuth2, so the inhibit_login parameter must be set to true". The library has no
way to pass it. Nobody noticed for one reason: `@bmb` predated MAS, so the
failing call was always a no-op on an account that already existed. It surfaced
the instant a bot user genuinely had to be created -- the bridge logged that it
had ensured its user, then 500'd setting a display name on an account that did
not exist. Replaced with `ensureBotUser()`, which sends `inhibit_login: true`
and treats `M_USER_IN_USE` as success.

### The booru login broke, silently, the moment the account was renamed

Danbooru authenticates every API call on `login` + `api_key`, and `login` is the
account NAME, not its id. So renaming user id 4 from `bridge` to `tunnel` --
which the audit trail records properly and which leaves every existing post
attributed correctly, because attribution follows the id -- invalidated the
credentials of the one service authenticating as it. `config.yaml` still said
`username: "bridge"`, and the booru answered `401 Invalid API key` to everything
the bridge asked: image upload, post creation, tag write-back, all of it.

Nothing would have reported this. The bridge starts cleanly, joins nothing,
logs nothing at boot about the booru, and only fails at the moment an image is
posted in a room -- and it is in no rooms yet. fourier-sampling's health board
watches the sampling pipeline's own booru account, which was never involved.

The rule worth keeping: **a danbooru rename is a credential change for anything
logging in as that account.** Grep for the old name in every config on the box
before considering the rename done.

### Still to do, and it needs a human

`@tunnel` is registered, named, and running, but it is in **no rooms**. The
Synapse admin API cannot force-join it: the virtual `@__oidc_admin` is not a
member of any of them, and no API can manufacture an invite for an invite-only
room nobody controls is in. So the six rooms below need an invite from someone
with power in them, plus the power level `@bmb` held, which does not transfer:

| room | name | `@bmb` PL |
|---|---|---|
| `!jeEGyrShDSyjWSBXJo:41chan.net` | 41chan | 100 |
| `!PpxnLPJGjoJwxhsUXq:41chan.net` | under construction (matrix) | 50 |
| `!HMKSUVgJmlAomYlnVo:41chan.net` | (unnamed) | 100 |
| `!zBNtTtppVJTKobMIAK:41chan.net` | (unnamed) | 100 |
| `!eDSrvEOcHoRyvYjgaj:41chan.net` | (unnamed) | 100 |
| `!xwDBNmjNRsOmGfFYBa:matrix.org` | (unnamed, remote) | 100 |

All three bot commands -- `!join`, `!resetstrikes`, `!setavatar` -- are DM-only,
and a DM is a room. Four of the six above ARE those DMs, with `@notsaber`,
`@glorpodorpo` and `@saber`. They cannot be migrated: `@tunnel` is not in them,
and `@bmb` no longer receives anything either now that the `fourier-bmb`
appservice is unloaded, so they are dead in both directions. Those conversations
have to be restarted as fresh DMs with `@tunnel`.

`!join` needs the room work on top of that: `onramp_room` is the 41chan room, so
the bot must be joined there AND hold invite power before the command can do
what it says.

`@bmb` is left in place, joined and untouched. It is the only thing that can
still speak in those rooms until `@tunnel` is invited, and deleting it would
throw away the record of what the bridge did under its old name.

## 2026-09-04 -- Fourier-chan greets every new user

Operator ask: "@fourier:41chan.net, Fourier-chan to start a fresh DM with
every new user to the site. Wherein she tells them the server's rules and
asks them if they agree." She assumes the old "message the bot !join" step;
!join stays as the fallback for anyone who closes the DM.

`onboarding.js`: a poll of the Synapse admin users API (nothing pushes "a
user registered" at an appservice) ordered by creation, watermarked in
onboarding-state.json -- first run seeds the watermark to NOW so an empty
state file means "greet arrivals from here on", never "DM the backlog".
New local users get a fresh DM with the rules; "Yes" (the one GO -- anything
else re-asks and never invites) earns the invite to onramp_room plus the
accept hint pointing at where the invite lands in the client. Fail-soft: no
admin_token means the watch logs once and stays off; a failed greet retries
next poll; the tagging pipeline is untouched by any of it.

Smoke-tested with stubbed intent + fetch: watermark skip, bot-account skip,
rules DM, non-yes re-ask (no invite), wrong-room ignore, Yes -> invite,
pending cleared, audit trail complete.

DEPLOY notes (gated, not done here):
- The rename to @fourier is the REGISTRATION's sender_localpart -- index.js
  now derives botUserId from it instead of hardcoding @tunnel. On next boot
  ensureBotUser creates @fourier via the MAS inhibit_login path (the same
  machinery that bit us when @bmb was renamed).
- config.yaml needs homeserver.admin_token (see config.example.yaml) or the
  watch stays off.
- Dockerfile already ships *.js, so onboarding.js rides along (the per-file
  COPY foot-gun that bit three times does not bite here).
