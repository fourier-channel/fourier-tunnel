<!-- coherence:hydrated -- canon is fourier-basis/docs/repos/fourier-tunnel/README.md
     Edit canon and run `coherence hydrate`, never this delivered copy.
     An edit here is drift: hydration will refuse to overwrite it and the
     doc axis reports it edited-in-place until someone promotes or discards it. -->
# fourier-tunnel (Booru-Matrix Bridge)

A Matrix **application service** that mirrors images posted in Matrix rooms into
a [Danbooru](https://github.com/danbooru/danbooru)-family image board, tags them
through a separate tagging service, and writes the resulting tags back into the
Matrix room as a queryable state event. It also carries a second bot identity,
Fourier-chan, that greets new accounts and runs an optional onboarding
progression.

Fourier is an umbrella project for targeted data aggregation, classification,
and storage; **fourier-tunnel** (formerly BMB, the Booru-Matrix Bridge) is its
first component.

---

## What it does

1. A user posts an image in a Matrix room the bridge is in.
2. The bridge downloads the image from the homeserver (authenticated media API).
3. It checks the booru by md5. A known image is not re-uploaded; the room's
   tag state is pointed at the existing post.
4. It sends the bytes to the **autotagger** (fourier-spectrum, WD ViT v3) and
   receives tags. Tagging happens here, before any post exists; the booru
   receives finished tags.
5. It creates the booru post with those tags, an artist tag minted from the
   Matrix sender (`41chan_<localpart>`, local users only, promoted to the
   artist category), a rating, and a provenance partition of tag sources.
   Prompt tags scraped from AI-image PNG metadata are kept private: they
   never enter the booru's tag string or the room state.
6. The tags are written into the room as a `net.41chan.media.tags` state
   event, keyed by the image's MXC URI, with the post id, rating, an
   `updated_by` of the bot's localpart, and a `sources` object naming which
   tags came from the creator, the autotagger, both, or metadata.

The image bytes are stored by the homeserver; the booru is fed a copy for
posting. The MXC URI is the link between the two systems. Access to the
underlying media is always enforced by the homeserver's authenticated media
API.

**Backfill.** On joining a room the bot walks the room's history backwards
and replays every image through the same path, up to 500 images and 40 pages
per run, once per room per process. It can only see as far back as the room's
history visibility lets it, and it says how far it got rather than claiming
completeness. An admin can re-run it with `!backfill` in the room.

**Fourier-chan.** When `homeserver.admin_token` is set, a second bot user
polls the homeserver's admin API for new accounts, DMs each one the rules,
invites them to an on-ramp room on a literal "Yes", and joins the space's
rooms to observe. The onboarding **engine** is `off` unless configured;
`fibonacci` scores activity against a goal and publishes a meter state event
in the user's DM, gated by an explicit whitelist with no wildcard; `tiers` is
the older engine. The only privilege-granting step (`on_pass`) is disabled by
default. Read `docs/FIBONACCI-REVIEW.md` before touching the point system.

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
- Node 20 inside the container (a transitive dependency is incompatible with
  Node 22+).

---

## Setup

### 1. Clone and prepare config

    git clone <your-repo-url> fourier-tunnel
    cd fourier-tunnel
    cp config.example.yaml config.yaml
    cp tunnel-registration.example.yaml tunnel-registration.yaml
    cp progression.example.yaml progression.yaml
    cp onboarding-tasks.example.yaml onboarding-tasks.yaml
    mkdir -p onboarding-state

`docker-compose.yaml` needs a `.env` and bind-mounts the three yaml files and
`onboarding-state/` (the onboarding watermark lives there so a rebuild does
not re-greet everyone). The invite-strike ledger and audit log do NOT have a
mount and are lost on `--build`; known gap.

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
(`http://fourier-tunnel:8009`). The users namespace must cover BOTH the
bridge bot and Fourier-chan's localpart or onboarding cannot act.

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
(no code default: unset rejects every invite), `bridge.onramp_room`,
`bridge.display_name`, `bridge.disabled_rooms` (per-room tagging kill
switch), `tag_in_dms`, `default_rating`, and the `bridge.onboarding` block
(engine, whitelist, on_pass).

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

### Admin commands

Sender must be in `bridge.admins`.

- `!backfill` -- in the room to catch up; re-walks even if already done.
- `!listrooms` -- in a DM with the bot; lists the rooms each bot identity is in.
- `!resetstrikes @user:domain` -- in a DM; clears a user's invite strikes.
- `!setavatar` -- in a DM; then post an image within 2 minutes.
- `!join` -- for users: the on-ramp.

---

## Tests

Nine plain `node --test` suites, one per module, no runner:

    for t in *.test.js; do node --test "$t"; done

`coherence.gate.yaml` declares the same command as this repo's gate.
`package.json` has no scripts; `npm test` does nothing.

---

## Security notes

- `config.yaml` (booru API key, admin token) and `tunnel-registration.yaml`
  (appservice tokens) are gitignored. Never commit the real files.
- The bot reads only `m.room.power_levels` during invite authorization.
- Creator-only prompt tags never leave the bridge.

---

## Status / limitations

- Forward tagging works. Reverse sync (editing the state event to update the
  booru) is not implemented; nothing reads the state event inbound.
- Tag-edit permission enforcement is intended to live in a Matrix client.
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
