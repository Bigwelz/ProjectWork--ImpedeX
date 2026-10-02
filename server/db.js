/* =============================================
   EIPS — Database Layer (server/db.js)
   Express + node:sqlite (built-in) — real persistent
   SQLite database stored in server/eips.db
============================================= */

"use strict";

const { DatabaseSync } = require("node:sqlite");
const path = require("node:path");

const DB_PATH = path.join(__dirname, "eips.db");
const db = new DatabaseSync(DB_PATH);

/* ─────────────────────────────────────────
   SCHEMA
───────────────────────────────────────── */
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS students (
    matric          TEXT PRIMARY KEY,
    first_name      TEXT NOT NULL,
    last_name       TEXT NOT NULL,
    email           TEXT NOT NULL,
    phone           TEXT DEFAULT '',
    department      TEXT DEFAULT '',
    faculty         TEXT DEFAULT '',
    level           TEXT DEFAULT '',
    session         TEXT DEFAULT '',
    password_salt   TEXT NOT NULL,
    password_hash   TEXT NOT NULL,
    face_descriptor TEXT,               -- JSON array (128 floats) or NULL
    photo           TEXT,               -- data URL or NULL
    fingerprint_credential_id TEXT,     -- WebAuthn credential id or NULL
    created_at      INTEGER NOT NULL,
    registered_at   INTEGER
  );

  CREATE TABLE IF NOT EXISTS course_catalog (
    code   TEXT PRIMARY KEY,
    title  TEXT NOT NULL,
    unit   INTEGER NOT NULL,
    type   TEXT NOT NULL CHECK (type IN ('compulsory','elective'))
  );

  CREATE TABLE IF NOT EXISTS course_registrations (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    matric        TEXT NOT NULL REFERENCES students(matric) ON DELETE CASCADE,
    course_code   TEXT NOT NULL REFERENCES course_catalog(code),
    type          TEXT NOT NULL,
    registered_at INTEGER NOT NULL,
    UNIQUE (matric, course_code)
  );

  CREATE TABLE IF NOT EXISTS exam_selections (
    matric       TEXT PRIMARY KEY REFERENCES students(matric) ON DELETE CASCADE,
    course_code  TEXT NOT NULL REFERENCES course_catalog(code),
    selected_at  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS exam_schedules (
    course_code TEXT PRIMARY KEY REFERENCES course_catalog(code),
    date        TEXT NOT NULL,
    time        TEXT NOT NULL,
    hall        TEXT NOT NULL,
    updated_at  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS seats (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    matric       TEXT NOT NULL REFERENCES students(matric) ON DELETE CASCADE,
    course_code  TEXT NOT NULL REFERENCES course_catalog(code),
    hall         TEXT NOT NULL,
    seat_number  INTEGER NOT NULL,
    row_number   INTEGER NOT NULL,
    allocated_at INTEGER NOT NULL,
    UNIQUE (matric, course_code)
  );

  CREATE TABLE IF NOT EXISTS verification_log (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    matric  TEXT NOT NULL,
    result  TEXT NOT NULL,               -- pass | fail | attendance
    details TEXT NOT NULL,
    time    INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS carry_overs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    matric      TEXT NOT NULL REFERENCES students(matric) ON DELETE CASCADE,
    course_code TEXT NOT NULL REFERENCES course_catalog(code),
    added_at    INTEGER NOT NULL,
    UNIQUE (matric, course_code)
  );

  CREATE TABLE IF NOT EXISTS admin_accounts (
    email      TEXT PRIMARY KEY,
    first_name TEXT NOT NULL DEFAULT '',
    last_name  TEXT NOT NULL DEFAULT '',
    phone      TEXT DEFAULT '',
    department TEXT DEFAULT '',
    salt       TEXT NOT NULL,
    hash       TEXT NOT NULL,
    access_salt  TEXT,
    access_hash  TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS otps (
    matric     TEXT PRIMARY KEY,
    salt       TEXT NOT NULL,
    hash       TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    used       INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS notifications (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    matric     TEXT NOT NULL,
    type       TEXT NOT NULL,
    title      TEXT NOT NULL,
    message    TEXT NOT NULL,
    read       INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_notifications_matric ON notifications(matric);
  CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications(matric, read);
`);

/* ── Migrations: add missing columns to admin_accounts ── */
const adminCols = db.prepare("PRAGMA table_info(admin_accounts)").all().map((c) => c.name);
const adminMigrations = [
  ["first_name", "TEXT NOT NULL DEFAULT ''"],
  ["last_name", "TEXT NOT NULL DEFAULT ''"],
  ["phone", "TEXT DEFAULT ''"],
  ["department", "TEXT DEFAULT ''"],
];
for (const [col, typedef] of adminMigrations) {
  if (!adminCols.includes(col)) {
    db.exec(`ALTER TABLE admin_accounts ADD COLUMN ${col} ${typedef}`);
  }
}

/* ─────────────────────────────────────────
   SEED — course catalogue + default admin
───────────────────────────────────────── */
const COMPULSORY = [
  ["IFT502", "Computer Modeling & Simulation", 3],
  ["IFT508", "Systems Implementation & Evaluation", 2],
  ["IFT510", "Network Administration and Management", 3],
  ["IFT514", "Information Assurance & Security", 2],
  ["IFT504", "Social Issues and Professional Ethics in IT", 2],
  ["IFT506", "Special Topics in Information Technology (Seminar)", 1],
  ["IFT512", "Intelligent Systems", 3],
  ["IFT516", "Distributed Systems", 3],
  ["IFT518", "Human-Computer Interaction", 2],
  ["IFT520", "Software Project Management", 2],
  ["IFT522", "Mobile Application Development", 3],
];
const ELECTIVE = [
  ["CSC509", "Cloud Computing", 2],
  ["CPE521", "Embedded Systems Design", 3],
  ["CSC501", "Compiler Construction", 3],
  ["MEE501", "Entrepreneurship Studies", 2],
  ["CSC511", "Artificial Intelligence", 3],
  ["CSC515", "Data Mining & Warehousing", 2],
  ["CPE523", "Digital Signal Processing", 3],
  ["GST501", "Technical Writing & Communication", 1],
];

const seedCourseInsert = db.prepare(
  "INSERT OR IGNORE INTO course_catalog (code, title, unit, type) VALUES (?, ?, ?, ?)"
);
for (const [code, title, unit] of COMPULSORY) seedCourseInsert.run(code, title, unit, "compulsory");
for (const [code, title, unit] of ELECTIVE) seedCourseInsert.run(code, title, unit, "elective");

const DEFAULT_ADMIN_EMAIL = "admin@futo.edu.ng";
const DEFAULT_ADMIN_PASSWORD = "Admin@123!";
const DEFAULT_ADMIN_ACCESS_CODE = "ImpedeX-SecureAdmin-2026!";

function seedAdmin() {
  const row = db.prepare("SELECT email FROM admin_accounts WHERE email = ?").get(DEFAULT_ADMIN_EMAIL);
  if (row) return;
  const crypto = require("node:crypto");
  const salt = crypto.randomBytes(16).toString("base64");
  const hash = hashPasswordSync(DEFAULT_ADMIN_PASSWORD, salt);
  const accessSalt = crypto.randomBytes(16).toString("base64");
  const accessHash = hashPasswordSync(DEFAULT_ADMIN_ACCESS_CODE, accessSalt);
  db.prepare(
    "INSERT INTO admin_accounts (email, salt, hash, access_salt, access_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(DEFAULT_ADMIN_EMAIL, salt, hash, accessSalt, accessHash, Date.now());
}

/* ─────────────────────────────────────────
   PASSWORD HASHING (server-side, PBKDF2-SHA256)
───────────────────────────────────────── */
const crypto = require("node:crypto");

function hashPasswordSync(password, saltB64) {
  return crypto
    .pbkdf2Sync(password, Buffer.from(saltB64, "base64"), 100000, 32, "sha256")
    .toString("base64");
}

function randomSaltB64(bytes = 16) {
  return crypto.randomBytes(bytes).toString("base64");
}

function verifyPasswordSync(password, saltB64, expectedHashB64) {
  if (!saltB64 || !expectedHashB64) return false;
  const computed = hashPasswordSync(password, saltB64);
  return timingSafeEqualStr(computed, expectedHashB64);
}

function timingSafeEqualStr(a, b) {
  const ba = Buffer.from(a, "base64");
  const bb = Buffer.from(b, "base64");
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

seedAdmin();

/* ─────────────────────────────────────────
   STUDENTS
───────────────────────────────────────── */
function createStudent(data) {
  db.prepare(
    `INSERT INTO students (matric, first_name, last_name, email, phone, department, faculty, level, session,
     password_salt, password_hash, face_descriptor, photo, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    data.matric,
    data.firstName,
    data.lastName,
    data.email,
    data.phone || "",
    data.department || "",
    data.faculty || "",
    data.level || "",
    data.session || "",
    data.passwordSalt,
    data.passwordHash,
    data.faceDescriptor ? JSON.stringify(data.faceDescriptor) : null,
    data.photo || null,
    data.createdAt || Date.now()
  );
}

function getStudent(matric) {
  const r = db.prepare("SELECT * FROM students WHERE matric = ?").get(matric);
  if (!r) return null;
  return rowToStudent(r);
}

function getStudentRaw(matric) {
  return db.prepare("SELECT * FROM students WHERE matric = ?").get(matric);
}

function allStudents() {
  return db.prepare("SELECT * FROM students ORDER BY created_at DESC").all().map(rowToStudent);
}

function studentExists(matric) {
  return !!db.prepare("SELECT 1 FROM students WHERE matric = ?").get(matric);
}

function updateStudent(matric, patch) {
  const allowed = ["first_name","last_name","email","phone","department","faculty","level","session",
    "password_salt","password_hash","face_descriptor","photo","fingerprint_credential_id","registered_at"];
  const sets = [];
  const vals = [];
  for (const key of allowed) {
    if (patch[key] !== undefined) {
      sets.push(`${key} = ?`);
      vals.push(patch[key]);
    }
  }
  if (!sets.length) return getStudent(matric);
  vals.push(matric);
  db.prepare(`UPDATE students SET ${sets.join(", ")} WHERE matric = ?`).run(...vals);
  return getStudent(matric);
}

function deleteStudent(matric) {
  db.prepare("DELETE FROM students WHERE matric = ?").run(matric);
}

function rowToStudent(r) {
  return {
    matric: r.matric,
    firstName: r.first_name,
    lastName: r.last_name,
    email: r.email,
    phone: r.phone,
    department: r.department,
    faculty: r.faculty,
    level: r.level,
    session: r.session,
    passwordSalt: r.password_salt,
    passwordHash: r.password_hash,
    faceDescriptor: r.face_descriptor ? JSON.parse(r.face_descriptor) : null,
    photo: r.photo,
    fingerprintCredentialId: r.fingerprint_credential_id || null,
    createdAt: r.created_at,
    registeredAt: r.registered_at,
  };
}

/* ─────────────────────────────────────────
   COURSES + REGISTRATIONS + EXAM SELECTION
───────────────────────────────────────── */
function allCourses() {
  return db.prepare("SELECT * FROM course_catalog ORDER BY type, code").all();
}

function getCourse(code) {
  return db.prepare("SELECT * FROM course_catalog WHERE code = ?").get(code);
}

function insertCourse({ code, title, unit, type }) {
  db.prepare(
    "INSERT INTO course_catalog (code, title, unit, type) VALUES (?, ?, ?, ?)"
  ).run(code, title, unit, type);
  return getCourse(code);
}

function updateCourse(code, { title, unit, type }) {
  const sets = [];
  const vals = [];
  if (title !== undefined) { sets.push("title = ?"); vals.push(title); }
  if (unit !== undefined) { sets.push("unit = ?"); vals.push(unit); }
  if (type !== undefined) { sets.push("type = ?"); vals.push(type); }
  if (!sets.length) return getCourse(code);
  vals.push(code);
  db.prepare(`UPDATE course_catalog SET ${sets.join(", ")} WHERE code = ?`).run(...vals);
  return getCourse(code);
}

function deleteCourse(code) {
  db.prepare("DELETE FROM course_catalog WHERE code = ?").run(code);
}

function deleteExamSchedule(courseCode) {
  db.prepare("DELETE FROM exam_schedules WHERE course_code = ?").run(courseCode);
}

function getRegisteredCourses(matric) {
  return db
    .prepare(
      `SELECT cr.type, cr.registered_at AS registeredAt, c.code, c.title, c.unit
       FROM course_registrations cr
       JOIN course_catalog c ON c.code = cr.course_code
       WHERE cr.matric = ?`
    )
    .all(matric);
}

function replaceRegistrations(matric, courses) {
  const del = db.prepare("DELETE FROM course_registrations WHERE matric = ?");
  const ins = db.prepare(
    "INSERT OR REPLACE INTO course_registrations (matric, course_code, type, registered_at) VALUES (?, ?, ?, ?)"
  );
  const now = Date.now();
  db.exec("BEGIN");
  try {
    del.run(matric);
    for (const c of courses) ins.run(matric, c.code, c.type, now);
    updateStudent(matric, { registered_at: now });
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

function getExamSelection(matric) {
  return db.prepare("SELECT * FROM exam_selections WHERE matric = ?").get(matric);
}

function setExamSelection(matric, courseCode) {
  db.prepare(
    "INSERT OR REPLACE INTO exam_selections (matric, course_code, selected_at) VALUES (?, ?, ?)"
  ).run(matric, courseCode, Date.now());
}

/* ─────────────────────────────────────────
   EXAM SCHEDULES
───────────────────────────────────────── */
function setExamSchedule(courseCode, { date, time, hall }) {
  db.prepare(
    `INSERT INTO exam_schedules (course_code, date, time, hall, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(course_code) DO UPDATE SET date=excluded.date, time=excluded.time, hall=excluded.hall, updated_at=excluded.updated_at`
  ).run(courseCode, date, time, hall, Date.now());
}

function getExamSchedule(courseCode) {
  return db.prepare("SELECT * FROM exam_schedules WHERE course_code = ?").get(courseCode);
}

function allExamSchedules() {
  const rows = db.prepare("SELECT * FROM exam_schedules").all();
  const map = {};
  for (const r of rows) map[r.course_code] = { date: r.date, time: r.time, hall: r.hall };
  return map;
}

/* ─────────────────────────────────────────
   SEATS — allocated by admin on exam day ONLY
───────────────────────────────────────── */
function getSeat(matric) {
  const r = db.prepare("SELECT * FROM seats WHERE matric = ?").get(matric);
  if (!r) return null;
  return {
    hall: r.hall,
    seat: r.seat_number,
    row: r.row_number,
    courseCode: r.course_code,
    allocatedAt: r.allocated_at,
  };
}

function allSeats() {
  return db.prepare("SELECT * FROM seats").all();
}

const SEATS_PER_ROW = 10;

/* Check that both face and fingerprint checks have passed in the
   verification log for this student (within the current session). */
function hasRecentBiometricPass(matric) {
  const facePass = db.prepare(
    "SELECT 1 FROM verification_log WHERE matric = ? AND result = 'pass' AND details LIKE '%Face%' ORDER BY time DESC LIMIT 1"
  ).get(matric);
  const fpPass = db.prepare(
    "SELECT 1 FROM verification_log WHERE matric = ? AND result = 'pass' AND details LIKE '%Fingerprint%' ORDER BY time DESC LIMIT 1"
  ).get(matric);
  return Boolean(facePass && fpPass);
}

/* Allocate a random available seat for a course+hall. The student cannot
   know it beforehand and cannot forge it. */
function allocateSeat(matric, courseCode) {
  const existing = getSeat(matric);
  if (existing) return existing;

  const schedule = getExamSchedule(courseCode);
  if (!schedule) throw new Error("No exam schedule has been set for this course yet.");
  const hall = schedule.hall;

  const occupied = db
    .prepare("SELECT seat_number FROM seats WHERE course_code = ? AND hall = ?")
    .all(courseCode, hall)
    .map((r) => r.seat_number);

  const totalSeats = 60;
  const available = [];
  for (let i = 1; i <= totalSeats; i++) {
    if (!occupied.includes(i)) available.push(i);
  }
  if (!available.length) throw new Error("No seats available in this hall.");

  const seatNumber = available[Math.floor(Math.random() * available.length)];
  const rowNumber = Math.floor((seatNumber - 1) / SEATS_PER_ROW) + 1;

  db.prepare(
    "INSERT INTO seats (matric, course_code, hall, seat_number, row_number, allocated_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(matric, courseCode, hall, seatNumber, rowNumber, Date.now());

  return getSeat(matric);
}

/* ─────────────────────────────────────────
   VERIFICATION LOG
───────────────────────────────────────── */
function logVerification(matric, result, details, time = Date.now()) {
  db.prepare(
    "INSERT INTO verification_log (matric, result, details, time) VALUES (?, ?, ?, ?)"
  ).run(matric, result, details, time);
}

function getVerificationLog() {
  return db.prepare("SELECT * FROM verification_log ORDER BY time ASC").all();
}

function verificationStats() {
  const rows = db.prepare(
    "SELECT result, COUNT(*) AS n FROM verification_log GROUP BY result"
  ).all();
  const stats = { pass: 0, fail: 0, attendance: 0 };
  for (const r of rows) stats[r.result] = r.n;
  return stats;
}

function clearVerificationLog() {
  const { n } = db.prepare("SELECT COUNT(*) AS n FROM verification_log").get();
  db.prepare("DELETE FROM verification_log").run();
  return n;
}

function clearAllData() {
  const counts = {};
  for (const table of ["verification_log", "seats", "exam_schedules", "exam_selections", "carry_overs"]) {
    const { n } = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get();
    db.prepare(`DELETE FROM ${table}`).run();
    counts[table] = n;
  }
  return counts;
}

/* ─────────────────────────────────────────
   ADMIN ACCOUNTS
───────────────────────────────────────── */
function getAdmin(email) {
  return db.prepare("SELECT * FROM admin_accounts WHERE email = ?").get(email);
}

function createAdmin({ email, firstName, lastName, phone, department, password, adminKey }) {
  const salt = randomSaltB64();
  const hash = hashPasswordSync(password, salt);
  const accessSalt = randomSaltB64();
  const accessHash = hashPasswordSync(adminKey, accessSalt);
  db.prepare(
    "INSERT INTO admin_accounts (email, first_name, last_name, phone, department, salt, hash, access_salt, access_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(email, firstName || "", lastName || "", phone || "", department || "", salt, hash, accessSalt, accessHash, Date.now());
  return getAdmin(email);
}

function verifyAdminCredentials(email, password, adminKey) {
  const acct = getAdmin(email);
  if (!acct) return false;
  if (!verifyPasswordSync(password, acct.salt, acct.hash)) return false;
  if (!verifyPasswordSync(adminKey, acct.access_salt, acct.access_hash)) return false;
  return true;
}

/* ─────────────────────────────────────────
   OTP
───────────────────────────────────────── */
function createOtp(matric, code, expiresInMs = 10 * 60 * 1000) {
  const salt = randomSaltB64();
  const hash = hashPasswordSync(code, salt);
  db.prepare(
    "INSERT OR REPLACE INTO otps (matric, salt, hash, expires_at, used) VALUES (?, ?, ?, ?, 0)"
  ).run(matric, salt, hash, Date.now() + expiresInMs);
}

function verifyOtp(matric, code) {
  const rec = db.prepare("SELECT * FROM otps WHERE matric = ?").get(matric);
  if (!rec) return { ok: false, reason: "No OTP was requested for this matric number." };
  if (rec.used) return { ok: false, reason: "This code has already been used." };
  if (Date.now() > rec.expires_at) return { ok: false, reason: "This code has expired. Please request a new one." };
  if (!verifyPasswordSync(code, rec.salt, rec.hash)) return { ok: false, reason: "Incorrect code." };
  db.prepare("UPDATE otps SET used = 1 WHERE matric = ?").run(matric);
  return { ok: true };
}

function publicStudent(s) {
  if (!s) return null;
  const { passwordSalt, passwordHash, ...pub } = s;
  return pub;
}

/* ─────────────────────────────────────────
    NOTIFICATIONS
───────────────────────────────────────── */
const mailer = require("./mailer");

const EMAIL_NOTIFICATION_TYPES = ["exam_schedule", "course_upload"];

function createNotification(matric, type, title, message) {
  db.prepare(
    "INSERT INTO notifications (matric, type, title, message, read, created_at) VALUES (?, ?, ?, ?, 0, ?)"
  ).run(matric, type, title, message, Date.now());

  // Only send email for important notifications (exam dates and course uploads)
  if (!EMAIL_NOTIFICATION_TYPES.includes(type)) return;

  const student = getStudent(matric);
  if (student && student.email) {
    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background: #0f52ba; color: white; padding: 20px; text-align: center;">
          <h1 style="margin: 0;">ImpedeX</h1>
          <p style="margin: 5px 0 0;">Exam Impersonation Prevention System</p>
        </div>
        <div style="padding: 20px; background: #f8fafc;">
          <h2 style="color: #1e293b;">${title}</h2>
          <p style="color: #475569; line-height: 1.6;">${message}</p>
          <p style="color: #94a3b8; font-size: 12px; margin-top: 20px;">
            This is an automated notification from ImpedeX. Do not share this email with anyone.
          </p>
        </div>
        <div style="background: #1e293b; color: #94a3b8; padding: 10px; text-align: center; font-size: 12px;">
          © ${new Date().getFullYear()} ImpedeX Security. All rights reserved.
        </div>
      </div>
    `;
    mailer.sendEmail(student.email, `ImpedeX: ${title}`, html).catch(() => {});
  }
}

function getNotifications(matric) {
  return db
    .prepare("SELECT * FROM notifications WHERE matric = ? ORDER BY created_at DESC")
    .all(matric);
}

function getUnreadCount(matric) {
  const row = db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE matric = ? AND read = 0").get(matric);
  return row ? row.n : 0;
}

function markAsRead(matric, notifId) {
  db.prepare("UPDATE notifications SET read = 1 WHERE id = ? AND matric = ?").run(notifId, matric);
}

function markAllAsRead(matric) {
  db.prepare("UPDATE notifications SET read = 1 WHERE matric = ? AND read = 0").run(matric);
}

function clearNotifications(matric) {
  db.prepare("DELETE FROM notifications WHERE matric = ?").run(matric);
}

function notifyAllStudents(type, title, message) {
  const students = db.prepare("SELECT matric FROM students").all();
  const ins = db.prepare(
    "INSERT INTO notifications (matric, type, title, message, read, created_at) VALUES (?, ?, ?, ?, 0, ?)"
  );
  const now = Date.now();
  for (const s of students) {
    ins.run(s.matric, type, title, message, now);
  }
  return students.length;
}

/* ─────────────────────────────────────────
    CARRY-OVERS
───────────────────────────────────────── */
function getCarryOvers(matric) {
  return db
    .prepare(
      `SELECT co.id, co.course_code, co.added_at, c.title, c.unit, c.type
       FROM carry_overs co
       JOIN course_catalog c ON c.code = co.course_code
       WHERE co.matric = ?
       ORDER BY co.added_at DESC`
    )
    .all(matric);
}

function addCarryOver(matric, courseCode) {
  db.prepare(
    "INSERT OR IGNORE INTO carry_overs (matric, course_code, added_at) VALUES (?, ?, ?)"
  ).run(matric, courseCode, Date.now());
}

function removeCarryOver(matric, courseCode) {
  db.prepare("DELETE FROM carry_overs WHERE matric = ? AND course_code = ?").run(matric, courseCode);
}

module.exports = {
  db,
  hashPasswordSync,
  randomSaltB64,
  verifyPasswordSync,
  createStudent,
  getStudent,
  getStudentRaw,
  allStudents,
  studentExists,
  updateStudent,
  deleteStudent,
  allCourses,
  getCourse,
  insertCourse,
  updateCourse,
  deleteCourse,
  getRegisteredCourses,
  replaceRegistrations,
  getExamSelection,
  setExamSelection,
  setExamSchedule,
  getExamSchedule,
  allExamSchedules,
  deleteExamSchedule,
  getSeat,
  allSeats,
  hasRecentBiometricPass,
  allocateSeat,
  logVerification,
  getVerificationLog,
  verificationStats,
  clearVerificationLog,
  clearAllData,
  getAdmin,
  createAdmin,
  verifyAdminCredentials,
  createOtp,
  verifyOtp,
  publicStudent,
  createNotification,
  getNotifications,
  getUnreadCount,
  markAsRead,
  markAllAsRead,
  clearNotifications,
  notifyAllStudents,
  getCarryOvers,
  addCarryOver,
  removeCarryOver,
  SEATS_PER_ROW,
};
