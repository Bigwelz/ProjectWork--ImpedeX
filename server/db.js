/* =============================================
   EIPS — Database Layer (server/db.js)
   PostgreSQL via node-postgres (pg).
   All data functions are async — every caller awaits.

   Connection:
     Local dev : DATABASE_URL=postgres://postgres@127.0.0.1:5432/eips
     Render    : DATABASE_URL provided by the hosted PostgreSQL service
   The module keeps the SAME exported interface the
   Express layer (api.js) already uses.
   ============================================= */

"use strict";

require("./load-env");

const { Pool } = require("pg");
const crypto = require("node:crypto");

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ||
    "postgres://postgres@127.0.0.1:5432/eips",
  connectionTimeoutMillis: 5000,
  max: 10,
});

/* PostgreSQL placeholders are $1,$2...; the SQL below keeps the
   familiar `?` style and is rewritten here. No `?` ever appears
   inside a string literal, so a plain replace is safe. */
function q(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

async function exec(sql) {
  await pool.query(sql);
}

function prepare(sql) {
  return {
    async get(...params) {
      const r = await pool.query(q(sql), params);
      return r.rows[0] || undefined;
    },
    async all(...params) {
      const r = await pool.query(q(sql), params);
      return r.rows;
    },
    async run(...params) {
      const r = await pool.query(q(sql), params);
      return {
        changes: r.rowCount,
        lastInsertRowid: r.rows[0] ? r.rows[0].id : undefined,
      };
    },
  };
}

async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await fn(client);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

const ENCRYPTION_KEY = process.env.EIPS_ENCRYPTION_KEY || crypto.createHash("sha256").update("ImpedeX-Biometric-Key-2026").digest("hex").slice(0, 32);

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
   SCHEMA
───────────────────────────────────────── */
async function columnExists(table, col) {
  const r = await pool.query(
    "SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2",
    [table, col]
  );
  return r.rowCount > 0;
}

async function initSchema() {
  await pool.query(`
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
    photo           TEXT,               -- data URL or NULL
    fingerprint_credential_id TEXT,     -- "zk:" scanner template or WebAuthn credential id, or NULL
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
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
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
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    matric       TEXT NOT NULL REFERENCES students(matric) ON DELETE CASCADE,
    course_code  TEXT NOT NULL REFERENCES course_catalog(code),
    hall         TEXT NOT NULL,
    seat_number  INTEGER NOT NULL,
    row_number   INTEGER NOT NULL,
    allocated_at BIGINT NOT NULL,
    UNIQUE (matric, course_code)
  );

  CREATE TABLE IF NOT EXISTS verification_log (
    id      BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    matric  TEXT NOT NULL,
    result  TEXT NOT NULL,               -- pass | fail | attendance
    details TEXT NOT NULL,
    time    BIGINT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS carry_overs (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
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
    access_salt  TEXT,
    access_hash  TEXT,
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
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    matric     TEXT NOT NULL,
    type       TEXT NOT NULL,
    title      TEXT NOT NULL,
    message    TEXT NOT NULL,
    read       INTEGER NOT NULL DEFAULT 0,
    created_at BIGINT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_notifications_matric ON notifications(matric);
  CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications(matric, read);
  `);

  /* ── Migrations: add missing columns to admin_accounts ── */
  const adminMigrations = [
    ["first_name", "TEXT NOT NULL DEFAULT ''"],
    ["last_name", "TEXT NOT NULL DEFAULT ''"],
    ["phone", "TEXT DEFAULT ''"],
    ["department", "TEXT DEFAULT ''"],
  ];
  for (const [col, typedef] of adminMigrations) {
    if (!(await columnExists("admin_accounts", col))) {
      await exec(`ALTER TABLE admin_accounts ADD COLUMN ${col} ${typedef}`);
    }
  }

  if (!(await columnExists("course_catalog", "level"))) {
    await exec("ALTER TABLE course_catalog ADD COLUMN level INTEGER");
  }

  /* ── Migrations: facial recognition removed — drop the column ── */
  if (await columnExists("students", "face_descriptor")) {
    await exec("ALTER TABLE students DROP COLUMN face_descriptor");
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

async function seedCourses() {
  const seedCourseInsert = prepare(
    "INSERT INTO course_catalog (code, title, unit, type) VALUES (?, ?, ?, ?) ON CONFLICT (code) DO NOTHING"
  );
  for (const [code, title, unit] of COMPULSORY) await seedCourseInsert.run(code, title, unit, "compulsory");
  for (const [code, title, unit] of ELECTIVE) await seedCourseInsert.run(code, title, unit, "elective");
}

const DEFAULT_ADMIN_EMAIL = "admin@futo.edu.ng";
const DEFAULT_ADMIN_PASSWORD = "Admin@123!";
const DEFAULT_ADMIN_ACCESS_CODE = "ImpedeX-SecureAdmin-2026!";

async function seedAdmin() {
  const salt = randomSaltB64();
  const hash = hashPasswordSync(DEFAULT_ADMIN_PASSWORD, salt);
  const accessSalt = randomSaltB64();
  const accessHash = hashPasswordSync(DEFAULT_ADMIN_ACCESS_CODE, accessSalt);
  await prepare(
    "INSERT INTO admin_accounts (email, salt, hash, access_salt, access_hash, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (email) DO NOTHING"
  ).run(DEFAULT_ADMIN_EMAIL, salt, hash, accessSalt, accessHash, Date.now());
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
  await prepare(
    `INSERT INTO students (matric, first_name, last_name, email, phone, department, faculty, level, session,
     password_salt, password_hash, photo, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
    data.photo || null,
    data.createdAt || Date.now()
  );
}

async function getStudent(matric) {
  const r = await prepare("SELECT * FROM students WHERE matric = ?").get(matric);
  if (!r) return null;
  return rowToStudent(r);
}

async function getStudentRaw(matric) {
  return prepare("SELECT * FROM students WHERE matric = ?").get(matric);
}

async function allStudents() {
  const rows = await prepare("SELECT * FROM students ORDER BY created_at DESC").all();
  return rows.map(rowToStudent);
}

async function studentExists(matric) {
  return prepare("SELECT 1 FROM students WHERE matric = ?").get(matric) !== undefined;
}

async function updateStudent(matric, patch) {
  const allowed = ["first_name","last_name","email","phone","department","faculty","level","session",
    "password_salt","password_hash","photo","fingerprint_credential_id","registered_at"];
  const sets = [];
  const vals = [];
  let n = 0;
  for (const key of allowed) {
    if (patch[key] !== undefined) {
      sets.push(`${key} = $${++n}`);
      if (key === "fingerprint_credential_id") {
        vals.push(patch[key] ? encryptData(patch[key]) : null);
      } else {
        vals.push(patch[key]);
      }
    }
  }
  if (!sets.length) return getStudent(matric);
  vals.push(matric);
  await prepare(`UPDATE students SET ${sets.join(", ")} WHERE matric = $${++n}`).run(...vals);
  return getStudent(matric);
}

async function deleteStudent(matric) {
  await prepare("DELETE FROM students WHERE matric = ?").run(matric);
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
  return prepare("SELECT * FROM course_catalog ORDER BY type, code").all();
}

async function getCourse(code) {
  return prepare("SELECT * FROM course_catalog WHERE code = ?").get(code);
}

async function insertCourse({ code, title, unit, type, level }) {
  await prepare(
    "INSERT INTO course_catalog (code, title, unit, type, level) VALUES (?, ?, ?, ?, ?)"
  ).run(code, title, unit, type, level || null);
  return getCourse(code);
}

async function updateCourse(code, { title, unit, type }) {
  const sets = [];
  const vals = [];
  let n = 0;
  if (title !== undefined) { sets.push(`title = $${++n}`); vals.push(title); }
  if (unit !== undefined) { sets.push(`unit = $${++n}`); vals.push(unit); }
  if (type !== undefined) { sets.push(`type = $${++n}`); vals.push(type); }
  if (!sets.length) return getCourse(code);
  vals.push(code);
  await prepare(`UPDATE course_catalog SET ${sets.join(", ")} WHERE code = $${++n}`).run(...vals);
  return getCourse(code);
}

async function deleteCourse(code) {
  await prepare("DELETE FROM course_catalog WHERE code = ?").run(code);
}

async function deleteExamSchedule(courseCode) {
  await prepare("DELETE FROM exam_schedules WHERE course_code = ?").run(courseCode);
}

async function getRegisteredCourses(matric) {
  const r = await pool.query(
    q(`SELECT cr.type, cr.registered_at AS "registeredAt", c.code, c.title, c.unit
       FROM course_registrations cr
       JOIN course_catalog c ON c.code = cr.course_code
       WHERE cr.matric = ?`),
    [matric]
  );
  return r.rows;
}

async function getRegisteredStudents(courseCode) {
  const r = await pool.query(
    "SELECT matric FROM course_registrations WHERE course_code = $1",
    [courseCode]
  );
  return r.rows;
}

async function replaceRegistrations(matric, courses) {
  const now = Date.now();
  await withTransaction(async (client) => {
    await client.query("DELETE FROM course_registrations WHERE matric = $1", [matric]);
    for (const c of courses) {
      await client.query(
        "INSERT INTO course_registrations (matric, course_code, type, registered_at) VALUES ($1, $2, $3, $4)",
        [matric, c.code, c.type, now]
      );
    }
    await client.query("UPDATE students SET registered_at = $1 WHERE matric = $2", [now, matric]);
  });
}

async function getExamSelection(matric) {
  return prepare("SELECT * FROM exam_selections WHERE matric = ?").get(matric);
}

async function setExamSelection(matric, courseCode) {
  await prepare(
    `INSERT INTO exam_selections (matric, course_code, selected_at) VALUES (?, ?, ?)
     ON CONFLICT (matric) DO UPDATE SET course_code = EXCLUDED.course_code, selected_at = EXCLUDED.selected_at`
  ).run(matric, courseCode, Date.now());
}

/* ─────────────────────────────────────────
   EXAM SCHEDULES
───────────────────────────────────────── */
async function setExamSchedule(courseCode, { date, time, hall }) {
  await prepare(
    `INSERT INTO exam_schedules (course_code, date, time, hall, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (course_code) DO UPDATE SET date = EXCLUDED.date, time = EXCLUDED.time, hall = EXCLUDED.hall, updated_at = EXCLUDED.updated_at`
  ).run(courseCode, date, time, hall, Date.now());
}

async function getExamSchedule(courseCode) {
  return prepare("SELECT * FROM exam_schedules WHERE course_code = ?").get(courseCode);
}

async function allExamSchedules() {
  const rows = await prepare("SELECT * FROM exam_schedules").all();
  const map = {};
  for (const r of rows) map[r.course_code] = { date: r.date, time: r.time, hall: r.hall };
  return map;
}

/* ─────────────────────────────────────────
   SEATS — allocated by admin on exam day ONLY
───────────────────────────────────────── */
async function getSeat(matric) {
  const r = await prepare("SELECT * FROM seats WHERE matric = ?").get(matric);
  if (!r) return null;
  return {
    hall: r.hall,
    seat: r.seat_number,
    row: r.row_number,
    courseCode: r.course_code,
    allocatedAt: r.allocated_at,
  };
}

async function allSeats() {
  return prepare("SELECT * FROM seats").all();
}

const SEATS_PER_ROW = 10;

/* Exam-day gate for seat allocation: the LATEST fingerprint check for this
   student must be a pass. The registration photo is shown at the checkpoint
   for visual confirmation, but identity is proven with the fingerprint
   scanner. */
async function hasRecentFingerprintPass(matric) {
  const latest = await prepare(
    "SELECT result FROM verification_log WHERE matric = ? AND details LIKE '%Fingerprint%' ORDER BY time DESC LIMIT 1"
  ).get(matric);
  return Boolean(latest && latest.result === "pass");
}

/* Allocate a random available seat for a course+hall. The student cannot
   know it beforehand and cannot forge it. Runs on one connection inside a
   transaction with a per-course advisory lock so concurrent approvals for
   the same course cannot hand out the same seat. */
async function allocateSeat(matric, courseCode) {
  const existing = await getSeat(matric);
  if (existing) return existing;

  const schedule = await getExamSchedule(courseCode);
  if (!schedule) throw new Error("No exam schedule has been set for this course yet.");
  const hall = schedule.hall;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [courseCode]);

    const dup = await client.query("SELECT * FROM seats WHERE matric = $1", [matric]);
    if (dup.rows[0]) {
      await client.query("COMMIT");
      return {
        hall: dup.rows[0].hall,
        seat: dup.rows[0].seat_number,
        row: dup.rows[0].row_number,
        courseCode: dup.rows[0].course_code,
        allocatedAt: dup.rows[0].allocated_at,
      };
    }

    const occ = await client.query(
      "SELECT seat_number FROM seats WHERE course_code = $1 AND hall = $2",
      [courseCode, hall]
    );
    const occupied = occ.rows.map((r) => r.seat_number);

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

    if (!seatNumber) {
      await client.query("ROLLBACK");
      throw new Error("No seats available in this hall.");
    }
    const rowNumber = Math.floor((seatNumber - 1) / SEATS_PER_ROW) + 1;

    await client.query(
      "INSERT INTO seats (matric, course_code, hall, seat_number, row_number, allocated_at) VALUES ($1, $2, $3, $4, $5, $6)",
      [matric, courseCode, hall, seatNumber, rowNumber, Date.now()]
    );
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
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
  await prepare(
    "INSERT INTO verification_log (matric, result, details, time) VALUES (?, ?, ?, ?)"
  ).run(matric, result, details, time);
}

async function getVerificationLog() {
  return prepare("SELECT * FROM verification_log ORDER BY time ASC").all();
}

async function verificationStats() {
  const rows = await prepare(
    "SELECT result, COUNT(*)::int AS n FROM verification_log GROUP BY result"
  ).all();
  const stats = { pass: 0, fail: 0, attendance: 0 };
  for (const r of rows) stats[r.result] = r.n;
  return stats;
}

async function clearVerificationLog() {
  const { changes } = await prepare("DELETE FROM verification_log").run();
  return changes;
}

async function clearAllData() {
  const counts = {};
  await withTransaction(async (client) => {
    for (const table of ["verification_log", "seats", "exam_schedules", "exam_selections", "carry_overs"]) {
      const r = await client.query(`DELETE FROM ${table}`);
      counts[table] = r.rowCount;
    }
  });
  return counts;
}

/* ─────────────────────────────────────────
   ADMIN ACCOUNTS
───────────────────────────────────────── */
async function getAdmin(email) {
  return prepare("SELECT * FROM admin_accounts WHERE email = ?").get(email);
}

async function createAdmin({ email, firstName, lastName, phone, department, password, adminKey }) {
  const salt = randomSaltB64();
  const hash = hashPasswordSync(password, salt);
  const accessSalt = randomSaltB64();
  const accessHash = hashPasswordSync(adminKey, accessSalt);
  await prepare(
    "INSERT INTO admin_accounts (email, first_name, last_name, phone, department, salt, hash, access_salt, access_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(email, firstName || "", lastName || "", phone || "", department || "", salt, hash, accessSalt, accessHash, Date.now());
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
  await prepare(
    `INSERT INTO otps (matric, salt, hash, expires_at, used) VALUES (?, ?, ?, ?, 0)
     ON CONFLICT (matric) DO UPDATE SET salt = EXCLUDED.salt, hash = EXCLUDED.hash, expires_at = EXCLUDED.expires_at, used = 0`
  ).run(matric, salt, hash, Date.now() + expiresInMs);
}

async function verifyOtp(matric, code) {
  const rec = await prepare("SELECT * FROM otps WHERE matric = ?").get(matric);
  if (!rec) return { ok: false, reason: "No OTP was requested for this matric number." };
  if (rec.used) return { ok: false, reason: "This code has already been used." };
  if (Date.now() > rec.expires_at) return { ok: false, reason: "This code has expired. Please request a new one." };
  if (!verifyPasswordSync(code, rec.salt, rec.hash)) return { ok: false, reason: "Incorrect code." };
  await prepare("UPDATE otps SET used = 1 WHERE matric = ?").run(matric);
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
  await prepare(
    "INSERT INTO notifications (matric, type, title, message, read, created_at) VALUES (?, ?, ?, ?, 0, ?)"
  ).run(matric, type, title, message, Date.now());

  // Only send email for important notifications (exam dates and course uploads)
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
  return prepare("SELECT * FROM notifications WHERE matric = ? ORDER BY created_at DESC").all(matric);
}

async function getUnreadCount(matric) {
  const row = await prepare("SELECT COUNT(*)::int AS n FROM notifications WHERE matric = ? AND read = 0").get(matric);
  return row ? row.n : 0;
}

async function markAsRead(matric, notifId) {
  await prepare("UPDATE notifications SET read = 1 WHERE id = ? AND matric = ?").run(notifId, matric);
}

async function markAllAsRead(matric) {
  await prepare("UPDATE notifications SET read = 1 WHERE matric = ? AND read = 0").run(matric);
}

async function clearNotifications(matric) {
  await prepare("DELETE FROM notifications WHERE matric = ?").run(matric);
}

async function notifyAllStudents(type, title, message) {
  const students = await prepare("SELECT matric FROM students").all();
  const now = Date.now();
  await withTransaction(async (client) => {
    for (const s of students) {
      await client.query(
        "INSERT INTO notifications (matric, type, title, message, read, created_at) VALUES ($1, $2, $3, $4, 0, $5)",
        [s.matric, type, title, message, now]
      );
    }
  });
  return students.length;
}

/* ─────────────────────────────────────────
    CARRY-OVERS
───────────────────────────────────────── */
async function getCarryOvers(matric) {
  return prepare(
    `SELECT co.id, co.course_code, co.added_at, c.title, c.unit, c.type
     FROM carry_overs co
     JOIN course_catalog c ON c.code = co.course_code
     WHERE co.matric = ?
     ORDER BY co.added_at DESC`
  ).all(matric);
}

async function addCarryOver(matric, courseCode) {
  await prepare(
    "INSERT INTO carry_overs (matric, course_code, added_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING"
  ).run(matric, courseCode, Date.now());
}

async function removeCarryOver(matric, courseCode) {
  await prepare("DELETE FROM carry_overs WHERE matric = ? AND course_code = ?").run(matric, courseCode);
}

/* ─────────────────────────────────────────
   STARTUP — schema + seed (runs once per process)
───────────────────────────────────────── */
const ready = (async () => {
  await initSchema();
  await seedCourses();
  await seedAdmin();
})();

ready.catch((err) => {
  console.error("DB init failed:", err);
  process.exit(1);
});

module.exports = {
  pool,
  ready,
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
  getRegisteredStudents,
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
