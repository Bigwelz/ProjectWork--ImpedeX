r"""
EIPS local fingerprint bridge — ZK9500 / ZKFinger Standard SDK 5.3
=====================================================================
Runs ONLY on the exam PC (Windows) with the scanner plugged in.
The hosted website talks to this over http://127.0.0.1 — the host never
needs Windows or the SDK.

Usage (on the exam PC):
    python bridge\zkbridge.py

Environment variables (all optional):
    ZKBRIDGE_PORT             port to listen on            (default 8765)
    ZKBRIDGE_ORIGINS          comma-separated browser origins allowed to call
                              this bridge. Default = local dev sites.
                              ADD your hosted site, e.g.:
                              set ZKBRIDGE_ORIGINS=https://yourapp.onrender.com
    ZKBRIDGE_CAPTURE_TIMEOUT  seconds to wait for a finger  (default 45)
    ZKBRIDGE_MATCH_THRESHOLD  min match score to accept     (default 1)
    ZKBRIDGE_DLL              path to libzkfp.dll
                              (default C:\\Windows\\System32\\libzkfp.dll)

Endpoints:
    GET  /health   -> { ok, devices, error? }
    POST /capture  -> { ok, template, image, width, height }   (waits for finger)
    POST /match    <- { template }  -> { ok, score, matched }  (waits for finger)
"""

import base64
import ctypes
import json
import os
import struct
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("ZKBRIDGE_PORT", "8765"))
DLL_PATH = os.environ.get(
    "ZKBRIDGE_DLL", r"C:\Windows\System32\libzkfp.dll")
DEFAULT_ORIGINS = ",".join(
    [
        "http://localhost:4000",
        "http://localhost:4001",
        "http://127.0.0.1:4000",
        "http://127.0.0.1:4001",
        "http://localhost",
        "http://127.0.0.1",
    ]
)
ALLOWED_ORIGINS = {
    o.strip().rstrip("/")
    for o in os.environ.get("ZKBRIDGE_ORIGINS", DEFAULT_ORIGINS).split(",")
    if o.strip()
}
CAPTURE_TIMEOUT = float(os.environ.get("ZKBRIDGE_CAPTURE_TIMEOUT", "45"))
MATCH_THRESHOLD = int(os.environ.get("ZKBRIDGE_MATCH_THRESHOLD", "1"))
MAX_BODY = 16 * 1024 * 1024  # allows a full 1:N template index

zk = None
sdk_lock = threading.Lock()
state = {"init": False, "dev": None, "db": None, "w": 0, "h": 0, "error": ""}


def load_sdk():
    global zk
    try:
        zk = ctypes.CDLL(DLL_PATH)
    except OSError as e:
        state["error"] = "cannot load %s: %s" % (DLL_PATH, e)
        return False

    zk.ZKFPM_Init.restype = ctypes.c_int
    zk.ZKFPM_Terminate.restype = ctypes.c_int
    zk.ZKFPM_GetDeviceCount.restype = ctypes.c_int
    zk.ZKFPM_OpenDevice.argtypes = [ctypes.c_int]
    zk.ZKFPM_OpenDevice.restype = ctypes.c_void_p
    zk.ZKFPM_CloseDevice.argtypes = [ctypes.c_void_p]
    zk.ZKFPM_CloseDevice.restype = ctypes.c_int
    zk.ZKFPM_DBInit.restype = ctypes.c_void_p
    zk.ZKFPM_DBFree.argtypes = [ctypes.c_void_p]
    zk.ZKFPM_DBFree.restype = ctypes.c_int
    zk.ZKFPM_GetParameters.argtypes = [
        ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p,
        ctypes.POINTER(ctypes.c_uint),
    ]
    zk.ZKFPM_GetParameters.restype = ctypes.c_int
    zk.ZKFPM_AcquireFingerprint.argtypes = [
        ctypes.c_void_p, ctypes.c_void_p, ctypes.c_uint, ctypes.c_void_p,
        ctypes.POINTER(ctypes.c_uint),
    ]
    zk.ZKFPM_AcquireFingerprint.restype = ctypes.c_int
    zk.ZKFPM_DBMatch.argtypes = [
        ctypes.c_void_p, ctypes.c_void_p, ctypes.c_uint,
        ctypes.c_void_p, ctypes.c_uint,
    ]
    zk.ZKFPM_DBMatch.restype = ctypes.c_int
    return True


def open_device_locked():
    """(Re)open the scanner. Caller holds sdk_lock."""
    if not state["init"] or zk is None:
        return False
    if state["dev"] is not None:
        return True
    if zk.ZKFPM_GetDeviceCount() < 1:
        state["error"] = "no fingerprint scanner connected"
        return False
    dev = zk.ZKFPM_OpenDevice(0)
    if not dev:
        state["error"] = "could not open scanner (is another app using it?)"
        return False
    state["dev"] = dev
    state["error"] = ""
    return True


def read_params_locked():
    if state["w"] > 0:
        return
    buf4 = ctypes.create_string_buffer(4)
    sz = ctypes.c_uint(4)
    zk.ZKFPM_GetParameters(state["dev"], 1, buf4, ctypes.byref(sz))
    w = struct.unpack("<i", buf4.raw[:4])[0]
    sz.value = 4
    zk.ZKFPM_GetParameters(state["dev"], 2, buf4, ctypes.byref(sz))
    h = struct.unpack("<i", buf4.raw[:4])[0]
    if 0 < w <= 2000 and 0 < h <= 2000:
        state["w"], state["h"] = w, h
    else:
        state["w"], state["h"] = 300, 400


def bmp_bytes(raw, width, height):
    stride = (width + 3) // 4 * 4
    pixels = bytearray(stride * height)
    for y in range(height):
        off = (height - 1 - y) * stride
        pixels[off:off + width] = raw[y * width:(y + 1) * width]
    palette = bytearray()
    for i in range(256):
        palette += bytes((i, i, i, 0))
    off_bits = 14 + 40 + 1024
    hdr = struct.pack("<2sIHHI", b"BM", off_bits + len(pixels), 0, 0, off_bits)
    info = struct.pack("<IiiHHIIiiII", 40, width, height, 1, 8, 0,
                       len(pixels), 0, 0, 256, 256)
    return bytes(hdr + info + palette + pixels)


def capture_locked(timeout):
    """Poll the sensor until a finger is captured. Caller holds sdk_lock.
    Returns (image_bytes, template_bytes) or raises RuntimeError."""
    read_params_locked()
    w, h = state["w"], state["h"]
    img = ctypes.create_string_buffer(w * h)
    tmpl = ctypes.create_string_buffer(2048)
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        cb = ctypes.c_uint(2048)
        ret = zk.ZKFPM_AcquireFingerprint(state["dev"], img, w * h, tmpl,
                                          ctypes.byref(cb))
        if ret == 0:
            return img.raw, bytes(tmpl.raw[:cb.value])
        last = ret
        time.sleep(0.2)
    raise RuntimeError(
        "No finger detected within %d seconds (last error code %s). "
        "Place and hold your finger on the scanner." % (int(timeout), last))


def b64(data):
    return base64.b64encode(data).decode("ascii")


def unb64(text):
    text = str(text)
    if text.startswith("zk:"):
        text = text[3:]
    return base64.b64decode(text)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "EIPSBridge/1.0"

    def log_message(self, fmt, *args):
        print("[bridge] %s" % (fmt % args), flush=True)

    def _origin(self):
        return (self.headers.get("Origin") or "").rstrip("/")

    def _origin_allowed(self):
        origin = self._origin()
        if not origin:
            return True  # non-browser client (curl, tests)
        return origin in ALLOWED_ORIGINS

    def _send(self, code, obj):
        body = json.dumps(obj).encode("utf-8")
        origin = self._origin()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        if origin and origin in ALLOWED_ORIGINS:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Methods",
                         "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        # 200 (not 204) so the response can carry a small JSON body safely.
        if self._origin_allowed():
            self._send(200, {})
        else:
            self._send(403, {"ok": False,
                             "error": "origin %s not allowed" % self._origin()})

    def do_GET(self):
        if not self._origin_allowed():
            return self._send(403, {"ok": False, "error": "origin not allowed"})
        if self.path.split("?")[0] != "/health":
            return self._send(404, {"ok": False, "error": "not found"})
        with sdk_lock:
            ready = bool(state["init"]) and open_device_locked()
            devices = zk.ZKFPM_GetDeviceCount() if zk and state["init"] else 0
            if state["init"] and devices < 1:
                state["error"] = "no fingerprint scanner connected"
                ready = False
        self._send(200, {
            "ok": ready,
            "devices": devices,
            "sdk": "ZKFinger Standard SDK 5.3",
            "error": state["error"] or None,
        })

    def _body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return {}
        if length > MAX_BODY:
            raise ValueError("body too large")
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8"))
        except ValueError:
            raise ValueError("invalid JSON body")

    def do_POST(self):
        if not self._origin_allowed():
            return self._send(403, {"ok": False, "error": "origin not allowed"})
        path = self.path.split("?")[0]
        try:
            body = self._body()
        except ValueError as e:
            return self._send(400, {"ok": False, "error": str(e)})

        if path == "/capture":
            with sdk_lock:
                if not open_device_locked():
                    return self._send(503, {"ok": False,
                                            "error": state["error"]})
                try:
                    img, tmpl = capture_locked(CAPTURE_TIMEOUT)
                except RuntimeError as e:
                    return self._send(408, {"ok": False, "error": str(e)})
            return self._send(200, {
                "ok": True,
                "template": b64(tmpl),
                "image": b64(bmp_bytes(img, state["w"], state["h"])),
                "width": state["w"],
                "height": state["h"],
            })

        if path == "/match-many":
            # Exam-day 1:N identification: one live capture matched against
            # every enrolled scanner template. Order of `templates` is kept;
            # bestIndex refers back into the caller's list.
            templates = body.get("templates")
            if not isinstance(templates, list) or not templates:
                return self._send(400, {"ok": False,
                                        "error": "templates array required"})
            # Skip corrupt/undecodable records instead of failing the whole
            # scan — one bad row in the DB must not break exam day.
            decoded = []
            orig_index = []
            for i, t in enumerate(templates):
                try:
                    decoded.append(unb64(t))
                    orig_index.append(i)
                except Exception:
                    continue
            if not decoded:
                return self._send(400, {"ok": False,
                                        "error": "no valid fingerprint templates to match against"})
            with sdk_lock:
                if not open_device_locked():
                    return self._send(503, {"ok": False,
                                            "error": state["error"]})
                try:
                    _img, live = capture_locked(CAPTURE_TIMEOUT)
                except RuntimeError as e:
                    return self._send(408, {"ok": False, "error": str(e)})
                db = state["db"]
                if not db:
                    return self._send(503, {"ok": False,
                                            "error": "match engine not ready"})
                live_buf = ctypes.create_string_buffer(live)
                best_score = -1000000
                best_pos = -1
                for pos, tpl in enumerate(decoded):
                    s = ctypes.create_string_buffer(tpl)
                    score = int(zk.ZKFPM_DBMatch(db, s, len(tpl),
                                                 live_buf, len(live)))
                    if score > best_score:
                        best_score, best_pos = score, pos
            return self._send(200, {
                "ok": True,
                # Index into the caller's ORIGINAL templates list.
                "bestIndex": orig_index[best_pos] if best_pos >= 0 else -1,
                "score": best_score,
                "matched": best_score >= MATCH_THRESHOLD,
                "compared": len(decoded),
            })

        if path == "/match":
            stored = body.get("template")
            if not stored:
                return self._send(400, {"ok": False,
                                        "error": "template required"})
            try:
                stored_bytes = unb64(stored)
            except Exception:
                return self._send(400, {"ok": False,
                                        "error": "template is not valid base64"})
            with sdk_lock:
                if not open_device_locked():
                    return self._send(503, {"ok": False,
                                            "error": state["error"]})
                try:
                    _img, live = capture_locked(CAPTURE_TIMEOUT)
                except RuntimeError as e:
                    return self._send(408, {"ok": False, "error": str(e)})
                db = state["db"]
                if not db:
                    return self._send(503, {"ok": False,
                                            "error": "match engine not ready"})
                s1 = ctypes.create_string_buffer(stored_bytes)
                s2 = ctypes.create_string_buffer(live)
                score = int(zk.ZKFPM_DBMatch(db, s1, len(stored_bytes),
                                             s2, len(live)))
            return self._send(200, {
                "ok": True,
                "score": score,
                "matched": score >= MATCH_THRESHOLD,
            })

        self._send(404, {"ok": False, "error": "not found"})


def main():
    print("EIPS fingerprint bridge starting ...", flush=True)
    if load_sdk():
        with sdk_lock:
            ret = zk.ZKFPM_Init()
            if ret != 0:
                state["error"] = "ZKFPM_Init failed (code %d)" % ret
            else:
                state["init"] = True
                state["db"] = zk.ZKFPM_DBInit()
                if not state["db"]:
                    state["error"] = "match engine (DBInit) failed"
                open_device_locked()
                if state["dev"]:
                    read_params_locked()
    else:
        print("WARNING: %s" % state["error"], flush=True)

    print("  listening  : http://127.0.0.1:%d" % PORT, flush=True)
    print("  scanner    : %s" % ("READY (%dx%d)"
          % (state["w"], state["h"]) if state["dev"] else state["error"]),
          flush=True)
    print("  origins    : %s" % ", ".join(sorted(ALLOWED_ORIGINS)), flush=True)
    print("  hosted site? set ZKBRIDGE_ORIGINS=https://your-domain "
          "before starting", flush=True)

    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    server.daemon_threads = True
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nbridge stopping ...", flush=True)
    finally:
        with sdk_lock:
            if state["dev"] and zk:
                zk.ZKFPM_CloseDevice(state["dev"])
            if state["db"] and zk:
                zk.ZKFPM_DBFree(state["db"])
            if state["init"] and zk:
                zk.ZKFPM_Terminate()


if __name__ == "__main__":
    main()
