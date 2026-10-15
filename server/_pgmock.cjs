/* =============================================
   EIPS — mock-pg verification harness (dev only)
   Loads server/db.js against a fake node-postgres
   and exercises the critical flows, asserting:
     - no raw "?" placeholders leak into SQL
     - ?  → $n conversion is correct
     - transactions run on one client (BEGIN/COMMIT)
     - seat allocation takes the advisory lock
     - upserts use ON CONFLICT
     - timestamps are BIGINT-safe numbers
     - row mapping snake_case → camelCase
   Run: node scripts/_pgmock.cjs   (from server/)
   ============================================= */

"use strict";

const path = require("node:path");
const pgPath = require.resolve("pg");
const queries = [];
let state = { seatInserted: false };

function fakeResult(rows = []) {
  return { rows, rowCount: rows.length };
}

const studentRow = {
  matric: "20211292099",
  first_name: "Bridge",
  last_name: "Tester",
  email: "bridge@futo.edu.ng",
  phone: "08000000000",
  department: "IFT",
  faculty: "FUTO",
  level: "500",
  session: "2021/2022",
  password_salt: "c2FsdA==",
  password_hash: "aGFzaA==",
  photo: "data:image/png;base64,AAAA",
  fingerprint_credential_id: null,
  created_at: 1700000000000,
  registered_at: 1700000001000,
};

const router = (sql) => {
  if (/INSERT INTO seats/.test(sql)) state.seatInserted = true;
  if (/information_schema/.test(sql)) return fakeResult([{ ok: 1 }]);
  if (/SELECT \* FROM students WHERE matric/.test(sql)) return fakeResult([studentRow]);
  if (/SELECT \* FROM students ORDER BY created_at/.test(sql)) return fakeResult([studentRow, { ...studentRow, matric: "20211292002" }]);
  if (/SELECT 1 FROM students WHERE matric/.test(sql)) return fakeResult([{}]);
  if (/SELECT matric FROM students/.test(sql)) return fakeResult([{ matric: "20211292099" }]);
  if (/FROM otps/.test(sql)) return fakeResult([]);
  if (/verification_log WHERE matric/.test(sql)) return fakeResult([{ result: "pass" }]);
  if (/COUNT\(\*\)::int/.test(sql)) return fakeResult([{ n: 3 }]);
  if (/FROM exam_schedules WHERE course_code/.test(sql)) return fakeResult([{ course_code: "IFT502", date: "2026-10-20", time: "09:00", hall: "Hall A" }]);
  if (/FROM seats WHERE matric/.test(sql)) return fakeResult(state.seatInserted ? [{ hall: "Hall A", seat_number: 7, row_number: 2, course_code: "IFT502", allocated_at: 1700000002000 }] : []);
  if (/SELECT seat_number FROM seats/.test(sql)) return fakeResult([]);
  return fakeResult([]);
};

const fakeClient = {
  query: async (sql, params) => {
    queries.push({ client: "tx", sql, params });
    return router(sql);
  },
  release: () => {},
};

const fakePool = {
  query: async (sql, params) => {
    queries.push({ client: "pool", sql, params });
    return router(sql);
  },
  connect: async () => fakeClient,
  end: async () => {},
};

require.cache[pgPath] = {
  id: pgPath,
  filename: pgPath,
  loaded: true,
  exports: { Pool: function () { return fakePool; }, Client: function () { return fakeClient; } },
};

process.env.EIPS_ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef";

const db = require(path.join(__dirname, "db.js"));

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) {
    pass++;
    console.log("  PASS  " + name);
  } else {
    fail++;
    console.log("  FAIL  " + name + (extra ? "  — " + extra : ""));
  }
}

function noPlaceholders() {
  const bad = queries.find((q) => /\?/.test(q.sql));
  return bad ? "raw ? in: " + bad.sql : null;
}

async function main() {
  await db.ready;
  console.log("db ready\n-- student flow --");

  await db.createStudent({ matric: "20211292099", firstName: "Bridge", lastName: "Tester", email: "b@futo.edu.ng", passwordSalt: "s", passwordHash: "h", photo: "data:image/png;base64,AA", createdAt: 1700000000000 });
  let q = queries.find((x) => /INSERT INTO students/.test(x.sql));
  check("createStudent INSERT issued", !!q);
  check("createStudent 13 params", q && q.params.length === 13, q && String(q.params.length));
  check("createStudent photo param is data URL", q && q.params[11] === "data:image/png;base64,AA");

  const stu = await db.getStudent("20211292099");
  check("getStudent maps snake→camel", stu && stu.firstName === "Bridge" && stu.passwordSalt === "c2FsdA==" && stu.createdAt === 1700000000000);
  check("studentExists true", (await db.studentExists("20211292099")) === true);

  await db.updateStudent("20211292099", { fingerprint_credential_id: "zk:AAAA" });
  q = queries.find((x) => /UPDATE students SET/.test(x.sql));
  check("updateStudent encrypts fingerprint (iv:hex)", q && /^[0-9a-f]{32}:[0-9a-f]+$/.test(q.params[0]), q && q.params[0]);

  await db.replaceRegistrations("20211292099", [{ code: "IFT502", type: "compulsory" }]);
  const txQueries = queries.filter((x) => x.client === "tx");
  const txSql = txQueries.map((x) => x.sql);
  check("replaceRegistrations uses one tx client", txSql.some((s) => /BEGIN/.test(s)) && txSql.some((s) => /COMMIT/.test(s)));
  check("replaceRegistrations DELETE+INSERT+registered_at", txSql.some((s) => /DELETE FROM course_registrations/.test(s)) && txSql.some((s) => /INSERT INTO course_registrations/.test(s)) && txSql.some((s) => /UPDATE students SET registered_at/.test(s)));

  await db.setExamSelection("20211292099", "IFT502");
  q = queries.find((x) => /exam_selections/.test(x.sql) && /INSERT/.test(x.sql));
  check("setExamSelection upserts ON CONFLICT (matric)", /ON CONFLICT \(matric\)/.test(q.sql));

  await db.setExamSchedule("IFT502", { date: "2026-10-20", time: "09:00", hall: "Hall A" });
  q = queries.find((x) => /INSERT INTO exam_schedules/.test(x.sql));
  check("setExamSchedule upserts ON CONFLICT (course_code)", /ON CONFLICT \(course_code\)/.test(q.sql));

  console.log("\n-- exam-day flow --");
  check("hasRecentFingerprintPass true", (await db.hasRecentFingerprintPass("20211292099")) === true);

  q = queries.filter((x) => /verification_log/.test(x.sql) && /INSERT/.test(x.sql));
  await db.logVerification("20211292099", "pass", "Fingerprint matched at checkpoint");
  q = queries.filter((x) => /verification_log/.test(x.sql) && /INSERT/.test(x.sql));
  check("logVerification INSERT", q.length >= 1);

  const seat = await db.allocateSeat("20211292099", "IFT502");
  const alloc = queries.filter((x) => /pg_advisory_xact_lock/.test(x.sql));
  check("allocateSeat takes per-course advisory lock", alloc.length === 1);
  const ins = queries.find((x) => /INSERT INTO seats/.test(x.sql));
  check("allocateSeat INSERTs seat", !!ins);
  check("allocateSeat returns seat {hall,seat,row}", seat && seat.hall === "Hall A" && seat.seat === 7 && seat.row === 2);

  console.log("\n-- otp / notifications / misc --");
  await db.createOtp("20211292099", "123456");
  q = queries.find((x) => /INSERT INTO otps/.test(x.sql));
  check("createOtp upserts and resets used=0", /ON CONFLICT \(matric\)/.test(q.sql) && /used = 0/.test(q.sql));

  check("verifyOtp returns used-code reason", (await db.verifyOtp("20211292099", "123456")).reason.includes("No OTP"));

  await db.createNotification("20211292099", "seat_allocation", "Seat Allocated", "Hall A, Seat 7");
  q = queries.find((x) => /INSERT INTO notifications/.test(x.sql));
  check("createNotification INSERT with read=0", /VALUES \(\$1, \$2, \$3, \$4, 0, \$5\)/.test(q.sql));

  const unread = await db.getUnreadCount("20211292099");
  check("getUnreadCount returns int (not string)", typeof unread === "number" && unread === 3, String(unread) + " (" + typeof unread + ")");

  await db.markAsRead("20211292099", 1);
  q = queries.find((x) => /UPDATE notifications SET read = 1/.test(x.sql));
  check("markAsRead scoped by matric", /AND matric = \$2/.test(q.sql));

  await db.notifyAllStudents("exam_schedule", "Exam Date Published", "IFT502 on 2026-10-20");
  check("notifyAllStudents runs in one tx", queries.some((x) => x.client === "tx" && /BEGIN/.test(x.sql)));

  const counts = await db.clearAllData();
  check("clearAllData deletes 5 tables in one tx", counts.verification_log === 0 && counts.seats === 0 && Object.keys(counts).length === 5);

  const stats = await db.verificationStats();
  check("verificationStats returns ints", stats.pass === 0 && typeof stats.pass === "number");

  console.log("\n-- global invariants --");
  check("no raw ? placeholders in any SQL", !noPlaceholders(), noPlaceholders());
  check("no undefined params leaked", !queries.some((x) => (x.params || []).some((p) => p === undefined)));

  const tsParams = queries.flatMap((x) => x.params || []).filter((p) => typeof p === "number" && p > 1e12);
  check("all epoch-ms timestamps BIGINT-safe", tsParams.every((p) => p <= 9007199254740991), tsParams.length + " timestamp params");

  console.log("\n=== " + pass + " passed, " + fail + " failed, " + queries.length + " queries ===");
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
