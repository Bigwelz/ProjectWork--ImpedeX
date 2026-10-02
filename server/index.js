/* =============================================
   EIPS — Express Server (server/index.js)
   Serves the static frontend and a full REST API
   backed by the SQLite database in server/db.js
============================================= */

"use strict";

const path = require("node:path");
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

const FRONTEND_DIR = path.join(__dirname, "..");

const app = express();
app.use(express.json({ limit: "25mb" })); // face photos (data URLs) can be large
app.use(express.urlencoded({ extended: true }));

/* ─────────────────────────────────────────
   HELPERS
───────────────────────────────────────── */
function studentToken(matric) {
  return jwt.sign({ role: "student", matric }, JWT_SECRET, { expiresIn: STUDENT_TOKEN_TTL });
}
function adminToken(email) {
  return jwt.sign({ role: "admin", email }, JWT_SECRET, { expiresIn: ADMIN_TOKEN_TTL });
}

function authStudent(req, res, next) {
  const tok = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!tok) return res.status(401).json({ error: "Not authenticated." });
  try {
    const payload = jwt.verify(tok, JWT_SECRET);
    if (payload.role !== "student") throw new Error("wrong role");
    req.matric = payload.matric;
    if (!db.studentExists(payload.matric)) return res.status(401).json({ error: "Account no longer exists." });
    next();
  } catch {
    return res.status(401).json({ error: "Session expired. Please log in again." });
  }
}

function authAdmin(req, res, next) {
  const tok = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!tok) return res.status(401).json({ error: "Not authenticated." });
  try {
    const payload = jwt.verify(tok, JWT_SECRET);
    if (payload.role !== "admin") throw new Error("wrong role");
    req.email = payload.email;
    if (!db.getAdmin(payload.email)) return res.status(401).json({ error: "Admin account no longer exists." });
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

/* ─────────────────────────────────────────
   RATE LIMITING (in-memory)
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

/* ─────────────────────────────────────────
   PUBLIC
───────────────────────────────────────── */
app.get("/api/health", (req, res) => res.json({ ok: true, app: APP.name, db: true }));

app.get("/api/courses", (req, res) => {
  const rows = db.allCourses().map((c) => ({
    code: c.code,
    title: c.title,
    unit: c.unit,
    type: c.type.charAt(0).toUpperCase() + c.type.slice(1),
  }));
  res.json(rows);
});

/* ─────────────────────────────────────────
   STUDENT AUTH
───────────────────────────────────────── */
app.post(
  "/api/auth/register",
  wrap(async (req, res) => {
    const b = req.body || {};
    const matric = String(b.matric || "").trim();
    const password = String(b.password || "");

    if (!/^\d{11}$/.test(matric)) {
      return res.status(400).json({ error: "Matric number must be exactly 11 digits." });
    }
    if (db.studentExists(matric)) {
      return res.status(409).json({ error: "An account already exists for this matric number." });
    }
    if (!b.firstName || !b.lastName || !b.email) {
      return res.status(400).json({ error: "First name, last name and email are required." });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: "Password must be at least 8 characters long." });
    }

    const salt = db.randomSaltB64();
    const hash = db.hashPasswordSync(password, salt);

    db.createStudent({
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
      faceDescriptor: Array.isArray(b.faceDescriptor) ? b.faceDescriptor : null,
      photo: b.photo || null,
      createdAt: Date.now(),
    });

    const student = db.publicStudent(db.getStudent(matric));
    res.status(201).json({ token: studentToken(matric), student });
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
    const rec = db.getStudentRaw(matric);
    if (!rec) return res.status(404).json({ error: "No account found for that matric number. Please register." });
    if (!db.verifyPasswordSync(password, rec.password_salt, rec.password_hash)) {
      return res.status(401).json({ error: "Incorrect password." });
    }
    res.json({ token: studentToken(matric), student: db.publicStudent(db.getStudent(matric)) });
  })
);

/* ─────────────────────────────────────────
   FORGOT PASSWORD (server-issued OTP)
───────────────────────────────────────── */
app.post(
  "/api/auth/forgot/request",
  wrap(async (req, res) => {
    const matric = String(req.body.matric || "").trim();
    const email = String(req.body.email || "").trim().toLowerCase();
    if (!/^\d{11}$/.test(matric)) return res.status(400).json({ error: "Matric number must be exactly 11 digits." });
    const rec = db.getStudentRaw(matric);
    if (!rec) return res.status(404).json({ error: "No account found for that matric number." });
    if (!rec.email || rec.email.trim().toLowerCase() !== email) {
      return res.status(400).json({ error: "That email does not match the one on record for this matric number." });
    }
    const code = String(Math.floor(100000 + Math.random() * 900000));
    db.createOtp(matric, code);
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
    const result = db.verifyOtp(matric, code);
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
    if (!db.studentExists(matric)) return res.status(404).json({ error: "No account found for that matric number." });
    const salt = db.randomSaltB64();
    const hash = db.hashPasswordSync(password, salt);
    db.updateStudent(matric, { password_salt: salt, password_hash: hash });
    res.json({ ok: true });
  })
);

/* ─────────────────────────────────────────
   ADMIN AUTH
───────────────────────────────────────── */
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

    if (!db.verifyAdminCredentials(email, password, adminKey)) {
      recordIpFailure(ip);
      recordEmailConsecutiveFailure(ip, email);
      return res.status(401).json({ error: "Invalid admin credentials." });
    }

    clearLoginTracking(ip, email);
    res.json({ token: adminToken(email), email });
  })
);

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
    if (db.getAdmin(email)) {
      return res.status(409).json({ error: "An admin account with this email already exists." });
    }

    const admin = db.createAdmin({ email, firstName, lastName, phone, department, password, adminKey });
    res.json({ ok: true, message: "Admin account created successfully. You can now log in." });
  })
);

/* ─────────────────────────────────────────
   STUDENT API (authenticated)
───────────────────────────────────────── */
app.get("/api/me", authStudent, (req, res) => {
  const s = db.getStudent(req.matric);
  const pub = db.publicStudent(s);
  pub.registeredCourses = db.getRegisteredCourses(s.matric);
  pub.examSelection = db.getExamSelection(s.matric) || null;
  pub.seat = db.getSeat(s.matric);
  res.json({ student: pub });
});

app.post(
  "/api/courses/register",
  authStudent,
  wrap(async (req, res) => {
    const courses = Array.isArray(req.body.courses) ? req.body.courses : [];
    const carryOvers = Array.isArray(req.body.carryOvers) ? req.body.carryOvers : [];
    if (!courses.length && !carryOvers.length) {
      return res.status(400).json({ error: "Select at least one course to register." });
    }

    const normalized = courses.map((c) => {
      const row = db.getCourse(c.code);
      if (!row) throw new Error(`Unknown course code ${c.code}`);
      return { code: row.code, title: row.title, unit: row.unit, type: c.type || row.type };
    });

    const carryOverEntries = carryOvers.map((code) => {
      const row = db.getCourse(code);
      if (!row) throw new Error(`Unknown course code ${code}`);
      return { code: row.code, title: row.title, unit: row.unit, type: "carry_over" };
    });

    db.replaceRegistrations(req.matric, [...normalized, ...carryOverEntries]);

    for (const code of carryOvers) {
      db.addCarryOver(req.matric, code);
    }

    const student = db.publicStudent(db.getStudent(req.matric));
    const registered = db.getRegisteredCourses(req.matric);

    const totalUnits = registered.reduce((s, c) => s + (Number(c.unit) || 0), 0);
    db.createNotification(
      req.matric,
      "course_registration",
      "Courses Registered",
      `You have successfully registered ${registered.length} course${registered.length === 1 ? "" : "s"} (${totalUnits} total units).`
    );

    res.json({ student, registered });
  })
);

app.post(
  "/api/courses/select-exam",
  authStudent,
  wrap(async (req, res) => {
    const code = String(req.body.courseCode || "").trim();
    if (!db.getCourse(code)) return res.status(400).json({ error: "Unknown course code." });
    const registered = db.getRegisteredCourses(req.matric).map((c) => c.code);
    if (!registered.includes(code)) {
      return res.status(400).json({ error: "You have not registered for this course." });
    }
    db.setExamSelection(req.matric, code);
    res.json({ ok: true });
  })
);

app.post(
  "/api/verify/face-enroll",
  authStudent,
  wrap(async (req, res) => {
    const descriptor = Array.isArray(req.body.faceDescriptor) ? req.body.faceDescriptor : null;
    if (!descriptor || descriptor.length !== 128) {
      return res.status(400).json({ error: "A valid 128-length face descriptor is required." });
    }
    const photo = req.body.photo || null;
    db.updateStudent(req.matric, {
      face_descriptor: JSON.stringify(descriptor),
      photo,
    });

    // Check if this is first biometric enrollment
    const student = db.getStudent(req.matric);
    const hasFp = !!student.fingerprintCredentialId;
    db.createNotification(
      req.matric,
      "biometric_enrollment",
      "Face Enrolled",
      hasFp
        ? "Your face biometrics have been enrolled. Both face and fingerprint are now ready for verification."
        : "Your face biometrics have been enrolled. Consider enrolling your fingerprint for full biometric coverage."
    );

    res.json({ ok: true });
  })
);

app.post(
  "/api/verify/fingerprint-enroll",
  authStudent,
  wrap(async (req, res) => {
    const credentialId = String(req.body.credentialId || "");
    if (!credentialId) return res.status(400).json({ error: "Credential id required." });
    db.updateStudent(req.matric, { fingerprint_credential_id: credentialId });

    // Check if this is first biometric enrollment
    const student = db.getStudent(req.matric);
    const hasFace = !!student.faceDescriptor;
    db.createNotification(
      req.matric,
      "biometric_enrollment",
      "Fingerprint Enrolled",
      hasFace
        ? "Your fingerprint has been enrolled. Both face and fingerprint are now ready for verification."
        : "Your fingerprint has been enrolled. Consider enrolling your face for full biometric coverage."
    );

    res.json({ ok: true });
  })
);

app.get("/api/exams", authStudent, (req, res) => {
  const registered = db.getRegisteredCourses(req.matric);
  const schedules = db.allExamSchedules();
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
});

app.get("/api/seat", authStudent, (req, res) => {
  const seat = db.getSeat(req.matric);
  const selection = db.getExamSelection(req.matric);
  const schedule = selection ? db.getExamSchedule(selection.course_code) : null;
  res.json({
    seat,
    examCourse: selection ? { code: selection.course_code } : null,
    schedule,
  });
});

/* ─────────────────────────────────────────
   NOTIFICATIONS (student)
───────────────────────────────────────── */
app.get("/api/notifications", authStudent, (req, res) => {
  const notifications = db.getNotifications(req.matric);
  const unread = db.getUnreadCount(req.matric);
  res.json({ notifications, unread });
});

app.post("/api/notifications/read/:id", authStudent, (req, res) => {
  db.markAsRead(req.matric, Number(req.params.id));
  res.json({ ok: true });
});

app.post("/api/notifications/read-all", authStudent, (req, res) => {
  db.markAllAsRead(req.matric);
  res.json({ ok: true });
});

app.delete("/api/notifications", authStudent, (req, res) => {
  db.clearNotifications(req.matric);
  res.json({ ok: true });
});

/* ─────────────────────────────────────────
   ADMIN API (authenticated)
───────────────────────────────────────── */
app.get(
  "/api/admin/stats",
  authAdmin,
  wrap(async (req, res) => {
    const stats = db.verificationStats();
    const schedules = db.allExamSchedules();
    res.json({
      totalStudents: db.allStudents().length,
      passed: stats.pass,
      failed: stats.fail,
      attendance: stats.attendance,
      examsScheduled: Object.keys(schedules).length,
      seatsAllocated: db.allSeats().length,
    });
  })
);

app.get("/api/admin/students", authAdmin, (req, res) => {
  const students = db.allStudents().map((s) => {
    const pub = db.publicStudent(s);
    pub.registeredCourses = db.getRegisteredCourses(s.matric);
    pub.examSelection = db.getExamSelection(s.matric) || null;
    pub.seat = db.getSeat(s.matric);
    return pub;
  });
  res.json(students);
});

app.get(
  "/api/admin/student/:matric",
  authAdmin,
  wrap(async (req, res) => {
    const s = db.getStudent(req.params.matric);
    if (!s) return res.status(404).json({ error: "Student not found." });
    const pub = db.publicStudent(s);
    pub.registeredCourses = db.getRegisteredCourses(s.matric);
    pub.examSelection = db.getExamSelection(s.matric) || null;
    pub.seat = db.getSeat(s.matric);
    pub.schedule = pub.examSelection ? db.getExamSchedule(pub.examSelection.course_code) : null;
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
    if (db.studentExists(matric)) return res.status(409).json({ error: "A student with this matric number already exists." });
    const tempPassword = Math.random().toString(36).slice(-8) + "A1!";
    const salt = db.randomSaltB64();
    const hash = db.hashPasswordSync(tempPassword, salt);
    db.createStudent({
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
    res.status(201).json({ student: db.publicStudent(db.getStudent(matric)), tempPassword });
  })
);

app.delete(
  "/api/admin/students/:matric",
  authAdmin,
  wrap(async (req, res) => {
    if (!db.studentExists(req.params.matric)) return res.status(404).json({ error: "Student not found." });
    db.deleteStudent(req.params.matric);
    res.json({ ok: true });
  })
);

app.post(
  "/api/admin/schedule",
  authAdmin,
  wrap(async (req, res) => {
    const b = req.body || {};
    const code = String(b.courseCode || "").trim().toUpperCase();
    if (!db.getCourse(code)) return res.status(400).json({ error: "Unknown course code." });
    if (!b.date || !b.time || !b.hall) return res.status(400).json({ error: "Date, time and hall are required." });
    db.setExamSchedule(code, { date: String(b.date), time: String(b.time), hall: String(b.hall) });

    // Notify students registered for this course
    const course = db.getCourse(code);
    const registrations = db.db.prepare("SELECT matric FROM course_registrations WHERE course_code = ?").all(code);
    for (const reg of registrations) {
      db.createNotification(
        reg.matric,
        "exam_schedule",
        "Exam Date Published",
        `Exam for ${code} — ${course.title || ""} has been scheduled for ${b.date} at ${b.time} in ${b.hall}.`
      );
    }

    res.json({ ok: true, schedule: db.getExamSchedule(code) });
  })
);

app.delete(
  "/api/admin/schedule/:courseCode",
  authAdmin,
  wrap(async (req, res) => {
    const code = String(req.params.courseCode).trim().toUpperCase();
    db.deleteExamSchedule(code);
    res.json({ ok: true });
  })
);

/* ─────────────────────────────────────────
   COURSES — student-facing & admin
───────────────────────────────────────── */

/* Helper: extract level from course code (e.g. IFT502 → 500) */
function courseLevel(code) {
  const m = String(code).match(/\d/);
  return m ? parseInt(m[0], 10) * 100 : 0;
}

/* Student-facing: courses for a given level (used during course registration) */
app.get(
  "/api/courses/level/:level",
  authStudent,
  wrap(async (req, res) => {
    const level = parseInt(req.params.level, 10);
    if (![200, 300, 400, 500].includes(level)) {
      return res.status(400).json({ error: "Level must be 200, 300, 400, or 500." });
    }
    const courses = db.allCourses();
    const schedules = db.allExamSchedules();
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
    const student = db.getStudent(req.params.matric);
    if (!student) return res.status(404).json({ error: "Student not found." });
    const studentLevel = courseLevel(student.level || "");
    if (!studentLevel) {
      return res.status(400).json({ error: "Could not determine your level. Please update your profile." });
    }
    const courses = db.allCourses();
    const options = courses
      .filter((c) => {
        const cl = courseLevel(c.code);
        return cl > 0 && cl < studentLevel;
      })
      .map((c) => ({ ...c, level: courseLevel(c.code) }));
    res.json(options);
  })
);

/* ─────────────────────────────────────────
   ADMIN COURSE CATALOG MANAGEMENT
───────────────────────────────────────── */

/* Admin: courses filtered by level (MUST be before :code routes) */
app.get(
  "/api/admin/courses/level/:level",
  authAdmin,
  wrap(async (req, res) => {
    const level = parseInt(req.params.level, 10);
    if (![200, 300, 400, 500].includes(level)) {
      return res.status(400).json({ error: "Level must be 200, 300, 400, or 500." });
    }
    const courses = db.allCourses();
    const schedules = db.allExamSchedules();
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
    const courses = db.allCourses();
    const schedules = db.allExamSchedules();
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
    if (!code || !title || !unit || !type) {
      return res.status(400).json({ error: "Code, title, unit and type are required." });
    }
    if (!["compulsory", "elective"].includes(type)) {
      return res.status(400).json({ error: "Type must be 'compulsory' or 'elective'." });
    }
    if (db.getCourse(code)) {
      return res.status(409).json({ error: `Course ${code} already exists.` });
    }
    const course = db.insertCourse({ code, title, unit, type });

    const count = db.notifyAllStudents(
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
    const existing = db.getCourse(code);
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
    const course = db.updateCourse(code, patch);
    res.json({ ok: true, course });
  })
);

app.delete(
  "/api/admin/courses/:code",
  authAdmin,
  wrap(async (req, res) => {
    const code = String(req.params.code).trim().toUpperCase();
    if (!db.getCourse(code)) return res.status(404).json({ error: "Course not found." });
    db.deleteCourse(code);
    res.json({ ok: true });
  })
);

/* Log a pass/fail face or fingerprint check made at the checkpoint. */
app.post(
  "/api/admin/student/:matric/verify",
  authAdmin,
  wrap(async (req, res) => {
    const s = db.getStudentRaw(req.params.matric);
    if (!s) return res.status(404).json({ error: "Student not found." });
    const b = req.body || {};
    const result = b.result === "fail" ? "fail" : "pass";
    db.logVerification(req.params.matric, result, String(b.details || "Checkpoint verification"));
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
    const s = db.getStudentRaw(req.params.matric);
    if (!s) return res.status(404).json({ error: "Student not found." });
    let selection = db.getExamSelection(req.params.matric);
    if (!selection && req.body.course_code) {
      db.setExamSelection(req.params.matric, req.body.course_code);
      selection = db.getExamSelection(req.params.matric);
    }
    if (!selection) return res.status(400).json({ error: "This student has not selected a course to sit for." });
    if (!db.hasRecentBiometricPass(req.params.matric)) {
      return res.status(400).json({ error: "Both face and fingerprint checks must pass before seat allocation." });
    }
    const schedule = db.getExamSchedule(selection.course_code);
    if (!schedule) return res.status(400).json({ error: "No exam schedule has been set for this course yet." });
    const seat = db.allocateSeat(req.params.matric, selection.course_code);
    db.logVerification(req.params.matric, "attendance", `Approved and seated (${schedule.hall}, Seat ${seat.seat})`);

    // Notify student of seat allocation
    db.createNotification(
      req.params.matric,
      "seat_allocation",
      "Seat Allocated",
      `You have been seated for ${selection.course_code} in ${schedule.hall}, Row ${seat.row}, Seat ${seat.seat}.`
    );

    res.json({ seat });
  })
);

app.get("/api/admin/log", authAdmin, (req, res) => {
  const log = db.getVerificationLog().reverse().map((e) => ({ ...e }));
  res.json(log);
});

app.get("/api/admin/seats", authAdmin, (req, res) => {
  res.json(db.allSeats());
});

app.get("/api/admin/schedules", authAdmin, (req, res) => {
  res.json(db.allExamSchedules());
});

app.delete("/api/admin/log", authAdmin, (req, res) => {
  const cleared = db.clearVerificationLog();
  res.json({ ok: true, cleared });
});

app.delete("/api/admin/all", authAdmin, (req, res) => {
  const counts = db.clearAllData();
  res.json({ ok: true, counts });
});

/* ─────────────────────────────────────────
   STATIC FRONTEND
───────────────────────────────────────── */
app.use(express.static(FRONTEND_DIR));

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`EIPS backend running at http://localhost:${PORT}`);
  console.log("Serving frontend from " + FRONTEND_DIR);
});
