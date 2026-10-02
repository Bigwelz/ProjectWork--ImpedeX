/* =============================================
   EIPS — Frontend API Client (js/api.js)
   Replaces the old localStorage db.js. Every call
   talks to the Express + SQLite backend over HTTP,
   carrying a JWT in the Authorization header.
   Load this BEFORE js/app.js (and before admin
   page inline scripts).
============================================= */

"use strict";

const TOKEN_KEY = "eips_token";
const ROLE_KEY = "eips_role"; // "student" | "admin"

/* ───────────── Token / session ───────────── */
function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}
function getSessionRole() {
  return localStorage.getItem(ROLE_KEY) || null;
}
function setSessionToken(token, role) {
  localStorage.setItem(TOKEN_KEY, token || "");
  localStorage.setItem(ROLE_KEY, role || "");
}
function clearSession() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(ROLE_KEY);
}
function isLoggedIn(role) {
  return !!getToken() && (!role || getSessionRole() === role);
}

/* ── Core fetch helper ── */
async function apiFetch(path, { method = "GET", body } = {}) {
  const token = getToken();
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: "Bearer " + token } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    throw new Error("Cannot reach the server. Is the backend running? (npm start inside /server)");
  }

  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }

  if (!res.ok) {
    const err = new Error((data && data.error) || "Request failed (" + res.status + ").");
    err.status = res.status;
    throw err;
  }
  return data;
}

/* ── Student auth ── */
async function apiRegister(payload) {
  const data = await apiFetch("/api/auth/register", { method: "POST", body: payload });
  setSessionToken(data.token, "student");
  return data.student;
}
async function apiLogin(matric, password) {
  const data = await apiFetch("/api/auth/login", { method: "POST", body: { matric, password } });
  setSessionToken(data.token, "student");
  return data.student;
}
async function apiAdminLogin(email, password, adminKey) {
  const data = await apiFetch("/api/admin/login", {
    method: "POST",
    body: { email, password, adminKey },
  });
  setSessionToken(data.token, "admin");
  return data.email;
}
async function apiAdminRegister(payload) {
  return apiFetch("/api/admin/register", { method: "POST", body: payload });
}
async function apiForgotRequest(matric, email) {
  return apiFetch("/api/auth/forgot/request", { method: "POST", body: { matric, email } });
}
async function apiForgotVerify(matric, code) {
  return apiFetch("/api/auth/forgot/verify", { method: "POST", body: { matric, code } });
}
async function apiForgotReset(matric, password) {
  return apiFetch("/api/auth/forgot/reset", { method: "POST", body: { matric, password } });
}

/* ── Student data ── */
async function apiMe() {
  const data = await apiFetch("/api/me");
  return data.student;
}
async function apiRegisterCourses(courses, carryOvers) {
  return apiFetch("/api/courses/register", { method: "POST", body: { courses, carryOvers } });
}
async function apiCoursesByLevel(level) {
  return apiFetch("/api/courses/level/" + encodeURIComponent(level));
}
async function apiCarryOverOptions(matric) {
  return apiFetch("/api/courses/carryover-options/" + encodeURIComponent(matric));
}
async function apiSelectExam(courseCode) {
  return apiFetch("/api/courses/select-exam", { method: "POST", body: { courseCode } });
}
async function apiEnrollFace(faceDescriptor, photo) {
  return apiFetch("/api/verify/face-enroll", {
    method: "POST",
    body: { faceDescriptor, photo },
  });
}
async function apiEnrollFingerprint(credentialId) {
  return apiFetch("/api/verify/fingerprint-enroll", {
    method: "POST",
    body: { credentialId },
  });
}
async function apiGetSeat() {
  return apiFetch("/api/seat");
}
async function apiExams() {
  return apiFetch("/api/exams");
}

/* ── Admin ── */
async function apiAdminStats() {
  return apiFetch("/api/admin/stats");
}
async function apiAdminStudents() {
  return apiFetch("/api/admin/students");
}
async function apiAdminStudent(matric) {
  return apiFetch("/api/admin/student/" + encodeURIComponent(matric));
}
async function apiAdminAddStudent(payload) {
  return apiFetch("/api/admin/students", { method: "POST", body: payload });
}
async function apiAdminDeleteStudent(matric) {
  return apiFetch("/api/admin/students/" + encodeURIComponent(matric), { method: "DELETE" });
}
async function apiAdminSchedule(payload) {
  return apiFetch("/api/admin/schedule", { method: "POST", body: payload });
}
async function apiAdminVerify(matric, result, details) {
  return apiFetch("/api/admin/student/" + encodeURIComponent(matric) + "/verify", {
    method: "POST",
    body: { result, details },
  });
}
async function apiAdminApprove(matric, courseCode) {
  return apiFetch("/api/admin/student/" + encodeURIComponent(matric) + "/approve", {
    method: "POST",
    body: { course_code: courseCode },
  });
}
async function apiAdminLog() {
  return apiFetch("/api/admin/log");
}
async function apiAdminSeats() {
  return apiFetch("/api/admin/seats");
}
async function apiAdminSchedules() {
  return apiFetch("/api/admin/schedules");
}
async function apiAdminDeleteSchedule(courseCode) {
  return apiFetch("/api/admin/schedule/" + encodeURIComponent(courseCode), { method: "DELETE" });
}
async function apiAdminClearLog() {
  return apiFetch("/api/admin/log", { method: "DELETE" });
}
async function apiAdminClearAll() {
  return apiFetch("/api/admin/all", { method: "DELETE" });
}
async function apiAdminCourses() {
  return apiFetch("/api/admin/courses");
}
async function apiAdminCoursesByLevel(level) {
  return apiFetch("/api/admin/courses/level/" + encodeURIComponent(level));
}
async function apiAdminAddCourse(payload) {
  return apiFetch("/api/admin/courses", { method: "POST", body: payload });
}
async function apiAdminUpdateCourse(code, payload) {
  return apiFetch("/api/admin/courses/" + encodeURIComponent(code), { method: "PUT", body: payload });
}
async function apiAdminDeleteCourse(code) {
  return apiFetch("/api/admin/courses/" + encodeURIComponent(code), { method: "DELETE" });
}

/* ── Notifications ── */
async function apiGetNotifications() {
  return apiFetch("/api/notifications");
}
async function apiMarkNotifRead(id) {
  return apiFetch("/api/notifications/read/" + id, { method: "POST" });
}
async function apiMarkAllNotifRead() {
  return apiFetch("/api/notifications/read-all", { method: "POST" });
}
async function apiClearNotifications() {
  return apiFetch("/api/notifications", { method: "DELETE" });
}
