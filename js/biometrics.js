/* =============================================
   EIPS — Biometrics Layer (js/biometrics.js)

   Fingerprint verification only (no facial recognition anywhere in
   the app — students upload a registration photo instead):

   1. WebAuthn (navigator.credentials) — talks to a laptop's Windows
      Hello / Mac Touch ID sensor from inside the browser. Requires a
      secure context (HTTPS, or http://localhost while testing).
      IMPORTANT LIMITATION (real, not a bug): a WebAuthn credential is
      bound to the device/authenticator that created it, so
      re-verification must happen on the SAME device it was
      enrolled on.

   2. Exam-scanner bridge (section 3 below) — the ZK9500 scanner
      attached to the exam PC. This is the primary exam-day path:
      1:N matching against every enrolled template.
============================================= */

"use strict";

/* ─────────────────────────────────────────
   WebAuthn — real fingerprint / platform biometric
───────────────────────────────────────── */
function webAuthnSupported() {
  return !!(window.PublicKeyCredential && navigator.credentials);
}

/* WebAuthn needs a hostname the platform authenticator accepts (an HTTPS
   origin or a localhost origin). Raw LAN IPs (e.g. 192.168.x.x) are
   unreliable, so steer the user to localhost. */
function isWebAuthnFriendlyHost() {
  const h = window.location.hostname;
  return (
    h === "localhost" ||
    h.endsWith(".localhost") ||
    h.endsWith(".localhost.localdomain") ||
    h === "127.0.0.1" ||
    h === "::1"
  );
}

function _randomChallenge() {
  const arr = new Uint8Array(32);
  crypto.getRandomValues(arr);
  return arr;
}
function _strToBuf(str) {
  return Uint8Array.from(str, (c) => c.charCodeAt(0));
}
function _bufToB64url(buf) {
  const bytes = new Uint8Array(buf);
  let str = "";
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function _b64urlToBuf(b64url) {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 ? "=".repeat(4 - (b64.length % 4)) : "";
  const bin = atob(b64 + pad);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr.buffer;
}

/* Enroll a platform fingerprint credential for this matric number.
   Returns the credential id (base64url) to store in the student record,
   or throws if the user cancels / device has no sensor. */
async function enrollFingerprint(matric, displayName) {
  if (!webAuthnSupported()) {
    throw new Error(
      "This browser/device does not support WebAuthn platform authentication (no fingerprint/Face ID sensor available, or the page is not served over HTTPS)."
    );
  }

  const publicKey = {
    challenge: _randomChallenge(),
    rp: { name: "EIPS — Exam Impersonation Prevention System" },
    user: {
      id: _strToBuf(matric),
      name: matric,
      displayName: displayName || matric,
    },
    pubKeyCredParams: [
      { type: "public-key", alg: -7 }, // ES256
      { type: "public-key", alg: -257 }, // RS256
    ],
    authenticatorSelection: {
      authenticatorAttachment: "platform",
      userVerification: "required",
    },
    timeout: 60000,
    attestation: "none",
  };

  const credential = await navigator.credentials.create({ publicKey });
  const credentialId = _bufToB64url(credential.rawId);
  return credentialId;
}

/* Ask the CURRENT device to prove it holds the previously-enrolled
   fingerprint credential. Must run on the same device/browser that
   enrolled it. Returns true/false. */
async function verifyFingerprint(credentialId) {
  if (!webAuthnSupported()) {
    throw new Error("WebAuthn is not supported on this device/browser.");
  }
  const publicKey = {
    challenge: _randomChallenge(),
    allowCredentials: [
      {
        id: _b64urlToBuf(credentialId),
        type: "public-key",
        transports: ["internal"],
      },
    ],
    userVerification: "required",
    timeout: 60000,
  };
  const assertion = await navigator.credentials.get({ publicKey });
  return !!assertion;
}

/* ─────────────────────────────────────────
   2. Exam-scanner bridge (ZK9500 + ZKFinger SDK)

   On exam PCs a tiny local service (bridge\zkbridge.py) owns the USB
   fingerprint scanner. The page talks to it over http://127.0.0.1 —
   this works from the hosted (HTTPS) site too, because browsers treat
   loopback addresses as trustworthy; the bridge answers CORS and
   private-network preflights for the hosted origin.

   Scanner-enrolled fingerprints are stored as "zk:<base64 template>"
   (the ZK template is portable across PCs, unlike a WebAuthn
   credential which is welded to the device that created it).

   Fallback order used by callers:
     exam PC with bridge      -> scanner (zk: template)
     any HTTPS device         -> WebAuthn platform sensor
     neither                  -> clear error
────────────────────────────────────────── */
const SCANNER_BRIDGE_URL = String(
  window.EIPS_BRIDGE_URL || "http://127.0.0.1:8765"
).replace(/\/+$/, "");
const SCANNER_BRIDGE_PROBE_MS = 900;
const SCANNER_BRIDGE_CALL_MS = 65000; // bridge may wait up to 45s for a finger
const SCANNER_BRIDGE_DOWN_MSG =
  "Exam fingerprint scanner bridge not reachable. On this exam PC start it " +
  "with: python bridge\\zkbridge.py (scanner must be plugged in).";

function isScannerTemplate(value) {
  return typeof value === "string" && value.indexOf("zk:") === 0;
}

/* Quick probe: returns bridge info {ok:true,...} or null if absent. */
async function bridgeHealth() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SCANNER_BRIDGE_PROBE_MS);
  try {
    const r = await fetch(SCANNER_BRIDGE_URL + "/health", {
      signal: ctrl.signal,
      headers: { Accept: "application/json" },
    });
    if (!r.ok) return null;
    const d = await r.json();
    return d && d.ok ? d : null;
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function _bridgeCall(path, payload) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SCANNER_BRIDGE_CALL_MS);
  let r;
  try {
    r = await fetch(SCANNER_BRIDGE_URL + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(payload || {}),
      signal: ctrl.signal,
    });
  } catch (e) {
    throw new Error(SCANNER_BRIDGE_DOWN_MSG);
  } finally {
    clearTimeout(timer);
  }
  let d = null;
  try {
    d = await r.json();
  } catch (e) {
    d = null;
  }
  if (!r.ok || !d || !d.ok) {
    throw new Error(
      (d && d.error) || "Scanner bridge error (HTTP " + r.status + ")."
    );
  }
  return d;
}

/* Capture one fingerprint on the exam scanner -> "zk:<template>". */
async function enrollFingerprintScanner() {
  const health = await bridgeHealth();
  if (!health) throw new Error(SCANNER_BRIDGE_DOWN_MSG);
  const cap = await _bridgeCall("/capture", {});
  if (!cap.template) throw new Error("Scanner returned no template.");
  return "zk:" + cap.template;
}

/* Match a live finger against a stored "zk:<template>".
   Throws if the bridge is down or the finger doesn't match;
   resolves { score, matched } on success. */
async function verifyFingerprintScanner(storedTemplate) {
  const health = await bridgeHealth();
  if (!health) throw new Error(SCANNER_BRIDGE_DOWN_MSG);
  const res = await _bridgeCall("/match", {
    template: String(storedTemplate),
  });
  if (!res.matched) {
    throw new Error(
      "Fingerprint did not match the enrolled record (score " + res.score + ")."
    );
  }
  return res;
}

/* Exam-day 1:N identification: match ONE live finger against MANY stored
   "zk:<template>" strings (index order preserved by the bridge).
   Resolves { bestIndex, score, matched, compared }.
   Throws with err.noMatch = true when no candidate reaches the threshold. */
async function matchFingerprintsOnScanner(templates) {
  const health = await bridgeHealth();
  if (!health) throw new Error(SCANNER_BRIDGE_DOWN_MSG);
  if (!Array.isArray(templates) || !templates.length) {
    throw new Error(
      "No scanner-enrolled fingerprints are available to match against."
    );
  }
  const res = await _bridgeCall("/match-many", { templates });
  if (!res.matched) {
    const err = new Error(
      "No enrolled student matches this fingerprint (best score " + res.score + ")."
    );
    err.noMatch = true;
    err.score = res.score;
    throw err;
  }
  return res;
}
