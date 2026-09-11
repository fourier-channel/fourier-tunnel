const fs = require("fs");
const path = require("path");

// In the mounted state directory, NOT beside the code. Beside the code they
// lived inside the image, and every `docker compose up --build` threw the
// strike ledger away -- the ledger the README calls non-decaying. Same
// mount and same variable the onboarding watermark moved to after the
// 2026-09-05 re-greeting incident; without the variable (tests, host dev)
// they fall back to the old place.
const STATE_DIR = process.env.ONBOARDING_STATE_DIR || __dirname;
const STRIKES_PATH = path.join(STATE_DIR, "strikes.json");
const AUDIT_PATH = path.join(STATE_DIR, "audit.log");

function loadStrikes() {
  try {
    return JSON.parse(fs.readFileSync(STRIKES_PATH, "utf8"));
  } catch (e) {
    return {};
  }
}

function saveStrikes(state) {
  const tmp = STRIKES_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STRIKES_PATH);
}

function audit(record) {
  const line = JSON.stringify({ ts: Date.now(), ...record }) + "\n";
  fs.appendFileSync(AUDIT_PATH, line);
}

function fibMinutes(n) {
  let a = 1, b = 1;
  for (let i = 1; i < n; i++) {
    [a, b] = [b, a + b];
  }
  return a;
}

function formatDuration(minutes) {
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (m === 0) return `${h} hour${h === 1 ? "" : "s"}`;
  return `${h}h ${m}m`;
}

function powerLevelsFromStrippedState(event) {
  const stripped =
    (event.invite_room_state) ||
    (event.unsigned && event.unsigned.invite_room_state) ||
    [];
  const ple = stripped.find((e) => e.type === "m.room.power_levels");
  return ple ? ple.content : null;
}

function inviterLevel(powerLevels, inviter) {
  if (!powerLevels) return null;
  const users = powerLevels.users || {};
  if (Object.prototype.hasOwnProperty.call(users, inviter)) {
    return users[inviter];
  }
  return powerLevels.users_default || 0;
}

function rejectionMessage(strikeNum, requiredLevel, joined) {
  const thisTimeout = fibMinutes(strikeNum);
  const nextTimeout = fibMinutes(strikeNum + 1);
  const action = joined ? "so I've left" : "so I'm not joining";

  if (strikeNum === 1) {
    return (
      `I can only be added to a room by someone with power level ${requiredLevel} or higher in that room. ` +
      `It looks like that check didn't pass, ${action} — I'm assuming this was a mistake. ` +
      `If you believe you should be able to add me, please contact a server admin rather than trying repeatedly. ` +
      `Repeated attempts trigger escalating cooldowns. ` +
      `(Current cooldown: ${formatDuration(thisTimeout)}. Next attempt: ${formatDuration(nextTimeout)}.)`
    );
  }

  const repeatAction = joined ? "I've left again" : "I'm still not joining";
  return (
    `You still don't meet the requirement (power level ${requiredLevel}+ in the room). ` +
    `${repeatAction}. Current cooldown: ${formatDuration(thisTimeout)}. ` +
    `Next attempt: ${formatDuration(nextTimeout)}. ` +
    `Please contact a server admin instead of continuing to try.`
  );
}

// In-memory per-user lock: user IDs currently being processed.
const inFlight = new Set();

// Decide and act on an invite. deps = { join, leave, sendDM, readPowerLevels }
async function handleInvite(event, deps, config) {
  const inviter = event.sender;
  const roomId = event.room_id;
  const requiredLevel = config.bridge.invite_power_level;

  if (inFlight.has(inviter)) {
    audit({ kind: "invite_dropped_inflight", room: roomId, inviter });
    return "dropped_inflight";
  }
  inFlight.add(inviter);

  try {
    const state = loadStrikes();
    const rec = state[inviter] || { strikes: 0, until: 0 };

    const now = Date.now();
    if (rec.until && now < rec.until) {
      audit({ kind: "invite_ignored_cooldown", room: roomId, inviter,
              until: rec.until, strikes: rec.strikes });
      return "ignored_cooldown";
    }

    audit({ kind: "invite_received", room: roomId, inviter });

    let pl = powerLevelsFromStrippedState(event);
    let joined = false;

    if (!pl) {
      await deps.join(roomId);
      joined = true;
      pl = await deps.readPowerLevels(roomId);
    }

    const level = inviterLevel(pl, inviter);

    if (level !== null && level >= requiredLevel) {
      if (!joined) await deps.join(roomId);
      if (state[inviter]) {
        state[inviter].until = 0;
        saveStrikes(state);
      }
      audit({ kind: "invite_accepted", room: roomId, inviter, level });
      return "accepted";
    }

    const strikeNum = rec.strikes + 1;
    const cooldownMs = fibMinutes(strikeNum) * 60 * 1000;
    state[inviter] = { strikes: strikeNum, until: Date.now() + cooldownMs };
    saveStrikes(state);

    if (joined) await deps.leave(roomId);

    audit({ kind: "invite_rejected", room: roomId, inviter,
            level: level === null ? "unknown" : level,
            strike: strikeNum, joined, cooldown_min: fibMinutes(strikeNum) });

    try {
      await deps.sendDM(inviter, rejectionMessage(strikeNum, requiredLevel, joined));
    } catch (e) {
      audit({ kind: "dm_failed", inviter, error: e.message });
    }
    return "rejected";
  } finally {
    inFlight.delete(inviter);
  }
}

module.exports = {
  loadStrikes,
  saveStrikes,
  audit,
  fibMinutes,
  formatDuration,
  powerLevelsFromStrippedState,
  inviterLevel,
  rejectionMessage,
  handleInvite,
  STRIKES_PATH,
  AUDIT_PATH,
};
