<!-- coherence:hydrated -- canon is fourier-basis/docs/repos/fourier-tunnel/README.md
     Edit canon and run `coherence hydrate`, never this delivered copy.
     An edit here is drift: hydration will refuse to overwrite it and the
     doc axis reports it edited-in-place until someone promotes or discards it. -->
# fourier-tunnel (Booru-Matrix Bridge)

A Matrix **application service** that mirrors images posted in Matrix rooms into a
[Danbooru](https://github.com/danbooru/danbooru) instance, auto-tags them, and writes the
resulting tags back into the Matrix room as a queryable state event.

Fourier is an umbrella project for targeted data aggregation, classification, and storage;
**fourier-tunnel** (formerly BMB, the Booru-Matrix Bridge) is its first component.

---

## What it does

1. A user posts an image in a Matrix room the bridge is in.
2. The bridge downloads the image from your homeserver (authenticated media API).
3. It uploads the image to Danbooru, which processes and auto-tags it.
4. The bridge creates a Danbooru post and reads its tags back.
5. The tags are written into the Matrix room as a `net.<domain>.media.tags` state event,
   keyed by the image's MXC URI — ready for a client to render and edit.

The image bytes are stored by your homeserver (e.g. in S3/R2); Danbooru is fed a copy for
tagging. The Matrix MXC URI is the link between the two systems. Access to the underlying
media is always enforced by the homeserver's authenticated media API.

---

## Requirements

- A working **Synapse** homeserver with `enable_authenticated_media: true`.
- A working **Danbooru** instance with its autotagger service running.
- **Docker** + **Docker Compose**.
- The bridge and your Synapse/Danbooru containers must share Docker networks.
- Node 20 is used inside the container (the dependency `nedb` is incompatible with Node 22+).

---

## Setup

### 1. Clone and prepare config

    git clone <your-repo-url> bmb
    cd bmb
    cp config.example.yaml config.yaml
    cp bmb-registration.example.yaml bmb-registration.yaml

### 2. Create a Danbooru bot account

Create a dedicated Danbooru user (Builder level is sufficient) and generate an API key.
In a Danbooru rails console:

    u = User.create!(name: "bmb", password: SecureRandom.hex(20),
                     password_confirmation: nil, level: User::Levels::BUILDER)
    k = ApiKey.create!(user_id: u.id, name: "bridge")
    puts k.key

Put the username and key into config.yaml.

### 3. Generate appservice tokens

    openssl rand -hex 32   # as_token
    openssl rand -hex 32   # hs_token

Put both into bmb-registration.yaml, and set sender_localpart, id, and the url the
homeserver uses to reach the bridge (e.g. http://bmb:8009).

### 4. Register the appservice with Synapse

Copy the registration into Synapse's data directory and reference it in homeserver.yaml:

    app_service_config_files:
      - /data/bmb-registration.yaml

Then provision the bot user (required before it can be invited), using the as_token:

    curl -s -X POST "http://localhost:8008/_matrix/client/v3/register" \
      -H "Authorization: Bearer <AS_TOKEN>" \
      -H "Content-Type: application/json" \
      -d '{"type":"m.login.application_service","username":"bmb"}'

### 5. Configure the bridge

Edit config.yaml: homeserver URL/domain, Danbooru URL/credentials, invite_power_level,
strike_reset_admins, default_rating, and tag_in_dms.

### 6. Networking

The bridge must join the Docker networks of both Synapse and Danbooru. Edit
docker-compose.yaml so the networks section lists your actual external network names, and
ensure container_name matches the host name in the registration url.

### 7. Build and run

    docker compose up -d --build
    docker compose logs -f --tail 20

Restart Synapse so it loads the registration:

    cd /path/to/synapse && docker compose restart synapse

---

## Usage

### Inviting the bridge to a room

Invite the bot user to a room. It stays only if the inviter has power level >=
invite_power_level (default 100). It reads only m.room.power_levels to decide. Grant the
bot power level 50 so it can write tag state events.

Unauthorized invite attempts accrue escalating cooldowns (Fibonacci minutes: 1, 1, 2, 3,
5, 8, ...), tracked per user. Strikes do not decay.

### Admin commands (DM only)

- !resetstrikes @user:domain — clear a user's invite strikes (sender must be in
  strike_reset_admins).
- !setavatar — then post an image within 2 minutes to set the bot's avatar.

---

## How tags are stored

Tags are a Matrix state event of type net.<domain>.media.tags, with the state key set to
the image's MXC URI:

    {
      "post_id": 3,
      "tags": ["tag_a", "tag_b"],
      "rating": "q",
      "updated_by": "bmb",
      "updated_at": 1781135617394
    }

---

## Security notes

- config.yaml (Danbooru API key) and bmb-registration.yaml (appservice tokens) contain
  secrets and are gitignored. Never commit the real files — only the .example versions.
- The bot reads only m.room.power_levels from rooms during invite authorization.
- Authenticated media must be enabled on Synapse so exposed MXC URIs are not a leak vector.

---

## Status / limitations

- Forward tagging (Matrix -> Danbooru -> Matrix state) works. Reverse sync (editing the
  state event to update Danbooru) is not yet implemented.
- Tag-edit permission enforcement (power level >= 25) is intended to live in a Matrix client.
- Posts created by a Builder-level bot account land in Danbooru's moderation queue.

---

## Credits

Code written by Claude (Anthropic). The human counterpart paid the electric bill and asked
the right questions.

---

## License

Licensed under the **GNU Affero General Public License v3.0** (AGPL-3.0). See `LICENSE`.

If you run a modified version of this software as a network service, the AGPL requires you
to make your modified source available to its users. The copyright holder may also offer
commercial licensing terms separately.
