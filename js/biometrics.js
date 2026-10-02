/* =============================================
   EIPS — Biometrics Layer (js/biometrics.js)

   Two REAL browser capabilities are used here, not simulated:

   1. WebAuthn (navigator.credentials) — this is what actually talks to
      a laptop's Windows Hello / Mac Touch ID sensor, or a phone's
      fingerprint/Face unlock, from inside the browser. Requires a
      secure context (HTTPS, or http://localhost while testing).
      IMPORTANT LIMITATION (real, not a bug): a WebAuthn credential is
      bound to the device/authenticator that created it. There is no
      browser API that lets an admin's computer "pull" or compare a
      fingerprint that was enrolled on a student's own laptop/phone.
      So fingerprint re-verification on exam day must happen on the
      SAME device the student enrolled with.

   2. face-api.js (loaded from CDN in the HTML) — a real, open-source,
      in-browser face-recognition library (runs on TensorFlow.js). It
      produces a 128-number face descriptor from a photo; comparing two
      descriptors' Euclidean distance is the standard way face
      recognition systems decide "same person" (distance < ~0.55 is a
      strong match). This is genuine automated face matching, not a
      fake timer.
============================================= */

"use strict";

const FACE_MODELS_URL =
  "https://cdn.jsdelivr.net/gh/justadudewhohacks/face-api.js@master/weights";
const FACE_MATCH_THRESHOLD = 0.55;

let _faceModelsLoaded = false;

async function loadFaceModels() {
  if (_faceModelsLoaded) return true;
  if (typeof faceapi === "undefined") {
    console.warn("face-api.js did not load (no internet, or CDN blocked).");
    return false;
  }
  try {
    await faceapi.nets.tinyFaceDetector.loadFromUri(FACE_MODELS_URL);
    await faceapi.nets.faceLandmark68Net.loadFromUri(FACE_MODELS_URL);
    await faceapi.nets.faceRecognitionNet.loadFromUri(FACE_MODELS_URL);
    _faceModelsLoaded = true;
    return true;
  } catch (e) {
    console.warn("Failed to load face-api.js models:", e);
    return false;
  }
}

/* Given an <img> or <video> or <canvas> element, returns a 128-length
   face descriptor array, or null if no face / models unavailable. */
async function getFaceDescriptor(mediaEl) {
  const ready = await loadFaceModels();
  if (!ready) return null;
  const detection = await faceapi
    .detectSingleFace(mediaEl, new faceapi.TinyFaceDetectorOptions())
    .withFaceLandmarks()
    .withFaceDescriptor();
  if (!detection) return null;
  return Array.from(detection.descriptor);
}

/* Euclidean distance between two descriptors -> lower = more similar */
function faceDistance(descA, descB) {
  if (!descA || !descB || descA.length !== descB.length) return Infinity;
  let sum = 0;
  for (let i = 0; i < descA.length; i++) {
    sum += (descA[i] - descB[i]) ** 2;
  }
  return Math.sqrt(sum);
}

function faceMatches(descA, descB) {
  const d = faceDistance(descA, descB);
  return { isMatch: d < FACE_MATCH_THRESHOLD, distance: d };
}

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
