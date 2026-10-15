/* =============================================
   EIPS — Shared REST API (server/api.js)
   Mounted by BOTH servers so each one exposes
   only the endpoints its audience needs:
     server/index.js         → :4000 students (student:true)
     server/admin-server.js  → :4001 admins   (admin:true)
   Admin endpoints are therefore unreachable
   from the student port, and vice versa.
============================================= */

"use strict";

const express = require("express");
const jwt = require("jsonwebtoken");
const crypto = require("node:crypto");

const db = require("./db");

const APP = {
  name: "ImpedeX — Exam Impersonation Prevention System",
};

const JWT_SECRET = process.env.EIPS_JWT_SECRET || crypto.randomBytes(32).toString("hex");
const STUDENT_TOKEN_TTL = "12h";
const ADMIN_TOKEN_TTL = "4h";

/* ─────────────────────────────────────────
   HELPERS
───────────────────────────────────────── */
function studentToken(matric) {
  return jwt.sign({ role: "student", matric }, JWT_SECRET, { expiresIn: STUDENT_TOKEN_TTL });
}
function adminToken(email) {
  return jwt.sign({ role: "admin", email }, JWT_SECRET, { expiresIn: ADMIN_TOKEN_TTL });
}

async function authStudent(req, res, next) {
  const tok = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!tok) return res.status(401).json({ error: "Not authenticated." });
  try {
    const payload = jwt.verify(tok, JWT_SECRET);
    if (payload.role !== "student") throw new Error("wrong role");
    req.matric = payload.matric;
    if (!await db.studentExists(payload.matric)) return res.status(401).json({ error: "Account no longer exists." });
    next();
  } catch {
    return res.status(401).json({ error: "Session expired. Please log in again." });
  }
}

async function authAdmin(req, res, next) {
  const tok = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!tok) return res.status(401).json({ error: "Not authenticated." });
  try {
    const payload = jwt.verify(tok, JWT_SECRET);
    if (payload.role !== "admin") throw new Error("wrong role");
    req.email = payload.email;
    if (!await db.getAdmin(payload.email)) return res.status(401).json({ error: "Admin account no longer exists." });
    next();
  } catch {
    return res.status(401).json({ error: "Session expired. Please log in again." });
  }
}

function wrap(fn) {
  return (req, res) => {
    Promise.resolve(fn(req, res)).catch((err) => {
      console.error(err);
      res.status(500).json({ error: err.message || "Server error." });
    });
  };
}

function securityHeaders(req, res, next) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-XSS-Protection", "1; mode=block");
  res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    /* connect-src must allow only the local scanner bridge
       (bridge\zkbridge.py, default port 8765) besides same-origin.
       Everything else stays same-origin — no face/CDN scripts remain. */
    res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; img-src 'self' data:; font-src 'self' https://cdnjs.cloudflare.com; connect-src 'self' http://127.0.0.1:8765 http://localhost:8765;");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=()");
  next();
}

/* ─────────────────────────────────────────
   RATE LIMITING (in-memory, admin login)
───────────────────────────────────────── */
const ipLoginAttempts = new Map();
const emailConsecutiveFailures = new Map();

function getIpAttempts(ip) {
  const entry = ipLoginAttempts.get(ip);
  if (!entry || Date.now() - entry.windowStart > 15 * 60 * 1000) {
    ipLoginAttempts.delete(ip);
    return null;
  }
  return entry;
}

function recordIpFailure(ip) {
  const now = Date.now();
  const entry = ipLoginAttempts.get(ip);
  if (!entry || now - entry.windowStart > 15 * 60 * 1000) {
    ipLoginAttempts.set(ip, { count: 1, windowStart: now });
    return 1;
  }
  entry.count++;
  return entry.count;
}

function getConsecutiveWaitMs(ip, email) {
  const key = `${ip}:${email}`;
  const entry = emailConsecutiveFailures.get(key);
  if (!entry || entry.count < 3) return 0;
  if (Date.now() - entry.lastFailureAt >= 30 * 1000) {
    emailConsecutiveFailures.delete(key);
    return 0;
  }
  return 30 * 1000 - (Date.now() - entry.lastFailureAt);
}

function recordEmailConsecutiveFailure(ip, email) {
  const key = `${ip}:${email}`;
  const now = Date.now();
  const entry = emailConsecutiveFailures.get(key);
  if (!entry || now - entry.lastFailureAt > 30 * 1000) {
    emailConsecutiveFailures.set(key, { count: 1, lastFailureAt: now });
    return 1;
  }
  entry.count++;
  entry.lastFailureAt = now;
  return entry.count;
}

function clearLoginTracking(ip, email) {
  ipLoginAttempts.delete(ip);
  if (email) emailConsecutiveFailures.delete(`${ip}:${email}`);
}

/* Decode + normalise a request path (removes ./, .., duplicate slashes) so
   page-blocking rules cannot be bypassed with %2e or ../ tricks. */
function normalizePath(req) {
  let raw;
  try {
    raw = decodeURIComponent(req.path || "/");
  } catch {
    raw = req.path || "/";
  }
  const parts = [];
  for (const seg of String(raw).split(/[\\/]+/)) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      parts.pop();
      continue;
    }
    parts.push(seg);
  }
  return "/" + parts.join("/");
}

/* Helper: extract level from course code (e.g. IFT502 → 500) */
function courseLevel(code) {
  const m = String(code).match(/\d/);
  return m ? parseInt(m[0], 10) * 100 : 0;
}

/* ─────────────────────────────────────────
   ADMIN PORTAL COOKIE
   Cookies are scoped to the HOST, not the port, so a cookie set by the
   admin server (:4001) is also sent to the student server (:4000). That is
   how the landing page can tell "this browser just used the admin portal"
   without ever exposing admin data. It can only be issued by a successful
   admin login and is HttpOnly, so student page scripts can't read it.
───────────────────────────────────────── */
const PORTAL_COOKIE = "eips_admin_portal";
const PORTAL_COOKIE_TTL = 4 * 60 * 60; // matches ADMIN_TOKEN_TTL (4h)

function portalCookieHeader(req, value, maxAge) {
  const parts = [`${PORTAL_COOKIE}=${value}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${maxAge}`];
  if (process.env.COOKIE_DOMAIN) parts.push(`Domain=${process.env.COOKIE_DOMAIN}`); // e.g. .example.com in production
  if (req.secure) parts.push("Secure");
  return parts.join("; ");
}

function hasPortalCookie(req) {
  const cookies = String(req.headers.cookie || "");
  return new RegExp(`(?:^|;\\s*)${PORTAL_COOKIE}=1(?:;|$)`).test(cookies);
}

/* ─────────────────────────────────────────
   MOUNT
───────────────────────────────────────── */
function mountApi(app, { student = false, admin = false } = {}) {
  app.set("trust proxy", 1); // correct client IP / https detection behind Render, nginx, etc.
  app.use(express.json({ limit: "25mb" })); // registration photos (data URLs) can be large
  app.use(express.urlencoded({ extended: true }));
  app.use(securityHeaders);

  /* Optional CORS — only active when CORS_ALLOWED_ORIGIN is set. Use this
     if a frontend calls the API directly from its own origin instead of
     going through the Vercel /api proxy (e.g. set it to the Vercel URL).
     With the proxy approach below, no CORS headers are needed. */
  const CORS_ALLOWED_ORIGIN = process.env.CORS_ALLOWED_ORIGIN || "";
  if (CORS_ALLOWED_ORIGIN) {
    app.use((req, res, next) => {
      res.setHeader("Access-Control-Allow-Origin", CORS_ALLOWED_ORIGIN);
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
      if (req.method === "OPTIONS") return res.sendStatus(204);
      next();
    });
  }

  /* ── PUBLIC (both servers) ── */
  app.get("/api/health", (req, res) => res.json({ ok: true, app: APP.name, db: true }));

  /* Tells the calling page whether THIS browser holds a valid admin-portal
     cookie. Used by the landing page to reveal the Admin Portal button —
     it exposes no admin data, only "portal used here recently". */
  app.get("/api/session/portal", (req, res) => {
    res.json({ adminPortal: hasPortalCookie(req) });
  });

  app.get("/api/courses", wrap(async (req, res) => {
    const rows = await db.allCourses();
    res.json(rows.map((c) => ({
      code: c.code,
      title: c.title,
      unit: c.unit,
      type: c.type.charAt(0).toUpperCase() + c.type.slice(1),
    })));
  }));

  /* ───────────────────────────────────────
     STUDENT SERVER ONLY
  ─────────────────────────────────────── */
  if (student) {
    /* STUDENT AUTH */
    app.post(
      "/api/auth/register",
      wrap(async (req, res) => {
        const b = req.body || {};
        const matric = String(b.matric || "").trim();
        const password = String(b.password || "");

        if (!/^\d{11}$/.test(matric)) {
          return res.status(400).json({ error: "Matric number must be exactly 11 digits." });
        }
        if (await db.studentExists(matric)) {
          return res.status(409).json({ error: "An account already exists for this matric number." });
        }
        if (!b.firstName || !b.lastName || !b.email) {
          return res.status(400).json({ error: "First name, last name and email are required." });
        }
        if (password.length < 8) {
          return res.status(400).json({ error: "Password must be at least 8 characters long." });
        }
        const photo = typeof b.photo === "string" && b.photo.startsWith("data:image/") ? b.photo : null;
        if (!photo) {
          return res.status(400).json({
            error: "A clear photo is required — it is shown at the exam-day checkpoint.",
          });
        }

        const salt = db.randomSaltB64();
        const hash = db.hashPasswordSync(password, salt);

        await db.createStudent({
          matric,
          firstName: String(b.firstName).trim(),
          lastName: String(b.lastName).trim(),
          email: String(b.email).trim().toLowerCase(),
          phone: String(b.phone || "").trim(),
          department: String(b.department || "").trim(),
          faculty: String(b.faculty || "").trim(),
          level: String(b.level || "").trim(),
          session: String(b.session || "").trim(),
          passwordSalt: salt,
          passwordHash: hash,
          photo,
          createdAt: Date.now(),
        });

        const stu = await db.publicStudent(await db.getStudent(matric));
        res.status(201).json({ token: studentToken(matric), student: stu });
      })
    );

    app.post(
      "/api/auth/login",
      wrap(async (req, res) => {
        const matric = String(req.body.matric || "").trim();
        const password = String(req.body.password || "");
        if (!/^\d{11}$/.test(matric)) {
          return res.status(400).json({ error: "Matric number must be exactly 11 digits." });
        }
        const rec = await db.getStudentRaw(matric);
        if (!rec) return res.status(404).json({ error: "No account found for that matric number. Please register." });
        if (!db.verifyPasswordSync(password, rec.password_salt, rec.password_hash)) {
          return res.status(401).json({ error: "Incorrect password." });
        }
        res.json({ token: studentToken(matric), student: await db.publicStudent(await db.getStudent(matric)) });
      })
    );

    /* FORGOT PASSWORD (server-issued OTP) */
    app.post(
      "/api/auth/forgot/request",
      wrap(async (req, res) => {
        const matric = String(req.body.matric || "").trim();
        const email = String(req.body.email || "").trim().toLowerCase();
        if (!/^\d{11}$/.test(matric)) return res.status(400).json({ error: "Matric number must be exactly 11 digits." });
        const rec = await db.getStudentRaw(matric);
        if (!rec) return res.status(404).json({ error: "No account found for that matric number." });
        if (!rec.email || rec.email.trim().toLowerCase() !== email) {
          return res.status(400).json({ error: "That email does not match the one on record for this matric number." });
        }
        const code = String(Math.floor(100000 + Math.random() * 900000));
        await db.createOtp(matric, code);
        // NOTE: no mail server configured; the code is returned so the demo UI can
        // show it. Swap this return for a real email (SendGrid/EmailJS/your SMTP).
        res.json({ ok: true, demoOtp: code });
      })
    );

    app.post(
      "/api/auth/forgot/verify",
      wrap(async (req, res) => {
        const matric = String(req.body.matric || "").trim();
        const code = String(req.body.code || "").trim();
        const result = await db.verifyOtp(matric, code);
        if (!result.ok) return res.status(400).json({ error: result.reason });
        res.json({ ok: true });
      })
    );

    app.post(
      "/api/auth/forgot/reset",
      wrap(async (req, res) => {
        const matric = String(req.body.matric || "").trim();
        const password = String(req.body.password || "");
        if (password.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters long." });
        if (!await db.studentExists(matric)) return res.status(404).json({ error: "No account found for that matric number." });
        const salt = db.randomSaltB64();
        const hash = db.hashPasswordSync(password, salt);
        await db.updateStudent(matric, { password_salt: salt, password_hash: hash });
        res.json({ ok: true });
      })
    );

    /* STUDENT DATA */
    app.get("/api/me", authStudent, wrap(async (req, res) => {
      const s = await db.getStudent(req.matric);
      const pub = await db.publicStudent(s);
      pub.registeredCourses = await db.getRegisteredCourses(s.matric);
      pub.examSelection = await db.getExamSelection(s.matric) || null;
      pub.seat = await db.getSeat(s.matric);
      res.json({ student: pub });
    }));

    app.post(
      "/api/courses/register",
      authStudent,
      wrap(async (req, res) => {
        const courses = Array.isArray(req.body.courses) ? req.body.courses : [];
        const carryOvers = Array.isArray(req.body.carryOvers) ? req.body.carryOvers : [];
        if (!courses.length && !carryOvers.length) {
          return res.status(400).json({ error: "Select at least one course to register." });
        }

        const normalized = courses.map(async (c) => {
          const row = await db.getCourse(c.code);
          if (!row) throw new Error(`Unknown course code ${c.code}`);
          return { code: row.code, title: row.title, unit: row.unit, type: c.type || row.type };
        });

        const carryOverEntries = carryOvers.map(async (code) => {
          const row = await db.getCourse(code);
          if (!row) throw new Error(`Unknown course code ${code}`);
          return { code: row.code, title: row.title, unit: row.unit, type: "carry_over" };
        });

        await db.replaceRegistrations(req.matric, [...normalized, ...carryOverEntries]);

        for (const code of carryOvers) {
          await db.addCarryOver(req.matric, code);
        }

        const stu = await db.publicStudent(await db.getStudent(req.matric));
        const registered = await db.getRegisteredCourses(req.matric);

        const totalUnits = registered.reduce((s, c) => s + (Number(c.unit) || 0), 0);
        await db.createNotification(
          req.matric,
          "course_registration",
          "Courses Registered",
          `You have successfully registered ${registered.length} course${registered.length === 1 ? "" : "s"} (${totalUnits} total units).`
        );

        res.json({ student: stu, registered });
      })
    );

    app.post(
      "/api/courses/select-exam",
      authStudent,
      wrap(async (req, res) => {
        const code = String(req.body.courseCode || "").trim();
        if (!await db.getCourse(code)) return res.status(400).json({ error: "Unknown course code." });
        const registered = (await db.getRegisteredCourses(req.matric)).map((c) => c.code);
        if (!registered.includes(code)) {
          return res.status(400).json({ error: "You have not registered for this course." });
        }
        await db.setExamSelection(req.matric, code);
        res.json({ ok: true });
      })
    );

    app.post(
      "/api/verify/fingerprint-enroll",
      authStudent,
      wrap(async (req, res) => {
        const credentialId = String(req.body.credentialId || "");
        if (!credentialId) return res.status(400).json({ error: "Credential id required." });
        await db.updateStudent(req.matric, { fingerprint_credential_id: credentialId });

        await db.createNotification(
          req.matric,
          "biometric_enrollment",
          "Fingerprint Enrolled",
          "Your fingerprint has been enrolled. On exam day, place your finger on the scanner — the system matches it and shows your record with your allocated seat."
        );

        res.json({ ok: true });
      })
    );

    app.get("/api/exams", authStudent, wrap(async (req, res) => {
      const registered = await db.getRegisteredCourses(req.matric);
      const schedules = await db.allExamSchedules();
      const exams = registered.map((c) => {
        const s = schedules[c.code] || {};
        return {
          code: c.code,
          title: c.title,
          unit: c.unit,
          type: c.type,
          date: s.date || null,
          time: s.time || null,
          hall: s.hall || null,
        };
      });
      res.json({ exams });
    }));

    app.get("/api/seat", authStudent, wrap(async (req, res) => {
      const seat = await db.getSeat(req.matric);
      const selection = await db.getExamSelection(req.matric);
      const schedule = selection ? await db.getExamSchedule(selection.course_code) : null;
      res.json({
        seat,
        examCourse: selection ? { code: selection.course_code } : null,
        schedule,
      });
    }));

    /* NOTIFICATIONS (student) */
    app.get("/api/notifications", authStudent, wrap(async (req, res) => {
      const notifications = await db.getNotifications(req.matric);
      const unread = await db.getUnreadCount(req.matric);
      res.json({ notifications, unread });
    }));

    app.post("/api/notifications/read/:id", authStudent, wrap(async (req, res) => {
      await db.markAsRead(req.matric, Number(req.params.id));
      res.json({ ok: true });
    }));

    app.post("/api/notifications/read-all", authStudent, wrap(async (req, res) => {
      await db.markAllAsRead(req.matric);
      res.json({ ok: true });
    }));

    app.delete("/api/notifications", authStudent, wrap(async (req, res) => {
      await db.clearNotifications(req.matric);
      res.json({ ok: true });
    }));

    /* Student-facing: courses for a given level (used during course registration) */
    app.get(
      "/api/courses/level/:level",
      authStudent,
      wrap(async (req, res) => {
        const level = parseInt(req.params.level, 10);
        if (![200, 300, 400, 500].includes(level)) {
          return res.status(400).json({ error: "Level must be 200, 300, 400, or 500." });
        }
        const courses = await db.allCourses();
        const schedules = await db.allExamSchedules();
        const filtered = courses
          .filter((c) => courseLevel(c.code) === level)
          .map((c) => ({
            ...c,
            level: courseLevel(c.code),
            schedule: schedules[c.code] || null,
          }));
        res.json(filtered);
      })
    );

    /* Student-facing: all courses for carry-over selection (levels below student's) */
    app.get(
      "/api/courses/carryover-options/:matric",
      authStudent,
      wrap(async (req, res) => {
        const stu = await db.getStudent(req.params.matric);
        if (!stu) return res.status(404).json({ error: "Student not found." });
        const studentLevel = courseLevel(stu.level || "");
        if (!studentLevel) {
          return res.status(400).json({ error: "Could not determine your level. Please update your profile." });
        }
        const courses = await db.allCourses();
        const options = courses
          .filter((c) => {
            const cl = courseLevel(c.code);
            return cl > 0 && cl < studentLevel;
          })
          .map((c) => ({ ...c, level: courseLevel(c.code) }));
        res.json(options);
      })
    );
  }

  /* ───────────────────────────────────────
     ADMIN SERVER ONLY
  ─────────────────────────────────────── */
  if (admin) {
    /* ADMIN AUTH */
    app.post(
      "/api/admin/login",
      wrap(async (req, res) => {
        const email = String(req.body.email || "").trim().toLowerCase();
        const password = String(req.body.password || "");
        const adminKey = String(req.body.adminKey || "").trim();
        const ip = req.ip || req.connection.remoteAddress || "unknown";

        const ipEntry = getIpAttempts(ip);
        if (ipEntry && ipEntry.count >= 5) {
          return res.status(429).json({ error: "Too many login attempts. Try again in 15 minutes." });
        }

        const consecutiveWait = getConsecutiveWaitMs(ip, email);
        if (consecutiveWait > 0) {
          return res.status(429).json({ error: `Too many failed attempts. Please wait ${Math.ceil(consecutiveWait / 1000)} seconds.` });
        }

        if (!await db.verifyAdminCredentials(email, password, adminKey)) {
          recordIpFailure(ip);
          recordEmailConsecutiveFailure(ip, email);
          return res.status(401).json({ error: "Invalid admin credentials." });
        }

        clearLoginTracking(ip, email);
        // Marks this browser as "has used the admin portal" for the landing page.
        res.setHeader("Set-Cookie", portalCookieHeader(req, "1", PORTAL_COOKIE_TTL));
        res.json({ token: adminToken(email), email });
      })
    );

    /* Clears the portal cookie (admin logged out → Admin Portal button hides). */
    app.post("/api/admin/logout", (req, res) => {
      res.setHeader("Set-Cookie", portalCookieHeader(req, "", 0));
      res.json({ ok: true });
    });

    app.post(
      "/api/admin/register",
      wrap(async (req, res) => {
        const b = req.body || {};
        const email = String(b.email || "").trim().toLowerCase();
        const firstName = String(b.firstName || "").trim();
        const lastName = String(b.lastName || "").trim();
        const phone = String(b.phone || "").trim();
        const department = String(b.department || "").trim();
        const password = String(b.password || "");
        const confirmPassword = String(b.confirmPassword || "");
        const adminKey = String(b.adminKey || "").trim();
        const confirmAdminKey = String(b.confirmAdminKey || "").trim();

        if (!email || !firstName || !lastName || !password || !adminKey) {
          return res.status(400).json({ error: "All required fields must be filled." });
        }
        if (!email.includes("@") || !email.includes(".")) {
          return res.status(400).json({ error: "Please enter a valid email address." });
        }
        if (password.length < 8) {
          return res.status(400).json({ error: "Password must be at least 8 characters." });
        }
        if (password !== confirmPassword) {
          return res.status(400).json({ error: "Passwords do not match." });
        }
        if (adminKey.length < 10) {
          return res.status(400).json({ error: "Admin secret key must be at least 10 characters." });
        }
        if (adminKey !== confirmAdminKey) {
          return res.status(400).json({ error: "Admin secret keys do not match." });
        }
        if (await db.getAdmin(email)) {
          return res.status(409).json({ error: "An admin account with this email already exists." });
        }

        await db.createAdmin({ email, firstName, lastName, phone, department, password, adminKey });
        res.json({ ok: true, message: "Admin account created successfully. You can now log in." });
      })
    );

    /* ADMIN DASHBOARD DATA */
    app.get(
      "/api/admin/stats",
      authAdmin,
      wrap(async (req, res) => {
        const stats = await db.verificationStats();
        const schedules = await db.allExamSchedules();
        res.json({
          totalStudents: (await db.allStudents()).length,
          passed: stats.pass,
          failed: stats.fail,
          attendance: stats.attendance,
          examsScheduled: Object.keys(schedules).length,
          seatsAllocated: (await db.allSeats()).length,
        });
      })
    );

    app.get("/api/admin/students", authAdmin, wrap(async (req, res) => {
      const students = (await db.allStudents()).map(async (s) => {
        const pub = await db.publicStudent(s);
        pub.registeredCourses = await db.getRegisteredCourses(s.matric);
        pub.examSelection = await db.getExamSelection(s.matric) || null;
        pub.seat = await db.getSeat(s.matric);
        return pub;
      });
      res.json(students);
    }));

    /* Exam-day 1:N index: every scanner-enrolled ("zk:") fingerprint
       template, decrypted, behind authAdmin only. The checkpoint page sends
       this list to the exam PC's local scanner bridge, which captures one
       live finger and matches it against all of them (the ZK SDK only runs
       on Windows, so matching cannot happen on this server). */
    app.get("/api/admin/fingerprints", authAdmin, wrap(async (req, res) => {
      const rows = (await db.allStudents())
        .map((s) => ({ matric: s.matric, template: s.fingerprintCredentialId }))
        .filter((r) => r.template && r.template.startsWith("zk:"));
      res.json(rows);
    }));

    app.get(
      "/api/admin/student/:matric",
      authAdmin,
      wrap(async (req, res) => {
        const s = await db.getStudent(req.params.matric);
        if (!s) return res.status(404).json({ error: "Student not found." });
        const pub = await db.publicStudent(s);
        pub.registeredCourses = await db.getRegisteredCourses(s.matric);
        pub.examSelection = await db.getExamSelection(s.matric) || null;
        pub.seat = await db.getSeat(s.matric);
        pub.schedule = pub.examSelection ? await db.getExamSchedule(pub.examSelection.course_code) : null;
        res.json(pub);
      })
    );

    app.post(
      "/api/admin/students",
      authAdmin,
      wrap(async (req, res) => {
        const b = req.body || {};
        const matric = String(b.matric || "").trim();
        if (!/^\d{11}$/.test(matric)) return res.status(400).json({ error: "Matric number must be exactly 11 digits." });
        if (await db.studentExists(matric)) return res.status(409).json({ error: "A student with this matric number already exists." });
        const tempPassword = Math.random().toString(36).slice(-8) + "A1!";
        const salt = db.randomSaltB64();
        const hash = db.hashPasswordSync(tempPassword, salt);
        await db.createStudent({
          matric,
          firstName: String(b.firstName || "").trim() || "(no name)",
          lastName: String(b.lastName || "").trim() || "(no name)",
          email: String(b.email || "").trim(),
          level: String(b.level || "").trim(),
          department: String(b.department || "").trim(),
          passwordSalt: salt,
          passwordHash: hash,
          createdAt: Date.now(),
        });
        res.status(201).json({ student: await db.publicStudent(await db.getStudent(matric)), tempPassword });
      })
    );

    app.delete(
      "/api/admin/students/:matric",
      authAdmin,
      wrap(async (req, res) => {
        if (!await db.studentExists(req.params.matric)) return res.status(404).json({ error: "Student not found." });
        await db.deleteStudent(req.params.matric);
        res.json({ ok: true });
      })
    );

    /* EXAM SCHEDULE */
    app.post(
      "/api/admin/schedule",
      authAdmin,
      wrap(async (req, res) => {
        const b = req.body || {};
        const code = String(b.courseCode || "").trim().toUpperCase();
        if (!await db.getCourse(code)) return res.status(400).json({ error: "Unknown course code." });
        if (!b.date || !b.time || !b.hall) return res.status(400).json({ error: "Date, time and hall are required." });
        await db.setExamSchedule(code, { date: String(b.date), time: String(b.time), hall: String(b.hall) });

        // Notify students registered for this course
        const course = await db.getCourse(code);
        const registrations = await db.getRegisteredStudents(code);
        for (const reg of registrations) {
          await db.createNotification(
            reg.matric,
            "exam_schedule",
            "Exam Date Published",
            `Exam for ${code} — ${course.title || ""} has been scheduled for ${b.date} at ${b.time} in ${b.hall}.`
          );
        }

        res.json({ ok: true, schedule: await db.getExamSchedule(code) });
      })
    );

    app.delete(
      "/api/admin/schedule/:courseCode",
      authAdmin,
      wrap(async (req, res) => {
        const code = String(req.params.courseCode).trim().toUpperCase();
        await db.deleteExamSchedule(code);
        res.json({ ok: true });
      })
    );

    /* ADMIN COURSE CATALOG (MUST be before :code routes) */
    app.get(
      "/api/admin/courses/level/:level",
      authAdmin,
      wrap(async (req, res) => {
        const level = parseInt(req.params.level, 10);
        if (![200, 300, 400, 500].includes(level)) {
          return res.status(400).json({ error: "Level must be 200, 300, 400, or 500." });
        }
        const courses = await db.allCourses();
        const schedules = await db.allExamSchedules();
        const filtered = courses
          .filter((c) => courseLevel(c.code) === level)
          .map((c) => ({
            ...c,
            level: courseLevel(c.code),
            schedule: schedules[c.code] || null,
          }));
        res.json(filtered);
      })
    );

    app.get(
      "/api/admin/courses",
      authAdmin,
      wrap(async (req, res) => {
        const courses = await db.allCourses();
        const schedules = await db.allExamSchedules();
        const enriched = courses.map((c) => ({
          ...c,
          level: courseLevel(c.code),
          schedule: schedules[c.code] || null,
        }));
        res.json(enriched);
      })
    );

    app.post(
      "/api/admin/courses",
      authAdmin,
      wrap(async (req, res) => {
        const b = req.body || {};
        const code = String(b.code || "").trim().toUpperCase();
        const title = String(b.title || "").trim();
        const unit = Number(b.unit);
        const type = String(b.type || "").trim();
        const level = b.level ? Number(b.level) : null;
        if (!code || !title || !unit || !type) {
          return res.status(400).json({ error: "Code, title, unit and type are required." });
        }
        if (!["compulsory", "elective"].includes(type)) {
          return res.status(400).json({ error: "Type must be 'compulsory' or 'elective'." });
        }
        if (await db.getCourse(code)) {
          return res.status(409).json({ error: `Course ${code} already exists.` });
        }
        const course = await db.insertCourse({ code, title, unit, type, level });

        const count = await db.notifyAllStudents(
          "course_upload",
          "New Course Available",
          `A new ${type} course ${code} — ${title} (${unit} unit${unit === 1 ? "" : "s"}) has been added to the course catalog.`
        );

        res.json({ ok: true, course, notifiedStudents: count });
      })
    );

    app.put(
      "/api/admin/courses/:code",
      authAdmin,
      wrap(async (req, res) => {
        const code = String(req.params.code).trim().toUpperCase();
        const existing = await db.getCourse(code);
        if (!existing) return res.status(404).json({ error: "Course not found." });
        const b = req.body || {};
        const patch = {};
        if (b.title !== undefined) patch.title = String(b.title).trim();
        if (b.unit !== undefined) patch.unit = Number(b.unit);
        if (b.type !== undefined) {
          patch.type = String(b.type).trim();
          if (!["compulsory", "elective"].includes(patch.type)) {
            return res.status(400).json({ error: "Type must be 'compulsory' or 'elective'." });
          }
        }
        const course = await db.updateCourse(code, patch);
        res.json({ ok: true, course });
      })
    );

    app.delete(
      "/api/admin/courses/:code",
      authAdmin,
      wrap(async (req, res) => {
        const code = String(req.params.code).trim().toUpperCase();
        if (!await db.getCourse(code)) return res.status(404).json({ error: "Course not found." });
        await db.deleteCourse(code);
        res.json({ ok: true });
      })
    );

    /* EXAM-DAY CHECKPOINT */
    /* Log a pass/fail fingerprint check made at the checkpoint. */
    app.post(
      "/api/admin/student/:matric/verify",
      authAdmin,
      wrap(async (req, res) => {
        const s = await db.getStudentRaw(req.params.matric);
        if (!s) return res.status(404).json({ error: "Student not found." });
        const b = req.body || {};
        const result = b.result === "fail" ? "fail" : "pass";
        await db.logVerification(req.params.matric, result, String(b.details || "Checkpoint verification"));
        res.json({ ok: true });
      })
    );

    /* KEY ANTI-CHEAT FLOW: the ONLY place a seat is created. Admin approves a
       verified student on exam day and the seat is allocated server-side and
       persisted — the student cannot know it beforehand and cannot forge it. */
    app.post(
      "/api/admin/student/:matric/approve",
      authAdmin,
      wrap(async (req, res) => {
        const s = await db.getStudentRaw(req.params.matric);
        if (!s) return res.status(404).json({ error: "Student not found." });
        let selection = await db.getExamSelection(req.params.matric);
        if (!selection && req.body.course_code) {
          await db.setExamSelection(req.params.matric, req.body.course_code);
          selection = await db.getExamSelection(req.params.matric);
        }
        if (!selection) return res.status(400).json({ error: "This student has not selected a course to sit for." });
        if (!await db.hasRecentFingerprintPass(req.params.matric)) {
          return res.status(400).json({ error: "The fingerprint check must pass before seat allocation." });
        }
        const schedule = await db.getExamSchedule(selection.course_code);
        if (!schedule) return res.status(400).json({ error: "No exam schedule has been set for this course yet." });
        const seat = await db.allocateSeat(req.params.matric, selection.course_code);
        await db.logVerification(req.params.matric, "attendance", `Approved and seated (${schedule.hall}, Seat ${seat.seat})`);

        // Notify student of seat allocation
        await db.createNotification(
          req.params.matric,
          "seat_allocation",
          "Seat Allocated",
          `You have been seated for ${selection.course_code} in ${schedule.hall}, Row ${seat.row}, Seat ${seat.seat}.`
        );

        res.json({ seat });
      })
    );

    app.get("/api/admin/log", authAdmin, wrap(async (req, res) => {
      const log = (await db.getVerificationLog()).reverse().map((e) => ({ ...e }));
      res.json(log);
    }));

    app.get("/api/admin/seats", authAdmin, wrap(async (req, res) => {
      res.json(await db.allSeats());
    }));

    app.get("/api/admin/schedules", authAdmin, wrap(async (req, res) => {
      res.json(await db.allExamSchedules());
    }));

    app.delete("/api/admin/log", authAdmin, wrap(async (req, res) => {
      const cleared = await db.clearVerificationLog();
      res.json({ ok: true, cleared });
    }));

    app.delete("/api/admin/all", authAdmin, wrap(async (req, res) => {
      const counts = await db.clearAllData();
      res.json({ ok: true, counts });
    }));
  }

  /* Unmatched API paths on this server → JSON 404 (never the static files) */
  app.use("/api", (req, res) => {
    res.status(404).json({ error: "This endpoint is not available on this server." });
  });
}

module.exports = { mountApi, normalizePath, APP };
