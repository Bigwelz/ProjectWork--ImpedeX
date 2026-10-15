/* =============================================
   EIPS — Database Layer (server/db.js)
   Express + pg (Neon PostgreSQL)
   Async — all functions use the pool.
   Requires .env loaded by the caller (dotenv).
   ============================================= */

"use strict";

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const crypto = require("node:crypto");
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("localhost") ? false : { rejectUnauthorized: false },
  max: 3,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

pool.on("error", (err) => console.error("PostgreSQL pool error:", err.message));

const ENCRYPTION_KEY =
  process.env.EIPS_ENCRYPTION_KEY ||
  crypto.createHash("sha256").update("ImpedeX-Biometric-Key-2026").digest("hex").slice(0, 32);

function encryptData(plaintext) {
  if (!plaintext) return null;
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-cbc", Buffer.from(ENCRYPTION_KEY, "utf8"), iv);
  let encrypted = cipher.update(String(plaintext), "utf8", "hex");
  encrypted += cipher.final("hex");
  return iv.toString("hex") + ":" + encrypted;
}

function decryptData(ciphertext) {
  if (!ciphertext) return null;
  try {
    const [ivHex, encryptedHex] = ciphertext.split(":");
    const iv = Buffer.from(ivHex, "hex");
    const decipher = crypto.createDecipheriv("aes-256-cbc", Buffer.from(ENCRYPTION_KEY, "utf8"), iv);
    let decrypted = decipher.update(encryptedHex, "hex", "utf8");
    decrypted += decipher.final("utf8");
    return decrypted;
  } catch {
    return null;
  }
}

/* ─────────────────────────────────────────
   SCHEMA — CREATE IF NOT EXISTS (idempotent)
   ───────────────────────────────────────── */
const SCHEMA_SQL = `
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
    photo           TEXT,
    fingerprint_credential_id TEXT,
    created_at      BIGINT NOT NULL,
    registered_at   BIGINT
  );

  CREATE TABLE IF NOT EXISTS course_catalog (
    code   TEXT PRIMARY KEY,
    title  TEXT NOT NULL,
    unit   INTEGER NOT NULL,
    type   TEXT NOT NULL CHECK (type IN ('compulsory','elective')),
    level  INTEGER
  );

  CREATE TABLE IF NOT EXISTS course_registrations (
    id            SERIAL PRIMARY KEY,
    matric        TEXT NOT NULL REFERENCES students(matric) ON DELETE CASCADE,
    course_code   TEXT NOT NULL REFERENCES course_catalog(code),
    type          TEXT NOT NULL,
    registered_at BIGINT NOT NULL,
    UNIQUE (matric, course_code)
  );

  CREATE TABLE IF NOT EXISTS exam_selections (
    matric       TEXT PRIMARY KEY REFERENCES students(matric) ON DELETE CASCADE,
    course_code  TEXT NOT NULL REFERENCES course_catalog(code),
    selected_at  BIGINT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS exam_schedules (
    course_code TEXT PRIMARY KEY REFERENCES course_catalog(code),
    date        TEXT NOT NULL,
    time        TEXT NOT NULL,
    hall        TEXT NOT NULL,
    updated_at  BIGINT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS seats (
    id           SERIAL PRIMARY KEY,
    matric       TEXT NOT NULL REFERENCES students(matric) ON DELETE CASCADE,
    course_code  TEXT NOT NULL REFERENCES course_catalog(code),
    hall         TEXT NOT NULL,
    seat_number  INTEGER NOT NULL,
    row_number   INTEGER NOT NULL,
    allocated_at BIGINT NOT NULL,
    UNIQUE (matric, course_code)
  );

  CREATE TABLE IF NOT EXISTS verification_log (
    id      SERIAL PRIMARY KEY,
    matric  TEXT NOT NULL,
    result  TEXT NOT NULL,
    details TEXT NOT NULL,
    time    BIGINT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS carry_overs (
    id          SERIAL PRIMARY KEY,
    matric      TEXT NOT NULL REFERENCES students(matric) ON DELETE CASCADE,
    course_code TEXT NOT NULL REFERENCES course_catalog(code),
    added_at    BIGINT NOT NULL,
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
    access_salt TEXT,
    access_hash TEXT,
    created_at BIGINT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS otps (
    matric     TEXT PRIMARY KEY,
    salt       TEXT NOT NULL,
    hash       TEXT NOT NULL,
    expires_at BIGINT NOT NULL,
    used       INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS notifications (
    id         SERIAL PRIMARY KEY,
    matric     TEXT NOT NULL,
    type       TEXT NOT NULL,
    title      TEXT NOT NULL,
    message    TEXT NOT NULL,
    read       INTEGER NOT NULL DEFAULT 0,
    created_at BIGINT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_notifications_matric ON notifications(matric);
  CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications(matric, read);
`;

async function initSchema() {
  await pool.query(SCHEMA_SQL);
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

const DEFAULT_ADMIN_EMAIL = "admin@futo.edu.ng";
const DEFAULT_ADMIN_PASSWORD = "Admin@123!";
const DEFAULT_ADMIN_ACCESS_CODE = "ImpedeX-SecureAdmin-2026!";

async function seedCourses() {
  for (const [code, title, unit] of COMPULSORY) {
    await pool.query(
      "INSERT INTO course_catalog (code, title, unit, type) VALUES ($1, $2, $3, 'compulsory') ON CONFLICT (code) DO NOTHING",
      [code, title, unit]
    );
  }
  for (const [code, title, unit] of ELECTIVE) {
    await pool.query(
      "INSERT INTO course_catalog (code, title, unit, type) VALUES ($1, $2, $3, 'elective') ON CONFLICT (code) DO NOTHING",
      [code, title, unit]
    );
  }
}

async function seedAdmin() {
  const { rows } = await pool.query("SELECT email FROM admin_accounts WHERE email = $1", [DEFAULT_ADMIN_EMAIL]);
  if (rows.length) return;
  const salt = crypto.randomBytes(16).toString("base64");
  const hash = hashPasswordSync(DEFAULT_ADMIN_PASSWORD, salt);
  const accessSalt = crypto.randomBytes(16).toString("base64");
  const accessHash = hashPasswordSync(DEFAULT_ADMIN_ACCESS_CODE, accessSalt);
  await pool.query(
    "INSERT INTO admin_accounts (email, salt, hash, access_salt, access_hash, created_at) VALUES ($1, $2, $3, $4, $5, $6)",
    [DEFAULT_ADMIN_EMAIL, salt, hash, accessSalt, accessHash, Date.now()]
  );
}

async function init() {
  await initSchema();
  await seedCourses();
  await seedAdmin();
}

/* ─────────────────────────────────────────
   PASSWORD HASHING (server-side, PBKDF2-SHA256)
   ───────────────────────────────────────── */

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

/* ─────────────────────────────────────────
   STUDENTS
   ───────────────────────────────────────── */
async function createStudent(data) {
  await pool.query(
    `INSERT INTO students (matric, first_name, last_name, email, phone, department, faculty, level, session,
     password_salt, password_hash, photo, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [
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
      data.photo || null,
      data.createdAt || Date.now(),
    ]
  );
}

async function getStudent(matric) {
  const { rows } = await pool.query("SELECT * FROM students WHERE matric = $1", [matric]);
  if (!rows.length) return null;
  return rowToStudent(rows[0]);
}

async function getStudentRaw(matric) {
  const { rows } = await pool.query("SELECT * FROM students WHERE matric = $1", [matric]);
  return rows[0] || null;
}

async function allStudents() {
  const { rows } = await pool.query("SELECT * FROM students ORDER BY created_at DESC");
  return rows.map(rowToStudent);
}

async function studentExists(matric) {
  const { rows } = await pool.query("SELECT 1 FROM students WHERE matric = $1", [matric]);
  return rows.length > 0;
}

async function updateStudent(matric, patch, client) {
  const allowed = [
    "first_name", "last_name", "email", "phone", "department", "faculty", "level", "session",
    "password_salt", "password_hash", "photo", "fingerprint_credential_id", "registered_at",
  ];
  const sets = [];
  const vals = [];
  let i = 1;
  for (const key of allowed) {
    if (patch[key] !== undefined) {
      sets.push(`${key} = $${i}`);
      if (key === "fingerprint_credential_id") {
        vals.push(patch[key] ? encryptData(patch[key]) : null);
      } else {
        vals.push(patch[key]);
      }
      i++;
    }
  }
  if (!sets.length) return getStudent(matric);
  vals.push(matric);
  const q = client || pool;
  await q.query(`UPDATE students SET ${sets.join(", ")} WHERE matric = $${i}`, vals);
  return getStudent(matric);
}

async function deleteStudent(matric) {
  await pool.query("DELETE FROM students WHERE matric = $1", [matric]);
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
    photo: r.photo,
    fingerprintCredentialId: r.fingerprint_credential_id ? decryptData(r.fingerprint_credential_id) : null,
    createdAt: r.created_at,
    registeredAt: r.registered_at,
  };
}

/* ─────────────────────────────────────────
   COURSES + REGISTRATIONS + EXAM SELECTION
   ───────────────────────────────────────── */
async function allCourses() {
  const { rows } = await pool.query("SELECT * FROM course_catalog ORDER BY type, code");
  return rows;
}

async function getCourse(code) {
  const { rows } = await pool.query("SELECT * FROM course_catalog WHERE code = $1", [code]);
  return rows[0] || null;
}

async function insertCourse({ code, title, unit, type, level }) {
  await pool.query(
    "INSERT INTO course_catalog (code, title, unit, type, level) VALUES ($1, $2, $3, $4, $5)",
    [code, title, unit, type, level || null]
  );
  return getCourse(code);
}

async function updateCourse(code, { title, unit, type }) {
  const sets = [];
  const vals = [];
  let i = 1;
  if (title !== undefined) { sets.push(`title = $${i}`); vals.push(title); i++; }
  if (unit !== undefined) { sets.push(`unit = $${i}`); vals.push(unit); i++; }
  if (type !== undefined) { sets.push(`type = $${i}`); vals.push(type); i++; }
  if (!sets.length) return getCourse(code);
  vals.push(code);
  await pool.query(`UPDATE course_catalog SET ${sets.join(", ")} WHERE code = $${i}`, vals);
  return getCourse(code);
}

async function deleteCourse(code) {
  await pool.query("DELETE FROM course_catalog WHERE code = $1", [code]);
}

async function deleteExamSchedule(courseCode) {
  await pool.query("DELETE FROM exam_schedules WHERE course_code = $1", [courseCode]);
}

async function getRegisteredCourses(matric) {
  const { rows } = await pool.query(
    `SELECT cr.type, cr.registered_at AS "registeredAt", c.code, c.title, c.unit
     FROM course_registrations cr
     JOIN course_catalog c ON c.code = cr.course_code
     WHERE cr.matric = $1`,
    [matric]
  );
  return rows;
}

async function replaceRegistrations(matric, courses) {
  const client = await pool.connect();
  const now = Date.now();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM course_registrations WHERE matric = $1", [matric]);
    for (const c of courses) {
      await client.query(
        `INSERT INTO course_registrations (matric, course_code, type, registered_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (matric, course_code) DO UPDATE SET type = $3, registered_at = $4`,
        [matric, c.code, c.type, now]
      );
    }
    // Inline the student update so it joins the transaction
    await client.query("UPDATE students SET registered_at = $1 WHERE matric = $2", [now, matric]);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function getExamSelection(matric) {
  const { rows } = await pool.query("SELECT * FROM exam_selections WHERE matric = $1", [matric]);
  return rows[0] || null;
}

async function setExamSelection(matric, courseCode) {
  await pool.query(
    `INSERT INTO exam_selections (matric, course_code, selected_at) VALUES ($1, $2, $3)
     ON CONFLICT (matric) DO UPDATE SET course_code = $2, selected_at = $3`,
    [matric, courseCode, Date.now()]
  );
}

/* ─────────────────────────────────────────
   EXAM SCHEDULES
   ───────────────────────────────────────── */
async function setExamSchedule(courseCode, { date, time, hall }) {
  await pool.query(
    `INSERT INTO exam_schedules (course_code, date, time, hall, updated_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (course_code) DO UPDATE SET date = $2, time = $3, hall = $4, updated_at = $5`,
    [courseCode, date, time, hall, Date.now()]
  );
}

async function getExamSchedule(courseCode) {
  const { rows } = await pool.query("SELECT * FROM exam_schedules WHERE course_code = $1", [courseCode]);
  return rows[0] || null;
}

async function allExamSchedules() {
  const { rows } = await pool.query("SELECT * FROM exam_schedules");
  const map = {};
  for (const r of rows) map[r.course_code] = { date: r.date, time: r.time, hall: r.hall };
  return map;
}

/* ─────────────────────────────────────────
   SEATS — allocated by admin on exam day ONLY
   ───────────────────────────────────────── */
async function getSeat(matric) {
  const { rows } = await pool.query("SELECT * FROM seats WHERE matric = $1", [matric]);
  if (!rows.length) return null;
  const r = rows[0];
  return {
    hall: r.hall,
    seat: r.seat_number,
    row: r.row_number,
    courseCode: r.course_code,
    allocatedAt: r.allocated_at,
  };
}

async function allSeats() {
  const { rows } = await pool.query("SELECT * FROM seats");
  return rows;
}

const SEATS_PER_ROW = 10;

async function hasRecentFingerprintPass(matric) {
  const { rows } = await pool.query(
    `SELECT result FROM verification_log
     WHERE matric = $1 AND details ILIKE '%Fingerprint%'
     ORDER BY time DESC LIMIT 1`,
    [matric]
  );
  return Boolean(rows.length && rows[0].result === "pass");
}

async function allocateSeat(matric, courseCode) {
  const existing = await getSeat(matric);
  if (existing) return existing;

  const schedule = await getExamSchedule(courseCode);
  if (!schedule) throw new Error("No exam schedule has been set for this course yet.");
  const hall = schedule.hall;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: occupiedRows } = await client.query(
      "SELECT seat_number FROM seats WHERE course_code = $1 AND hall = $2",
      [courseCode, hall]
    );
    const occupied = occupiedRows.map((r) => r.seat_number);

    const BLOCK_SIZE = 50;
    const TOTAL_SEATS = 400;
    const numBlocks = TOTAL_SEATS / BLOCK_SIZE;

    let seatNumber = null;
    for (let block = 0; block < numBlocks; block++) {
      const blockStart = block * BLOCK_SIZE + 1;
      const blockEnd = blockStart + BLOCK_SIZE - 1;
      const availableInBlock = [];
      for (let i = blockStart; i <= blockEnd; i++) {
        if (!occupied.includes(i)) availableInBlock.push(i);
      }
      if (availableInBlock.length) {
        seatNumber = availableInBlock[Math.floor(Math.random() * availableInBlock.length)];
        break;
      }
    }

    if (!seatNumber) throw new Error("No seats available in this hall.");
    const rowNumber = Math.floor((seatNumber - 1) / SEATS_PER_ROW) + 1;

    await client.query(
      `INSERT INTO seats (matric, course_code, hall, seat_number, row_number, allocated_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (matric, course_code) DO NOTHING`,
      [matric, courseCode, hall, seatNumber, rowNumber, Date.now()]
    );
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }

  return getSeat(matric);
}

/* ─────────────────────────────────────────
   VERIFICATION LOG
   ───────────────────────────────────────── */
async function logVerification(matric, result, details, time = Date.now()) {
  await pool.query(
    "INSERT INTO verification_log (matric, result, details, time) VALUES ($1, $2, $3, $4)",
    [matric, result, details, time]
  );
}

async function getVerificationLog() {
  const { rows } = await pool.query("SELECT * FROM verification_log ORDER BY time ASC");
  return rows;
}

async function verificationStats() {
  const { rows } = await pool.query(
    "SELECT result, COUNT(*)::int AS n FROM verification_log GROUP BY result"
  );
  const stats = { pass: 0, fail: 0, attendance: 0 };
  for (const r of rows) stats[r.result] = r.n;
  return stats;
}

async function clearVerificationLog() {
  const { rows } = await pool.query("SELECT COUNT(*)::int AS n FROM verification_log");
  await pool.query("DELETE FROM verification_log");
  return rows[0].n;
}

async function clearAllData() {
  const counts = {};
  for (const table of ["verification_log", "seats", "exam_schedules", "exam_selections", "carry_overs"]) {
    const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM ${table}`);
    await pool.query(`DELETE FROM ${table}`);
    counts[table] = rows[0].n;
  }
  return counts;
}

/* ─────────────────────────────────────────
   ADMIN ACCOUNTS
   ───────────────────────────────────────── */
async function getAdmin(email) {
  const { rows } = await pool.query("SELECT * FROM admin_accounts WHERE email = $1", [email]);
  return rows[0] || null;
}

async function createAdmin({ email, firstName, lastName, phone, department, password, adminKey }) {
  const salt = randomSaltB64();
  const hash = hashPasswordSync(password, salt);
  const accessSalt = randomSaltB64();
  const accessHash = hashPasswordSync(adminKey, accessSalt);
  await pool.query(
    `INSERT INTO admin_accounts (email, first_name, last_name, phone, department, salt, hash, access_salt, access_hash, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [email, firstName || "", lastName || "", phone || "", department || "", salt, hash, accessSalt, accessHash, Date.now()]
  );
  return getAdmin(email);
}

async function verifyAdminCredentials(email, password, adminKey) {
  const acct = await getAdmin(email);
  if (!acct) return false;
  if (!verifyPasswordSync(password, acct.salt, acct.hash)) return false;
  if (!verifyPasswordSync(adminKey, acct.access_salt, acct.access_hash)) return false;
  return true;
}

/* ─────────────────────────────────────────
   OTP
   ───────────────────────────────────────── */
async function createOtp(matric, code, expiresInMs = 10 * 60 * 1000) {
  const salt = randomSaltB64();
  const hash = hashPasswordSync(code, salt);
  await pool.query(
    `INSERT INTO otps (matric, salt, hash, expires_at, used) VALUES ($1, $2, $3, $4, 0)
     ON CONFLICT (matric) DO UPDATE SET salt = $2, hash = $3, expires_at = $4, used = 0`,
    [matric, salt, hash, Date.now() + expiresInMs]
  );
}

async function verifyOtp(matric, code) {
  const { rows } = await pool.query("SELECT * FROM otps WHERE matric = $1", [matric]);
  const rec = rows[0];
  if (!rec) return { ok: false, reason: "No OTP was requested for this matric number." };
  if (rec.used) return { ok: false, reason: "This code has already been used." };
  if (Date.now() > rec.expires_at) return { ok: false, reason: "This code has expired. Please request a new one." };
  if (!verifyPasswordSync(code, rec.salt, rec.hash)) return { ok: false, reason: "Incorrect code." };
  await pool.query("UPDATE otps SET used = 1 WHERE matric = $1", [matric]);
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

async function createNotification(matric, type, title, message) {
  await pool.query(
    "INSERT INTO notifications (matric, type, title, message, read, created_at) VALUES ($1, $2, $3, $4, 0, $5)",
    [matric, type, title, message, Date.now()]
  );

  if (!EMAIL_NOTIFICATION_TYPES.includes(type)) return;

  const student = await getStudent(matric);
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

async function getNotifications(matric) {
  const { rows } = await pool.query(
    "SELECT * FROM notifications WHERE matric = $1 ORDER BY created_at DESC",
    [matric]
  );
  return rows;
}

async function getUnreadCount(matric) {
  const { rows } = await pool.query(
    "SELECT COUNT(*)::int AS n FROM notifications WHERE matric = $1 AND read = 0",
    [matric]
  );
  return rows.length ? rows[0].n : 0;
}

async function markAsRead(matric, notifId) {
  await pool.query("UPDATE notifications SET read = 1 WHERE id = $1 AND matric = $2", [notifId, matric]);
}

async function markAllAsRead(matric) {
  await pool.query("UPDATE notifications SET read = 1 WHERE matric = $1 AND read = 0", [matric]);
}

async function clearNotifications(matric) {
  await pool.query("DELETE FROM notifications WHERE matric = $1", [matric]);
}

async function notifyAllStudents(type, title, message) {
  const { rows: students } = await pool.query("SELECT matric FROM students");
  const now = Date.now();
  for (const s of students) {
    await pool.query(
      "INSERT INTO notifications (matric, type, title, message, read, created_at) VALUES ($1, $2, $3, $4, 0, $5)",
      [s.matric, type, title, message, now]
    );
  }
  return students.length;
}

/* ─────────────────────────────────────────
   CARRY-OVERS
   ───────────────────────────────────────── */
async function getCarryOvers(matric) {
  const { rows } = await pool.query(
    `SELECT co.id, co.course_code, co.added_at, c.title, c.unit, c.type
     FROM carry_overs co
     JOIN course_catalog c ON c.code = co.course_code
     WHERE co.matric = $1
     ORDER BY co.added_at DESC`,
    [matric]
  );
  return rows;
}

async function addCarryOver(matric, courseCode) {
  await pool.query(
    "INSERT INTO carry_overs (matric, course_code, added_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
    [matric, courseCode, Date.now()]
  );
}

async function removeCarryOver(matric, courseCode) {
  await pool.query("DELETE FROM carry_overs WHERE matric = $1 AND course_code = $2", [matric, courseCode]);
}

async function getRegistrationsForCourse(courseCode) {
  const { rows } = await pool.query("SELECT matric FROM course_registrations WHERE course_code = $1", [courseCode]);
  return rows;
}

async function getRegistrationsBatch(matrics) {
  if (!matrics.length) return {};
  const { rows } = await pool.query(
    `SELECT cr.matric, cr.type, cr.registered_at AS "registeredAt", c.code, c.title, c.unit
     FROM course_registrations cr
     JOIN course_catalog c ON c.code = cr.course_code
     WHERE cr.matric = ANY($1)`,
    [matrics]
  );
  const map = {};
  for (const r of rows) {
    if (!map[r.matric]) map[r.matric] = [];
    map[r.matric].push(r);
  }
  return map;
}

async function getExamSelectionsBatch(matrics) {
  if (!matrics.length) return {};
  const { rows } = await pool.query(
    "SELECT * FROM exam_selections WHERE matric = ANY($1)",
    [matrics]
  );
  const map = {};
  for (const r of rows) map[r.matric] = r;
  return map;
}

async function getSeatsBatch(matrics) {
  if (!matrics.length) return {};
  const { rows } = await pool.query("SELECT * FROM seats WHERE matric = ANY($1)", [matrics]);
  const map = {};
  for (const r of rows) {
    map[r.matric] = {
      hall: r.hall,
      seat: r.seat_number,
      row: r.row_number,
      courseCode: r.course_code,
      allocatedAt: r.allocated_at,
    };
  }
  return map;
}

module.exports = {
  pool,
  init,
  getRegistrationsForCourse,
  getRegistrationsBatch,
  getExamSelectionsBatch,
  getSeatsBatch,
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
  hasRecentFingerprintPass,
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
