// The ONE homeserver URL this process talks to, resolved once.
//
// WHY THIS IS ITS OWN MODULE. config.yaml says http://synapse:8008 -- the
// compose network's name for Synapse, which resolves inside the bridge
// container and nowhere else. That is correct for the bridge and unreachable
// for anything run on the host, and until now the two facts lived in different
// places: tools/catch-up-room.js resolved a URL for its own paging while
// index.js's downloadFromSynapse kept using the configured one. The first real
// catch-up run printed "homeserver : http://localhost:8008", walked the room
// with it perfectly well, and then failed all 419 images with
// "getaddrinfo EAI_AGAIN synapse" -- because the half doing the downloading had
// never been told. A second override path is what caused that; one resolved
// value is the fix, not a third.
//
// THIS IS AN OVERRIDE, NOT A FALLBACK. There is exactly one valid homeserver
// and the operator is naming where it answers from HERE. Nothing retries, no
// second candidate is tried when the first fails, and a wrong value fails
// loudly on the first request. The forbidden shape is "one valid supplier that
// also quietly accepts an invalid one"; this is the same supplier by a
// different route.
//
// It lives outside index.js because index.js reads config.yaml and the
// registration at module scope, and both are gitignored -- so index cannot be
// required on a machine that is not the box, and anything defined in it cannot
// be tested. That is precisely why this resolution went untested and wrong.

"use strict";

/**
 * @param {object} env      process.env, injected so it is testable
 * @param {string} configured  homeserver.url as config.yaml states it
 * @returns {string} an absolute URL with no trailing slash
 */
function resolveHomeserverUrl(env, configured) {
  // A variable set to nothing is a variable nobody set: `HOMESERVER_URL= node x`
  // is how a shell spells "unset" by accident, and honouring it would point the
  // bridge at "" and fail somewhere far away from the cause.
  const raw = env && typeof env.HOMESERVER_URL === "string" ? env.HOMESERVER_URL.trim() : "";
  const chosen = raw || configured;
  if (typeof chosen !== "string" || !/^https?:\/\/\S+$/.test(chosen.trim())) {
    throw new Error(
      `homeserver url must be an absolute http(s) URL, got ${JSON.stringify(chosen)}. ` +
      "Set HOMESERVER_URL, or fix homeserver.url in config.yaml.",
    );
  }
  return chosen.trim().replace(/\/+$/, "");
}

module.exports = { resolveHomeserverUrl };
