<!-- coherence:hydrated -- canon is fourier-basis/docs/repos/fourier-tunnel/README.md
     Edit canon and run `coherence hydrate`, never this delivered copy.
     An edit here is drift: hydration will refuse to overwrite it and the
     doc axis reports it edited-in-place until someone promotes or discards it. -->
# fourier-tunnel (Booru-Matrix Bridge)

A Matrix **application service** that mirrors images posted in Matrix rooms into
a [Danbooru](https://github.com/danbooru/danbooru)-family image board, tags them
through a separate tagging service, and writes the resulting tags back into the
Matrix room as a queryable state event. It is the courier, Neru-chan
(`@tunnel`), and nothing else.

**Fourier-chan is not here.** Until 2026-09-25 this appservice also acted as
@fourier: onboarding, the `!join` on-ramp, and `!bugreport`. She now has her own
appservice registration and her own service on the bot hub: fourier-basis
`ops/hetzner/guide/`, whose README is her runbook. Operator: *"Fourier-chan
shouldn't need to run anything through Tunnel. We have a bot hub explicitly so
they are separate entities."*

Fourier is an umbrella project for targeted data aggregation, classification,
and storage; **fourier-tunnel** (formerly BMB, the Booru-Matrix Bridge) is its
first component.

---

## What it does

1. A user posts an image in a Matrix room the bridge is in.
2. The bridge downloads the image from the homeserver (authenticated media API).
3. It reads the image's generation data (AI prompts, settings, workflows) and
   STRIPS it from the bytes, losslessly: whole text chunks, EXIF comment fields
   blanked in place, single XMP properties, NovelAI's alpha-channel copy
   (`strip-generation.js`). Colour profiles, orientation and every other field
   stay. An image whose generation data cannot be removed or verified is NOT
   posted (`[strip] refusing to post`). Operator ruling 2026-09-28.
4. It checks the booru by md5 of the STRIPPED bytes, then by the original's md5
   through the booru's private record, then by the original's own md5 (posts
   made before stripping). A known image is not re-uploaded; the room's tag
   state is pointed at the existing post.
5. It sends the stripped bytes to the **autotagger** (fourier-spectrum, WD ViT v3) and
   receives tags. Tagging happens here, before any post exists; the booru
   receives finished tags.
6. It creates the booru post from the stripped bytes with those tags, an
   artist tag minted from the Matrix sender (`41chan_<localpart>`, local users
   only, promoted to the artist category), `ai-generated` when a generator's
   data was found, a rating, and a provenance partition of tag sources. It then
   records the post's CREATOR (the Matrix sender) with the booru, once, and
   files the stripped generation data in the booru's private store.
   Prompt-derived tags and the generation data are visible ONLY to that
   creator -- no admin or moderator bypass (operator ruling 2026-09-29). They
   never enter the booru's tag string, the image file, or the room state.
7. The tags are written into the room as a `net.41chan.media.tags` state
   event, keyed by the image's MXC URI, with the post id, rating, an
   `updated_by` of the bot's localpart, and a `sources` object naming which
   tags came from the creator, the autotagger, both, or metadata.

The image bytes are stored by the homeserver; the booru is fed a copy for
posting. The MXC URI is the link between the two systems. Access to the
underlying media is always enforced by the homeserver's authenticated media
API.

**Backfill.** On joining a room the bot walks the room's history backwards
and replays every image through the same path, up to 500 images and 40 pages
per run. Where a run stops is kept per room in `backfill-state.json` (the
state directory, below): the cursor to resume from, whether the room's start
was reached, and the pictures that failed. The next run resumes from the
cursor rather than starting again at the newest message, so no room is
limited to what one run can reach. A sweep inside the bridge, every 10 minutes
(first 2 minutes after start), resumes each joined room not yet walked to its
start, one room at a time, skipping a room walked in the last 5 minutes, a
denied or disabled room, and a DM unless `tag_in_dms` is on. A failed picture
is re-read by its event id and retried on the next run (a deleted one is
dropped, never posted from memory); after 5 failures it is set aside under
`abandoned`. A room walked to its start is not walked again by the join
trigger; a real rejoin walks only the gap since the last walk. The bot can
only see as far back as the room's history visibility lets it, and each run's
summary line says whether older history is still unwalked and why the run
stopped. An admin can resume a room with `!backfill`, or walk it again from
the newest message with `!backfill restart`.

---

## Requirements

- A **Synapse** homeserver with `enable_authenticated_media: true`. This
  deployment uses MAS (MSC3861), which changes how the bot user is created
  (see Setup).
- A **chanbooru** instance (the fork, not stock Danbooru): the bridge calls
  fork-only endpoints (`/posts/<id>/tag_sources.json`) and relies on fork
  behaviour for duplicate md5s.
- The **fourier-spectrum** autotagger reachable at `autotagger.url`. Without
  it nothing is tagged.
- **Docker** + **Docker Compose**; the bridge must share Docker networks with
  Synapse, the booru and the tagger.
- Node 22 inside the container, and no higher: nedb (loaded by
  matrix-appservice-bridge for its user and room stores) calls
  `util.isDate`, which Node 23 removed, so the bridge crashes on 23 and 24.
  `package.json` `engines` (`>=22 <23`) with `engine-strict` in `.npmrc`
  makes npm refuse any other Node, and `nedb-compat.test.js` measures the
  boundary on every run. A host `npm install` on another Node is refused too:
  install under Node 22, and `npm run test:image` runs the suite on the
  Dockerfile's base image.

---

## Setup

### 1. Clone and prepare config

    git clone <your-repo-url> fourier-tunnel
    cd fourier-tunnel
    cp config.example.yaml config.yaml
    cp tunnel-registration.example.yaml tunnel-registration.yaml
    mkdir -p onboarding-state

`docker-compose.yaml` needs a `.env` and bind-mounts `config.yaml` and
`onboarding-state/`, mounted at `/state` (`ONBOARDING_STATE_DIR`). Everything
the bridge must keep across a rebuild lives there: the invite-strike ledger,
the audit log, the denied-room list and each room's backfill progress
(`backfill-state.json`). The directory keeps its old name.

### 2. Create a booru bot account

A dedicated user at Builder level with an API key. In the booru's rails
console:

    u = User.create!(name: "tunnel", password: SecureRandom.hex(20),
                     password_confirmation: nil, level: User::Levels::BUILDER)
    k = ApiKey.create!(user_id: u.id, name: "bridge")
    puts k.key

Put the username and key into `config.yaml`.

### 3. The appservice registration

    openssl rand -hex 32   # as_token
    openssl rand -hex 32   # hs_token

Put both into `tunnel-registration.yaml`. `sender_localpart` is the bot's
localpart, and `url` must use the compose `container_name`
(`http://fourier-tunnel:8009`). The users namespace is the bridge bot alone:
Fourier-chan has her own registration (`fourier-guide`), and a namespace that
claimed her would send her events here again.

### 4. Register the appservice with Synapse

Copy the registration into Synapse's data directory and reference it:

    app_service_config_files:
      - /data/tunnel-registration.yaml

Do not provision the bot user by hand. The bridge registers it on startup
with `inhibit_login`, which is the only form this homeserver accepts; two
`M_USER_IN_USE` lines at every start are normal.

### 5. Configure

`config.example.yaml` is annotated. The keys that matter beyond credentials:
`autotagger.*`, `bridge.admins` (who may run admin commands;
`strike_reset_admins` is the deprecated alias), `bridge.invite_power_level`
(no code default: unset rejects every invite), `bridge.display_name`,
`bridge.disabled_rooms` (per-room tagging kill switch), `tag_in_dms` and
`default_rating`.

### 6. Build and run

    docker compose up -d --build
    docker compose logs -f --tail 20

Restart Synapse so it loads the registration.

---

## Usage

### Inviting the bridge to a room

Invite the bot. It stays only if the inviter has power level >=
`invite_power_level`, reading only `m.room.power_levels` to decide.
Unauthorized invites accrue escalating cooldowns (Fibonacci minutes: 1, 1, 2,
3, 5, 8, ...), tracked per user, and the inviter is DMed why. Strikes do not
decay.

### Letting it write tags

The tag state event needs power. Run `tools/grant-tag-write.sh`, which
grants the bot level **10** plus an `events` entry for the tag type at 10,
and refuses to grant 50 because that would make the bot a moderator in
every room. The grant covers only rooms the bot is already in: re-run it
after any new join, or tags in that room silently fail to write. The bot
checks before a backfill and says so in the room when it cannot write.

### Catching up a room the bot joined too late

A room created with `history_visibility: invited` seals every event sent
before a member's invite. A bot invited later can never read that window --
`/messages` omits it, `/event` 404s, `/relations` 403s -- so `!backfill`
reports a number that looks complete and is not. No power level fixes it and
no larger page cap reaches it: the bot is not refused a permission, it is
refused a past.

`tools/catch-up-room.js` reads the room with Synapse's **admin** Room Messages
API, which has no such horizon, and still writes the tag state **as the bot**,
so the bot's own power level continues to govern what it may say. It reports
how many images were sealed, which is the number worth running it for.

It must run on the compose network, because `config.yaml` names Synapse,
danbooru and the tagger by their container hostnames:

```sh
read -s SYNAPSE_ADMIN_TOKEN && export SYNAPSE_ADMIN_TOKEN
docker compose run --rm -e SYNAPSE_ADMIN_TOKEN tunnel \
  node tools/catch-up-room.js --room '!id:41chan.net'          # plan only
docker compose run --rm -e SYNAPSE_ADMIN_TOKEN tunnel \
  node tools/catch-up-room.js --room '!id:41chan.net' --apply  # writes
```

**Dry run is the default**; `--apply` is what writes. The admin token comes
from the environment and never from a flag, because a flag is in the shell
history and in every `ps` listing. `--cap N` bounds the work; `--homeserver`
(or `HOMESERVER_URL`) points it elsewhere, for a Synapse that is not on this
network. It is pointable at any room, which is the point -- any room whose bot
arrived after the pictures did has the same sealed window.

### Admin commands

Sender must be in `bridge.admins`.

- `!backfill` -- in the room to catch up; resumes where the last walk
  stopped, or walks again from the newest message if the room was finished.
  `!backfill restart` always walks again from the newest message -- how tag
  state that was blocked on an earlier run gets written.
- `!listrooms` -- in a DM with the bot; lists the rooms each bot identity is in.
- `!resetstrikes @user:domain` -- in a DM; clears a user's invite strikes.
- `!setavatar` -- in a DM; then post an image within 2 minutes.
- `!leaveroom !id:domain` -- in a DM; the bot leaves that room and will not go
  back, refusing invites there until the denial is lifted. The everyday way to
  do this is simply to remove the bot in your client, which records the same
  denial by itself; this exists for doing it from elsewhere.
- `!rejoinroom !id:domain` -- in a DM; lifts the denial. It does NOT join: the
  way back in is still an invite from somebody with the invite power level.
- `!deniedrooms` -- in a DM; the rooms the bot is deliberately staying out of,
  with who decided and when. Nothing else can show this, since the list is the
  only record of a room the bot is not in on purpose.
- `!rescan <mxc://url | md5>` -- in a DM; reads an already-posted image's own
  metadata again (from the Matrix original, stripped the same way), rewrites
  its creator provenance on the booru and re-files its generation data. Never
  uploads, never re-runs the autotagger, never records or changes the post's
  creator (`capabilities/rescan.js`).

---

## Tests

Plain `node --test` suites, one per module (capabilities included), no
runner -- `node --test` finds them and reports its own count:

    npx --no-install eslint . && node --test

`coherence.gate.yaml` declares the same command as this repo's gate.
`package.json` has no scripts; `npm test` does nothing.

---

## Security notes

- `config.yaml` (booru API key, admin token) and `tunnel-registration.yaml`
  (appservice tokens) are gitignored. Never commit the real files.
- The bot reads only `m.room.power_levels` during invite authorization.
- Generation data leaves the bridge only into the booru's private store, and
  prompt-derived tags only as private rows; both are readable by the post's
  recorded creator alone. The posted file carries neither.

---

## Status / limitations

- Forward tagging works. Reverse sync (editing the state event to update the
  booru) is not implemented; nothing reads the state event inbound.
- Tag-edit permission enforcement is intended to live in a Matrix client;
  `tag_edit_power_level` in the config is read by nothing in the bridge.
- Posts by a Builder-level account land in the booru's moderation queue.
- Measured 2026-09-08: this bridge had produced a few dozen posts against a
  six-figure booru; it matters where the bot is invited, not how fast it runs.

---

## Credits

Code written by Claude (Anthropic). The human counterpart paid the electric
bill and asked the right questions.

---

## License

Licensed under the **GNU Affero General Public License v3.0** (AGPL-3.0). See
`LICENSE`.

If you run a modified version of this software as a network service, the AGPL
requires you to make your modified source available to its users. The copyright
holder may also offer commercial licensing terms separately.
