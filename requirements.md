# ImpedeX — Software Requirements Specification (SRS)

**Project:** ImpedeX — Electronic Exam Identity & Proctoring System (EIPS)
**Version:** 1.0
**Date:** 14 October 2026
**Stack:** Static HTML/CSS/JS frontend · Node.js/Express API · SQLite · Python ZKTeco bridge

---

## 1. Introduction

### 1.1 Purpose
ImpedeX replaces manual exam-hall identity checks with registered biometrics. Students register once (photo + fingerprint), register their courses per semester, and are verified by fingerprint at the exam-day checkpoint where their photo and seat number are displayed automatically.

### 1.2 Scope
- Student self-service portal (registration, courses, exam selection, seat, notifications).
- Admin portal (course/schedule management, student management, exam-day verification, reports).
- Local fingerprint bridge for ZKTeco USB scanners.
- Cloud hosting on Render; exam-day PC runs the local bridge on the LAN.

### 1.3 Definitions
| Term | Meaning |
|---|---|
| Matric | 11-digit student number (e.g. `20211292002`) — primary key |
| Exam selection | The single course a student picks to write at a given sitting |
| zk template | Fingerprint template `zk:<base64>` captured by the ZKTeco SDK |
| Bridge | `bridge/zkbridge.py` HTTP service on `127.0.0.1:8765` |
| Admin key | Shared secret required in addition to admin password at login |
| Fingerprint pass | `verification_log` entry `result=pass` whose `details` contains `Fingerprint` |

### 1.4 Explicit non-goals
- **Facial recognition / camera verification — removed and out of scope.**
- Real email delivery of OTPs (demo mode returns the code in the API response).
- Payments, timetable clash resolution, offline exam mode.

---

## 2. Overall Description

### 2.1 Actors
| Actor | Description |
|---|---|
| Student | Registers, enrols fingerprint, registers courses, selects exam, views seat |
| Admin | Authenticates with password + admin key; manages data and runs exam-day checkpoint |
| ZKTeco scanner | USB fingerprint device driven by the local bridge via vendor SDK |
| Bridge service | Python HTTP service exposing `/health`, `/capture`, `/match`, `/match-many` |

### 2.2 Assumptions & dependencies
- Exam-day PC has the ZKTeco device attached and Python bridge running; it can reach the Render app over HTTPS.
- Students own a device with a modern browser; no app install required.
- One exam course per student per sitting (`exam_selections.matric` is PK).

### 2.3 Constraints
- Hosted on Render free tier; SQLite on ephemeral disk (data wiped on redeploy — external DB required for production).
- Admin key and JWT secret provided via environment variables (`EIPS_JWT_SECRET`, `EIPS_ENCRYPTION_KEY`).
- Fingerprint templates stored **encrypted at rest**; raw templates never returned to clients.

---

## 3. Functional Requirements

### FR-1 — Student registration
| ID | Requirement |
|---|---|
| FR-1.1 | The system shall accept registration only with an **11-digit matric** (regex `^\d{11}$`). |
| FR-1.2 | Registration shall require first name, last name, and a valid email. |
| FR-1.3 | Passwords shall be at least 8 characters and stored as salted hashes (never plaintext). |
| FR-1.4 | A **clear photo is compulsory** — rejected client-side (toast) and server-side (HTTP 400) if absent; stored as a data URL. |
| FR-1.5 | Step 2 shall capture the student's level and registered courses (compulsory + electives) and store them as `course_registrations` and one `exam_selections` row. |
| FR-1.6 | Advancing past registration step 1 shall be blocked without a photo. |
| FR-1.7 | Duplicate matric shall return HTTP 409. |

### FR-2 — Authentication & account recovery
| ID | Requirement |
|---|---|
| FR-2.1 | Students shall log in with matric + password and receive a JWT. |
| FR-2.2 | Forgot-password shall use a server-generated 6-digit OTP with expiry; **demo mode** returns the OTP in the response until SMTP is configured. |
| FR-2.3 | OTP shall be single-use (`otps.used`) and time-limited. |

### FR-3 — Biometric enrolment
| ID | Requirement |
|---|---|
| FR-3.1 | The system shall support **fingerprint-only** enrolment (facial recognition removed). |
| FR-3.2 | Enrolment shall capture via the local bridge (`/capture`) and store the template **encrypted** on `students.fingerprint_credential_id` prefixed `zk:`. |
| FR-3.3 | A WebAuthn/platform authenticor credential id is an accepted alternative when no scanner is present. |
| FR-3.4 | The enrolment page shall guide the student through a 3-step progress (health check → capture → save). |

### FR-4 — Course & exam management (student)
| ID | Requirement |
|---|---|
| FR-4.1 | Students shall register courses per level (100–500) from the server catalogue. |
| FR-4.2 | Students shall select exactly one exam course per sitting (`select-exam`). |
| FR-4.3 | Carry-over options shall be offered to eligible students. |

### FR-5 — Admin authentication & authorisation
| ID | Requirement |
|---|---|
| FR-5.1 | Admin login shall require email + password + **admin key** in a single request. |
| FR-5.2 | Successful login shall set an HttpOnly `eips_admin_portal` cookie (SameSite=Lax, 4-hour TTL). |
| FR-5.3 | Failed logins shall be rate-limited (5 attempts / 15 minutes). |
| FR-5.4 | A 401 on any admin API with a token shall clear the session and redirect to login. |
| FR-5.5 | The landing page shall reveal the Admin Portal entry only when the portal cookie was recently used on this browser (`/api/session/portal`). |

### FR-6 — Admin data management
| ID | Requirement |
|---|---|
| FR-6.1 | Admins shall create/edit/delete courses (code, title, unit, type, level). |
| FR-6.2 | Admins shall set exam schedules (date, time, hall) per course. |
| FR-6.3 | Admins shall list/search students, view a student record, and delete a student (cascades registrations, seats, selections). |
| FR-6.4 | Admins shall manage carry-overs. |
| FR-6.5 | Admins shall view stats, the verification log, seats, and schedules (reports page). |

### FR-7 — Exam-day verification (critical)
| ID | Requirement |
|---|---|
| FR-7.1 | The verify page shall be a **wizard**: Step 1 select level (100–500) → Step 2 select course → Step 3 fingerprint scan (**auto-starts** on course pick). |
| FR-7.2 | Manual matric lookup shall **not** exist — identity comes only from the fingerprint. |
| FR-7.3 | The scan shall query a **course-scoped** fingerprint index (`/api/admin/fingerprints`) so only registered students can match. |
| FR-7.4 | The bridge `/match-many` shall **skip invalid/base64-corrupt templates** and return the best match mapped to the caller's original template list; it shall error only when zero templates are valid. |
| FR-7.5 | On match, the system shall check that the student's `exam_selections.course_code` equals the selected course; otherwise show a **warning modal and log no fingerprint pass**. |
| FR-7.6 | For a registered student the system shall write a `verification_log` Fingerprint PASS, then **auto-approve** (idempotent seat allocation) and show a **result modal** with photo, name, matric, course, and seat number. |
| FR-7.7 | Stale scans shall be neutralised by a flow token: any wizard navigation invalidates in-flight scans (no clobbering of the UI). |
| FR-7.8 | Approval shall be refused unless a recent Fingerprint PASS exists for that student and an exam schedule exists for the course. |
| FR-7.9 | The wizard shall offer "Scan Next" (reset to level step) and "Close" from the result modal. |
| FR-7.10 | Deep links `?matric=` shall auto-advance: fetch student → pick level → pick their exam course if cached. |

### FR-8 — Notifications
| ID | Requirement |
|---|---|
| FR-8.1 | The system shall notify students of biometric enrolment and approval (seat allocated). |
| FR-8.2 | Students shall list, mark-read (single/all), and clear notifications; unread count shall be shown. |

### FR-9 — Seat allocation
| ID | Requirement |
|---|---|
| FR-9.1 | Seats shall be allocated per (matric, course) uniquely and **idempotently** — re-approval returns the existing seat. |
| FR-9.2 | Seat records shall store hall, seat number, row number, and allocation time. |

---

## 4. Non-Functional Requirements

### NFR-1 — Security
| ID | Requirement |
|---|---|
| NFR-1.1 | Passwords: salted hash (scrypt/HMAC), never stored or logged in plaintext. |
| NFR-1.2 | Fingerprint templates encrypted at rest with `EIPS_ENCRYPTION_KEY`; the admin fingerprint index exposes **only** `zk:`-prefixed identifiers, never raw templates. |
| NFR-1.3 | JWT for students; HttpOnly cookie for admin portal; no tokens in URLs. |
| NFR-1.4 | Security headers: strict CSP with `camera=(), microphone=()` (no browser camera use), plus Permissions-Policy camera/mic denied. |
| NFR-1.5 | Rate limiting on admin login (5/15 min). |
| NFR-1.6 | All secrets overridable by environment variables; hardcoded values are dev fallbacks only. |

### NFR-2 — Reliability
| ID | Requirement |
|---|---|
| NFR-2.1 | Seat allocation and approval must be idempotent (safe to re-run on retry). |
| NFR-2.2 | Bridge must never fail the whole scan because of one corrupt template (FR-7.4). |
| NFR-2.3 | Schema migrations must run automatically on startup (e.g. drop legacy `face_descriptor`). |

### NFR-3 — Performance
| ID | Requirement |
|---|---|
| NFR-3.1 | Page loads ≤ 3 s on a campus LAN; scan round-trip (capture + match) ≤ 2 s typical. |
| NFR-3.2 | Bridge scan abort/timeout budget ≈ 65 s worst case (finger never placed). |

### NFR-4 — Usability
| ID | Requirement |
|---|---|
| NFR-4.1 | Exam-day flow requires ≤ 3 admin actions per student (level, course, finger). |
| NFR-4.2 | All validation errors shown as inline toasts in plain language. |
| NFR-4.3 | Consistent theme (Slate & Dark Sapphire, primary `#0f52ba`) across all pages. |

### NFR-5 — Compatibility & deployment
| ID | Requirement |
|---|---|
| NFR-5.1 | Modern evergreen browsers (Chrome/Edge/Firefox). |
| NFR-5.2 | Deployable to Render with Root Directory `server`, start command `npm start` (combined mode via `both.js`). |
| NFR-5.3 | Exam PC must set `ZKBRIDGE_ORIGINS=https://<app>.onrender.com`. |
| NFR-5.4 | SQLite acceptable for demo; production shall use persistent storage/external DB. |

---

## 5. External Interfaces

### 5.1 Bridge API (`http://127.0.0.1:8765`)
| Endpoint | Method | Purpose |
|---|---|---|
| `/health` | GET | Device/service readiness |
| `/capture` | POST | Capture one fingerprint → `zk:<base64>` |
| `/match` | POST | Capture + match against a single template |
| `/match-many` | POST | Capture + match against many templates; returns `bestIndex`, `score`, `compared` (valid templates only) |

### 5.2 REST API (student :4000 / admin :4001)
| Group | Endpoints |
|---|---|
| Student auth | `POST /api/auth/register`, `/login`, `/forgot/request`, `/forgot/verify`, `/forgot/reset` |
| Student data | `GET /api/me`, `/api/courses`, `/api/courses/level/:level`, `/api/exams`, `/api/seat`, `/api/notifications*` |
| Student actions | `POST /api/courses/register`, `/api/courses/select-exam`, `/api/verify/fingerprint-enroll` |
| Admin auth | `POST /api/admin/login`, `/logout`, `/register` |
| Admin manage | `/api/admin/students*`, `/api/admin/courses*`, `/api/admin/schedule*`, `/api/admin/fingerprints`, `/api/admin/seats`, `/api/admin/log`, `/api/admin/stats` |
| Exam-day | `POST /api/admin/student/:matric/verify` (fp pass), `POST /api/admin/student/:matric/approve` (seat) |

### 5.3 Future: email (mailer)
SMTP/SendGrid integration point exists in `server/mailer.js`; until configured, OTP remains demo-mode.

---

## 6. Data Requirements
Tables: `students`, `course_catalog`, `course_registrations`, `exam_selections`, `exam_schedules`, `seats`, `verification_log`, `carry_overs`, `admin_accounts`, `otps`, `notifications` — see ER diagram in `uml-diagrams.md` §4. Retention: verification log purgeable by admin; student deletion cascades.

---

## 7. Acceptance Criteria (key scenarios)
1. Registration without photo → blocked at step 1 and by server 400.
2. Register → login → dashboard shows fingerprint status and seat when approved.
3. Admin login with wrong key → rejected; correct key → portal cookie set.
4. Exam-day: level → course → fingerprint on a registered student → modal shows photo/name/matric/course/seat; `verification_log` has Fingerprint PASS; re-approve returns the **same** seat.
5. Exam-day scan of a student **not** registered for the selected course → warning modal, **no** fp-pass row, no seat.
6. Corrupt template in the index → scan still succeeds for other valid templates (bridge skips bad rows).
7. `verify.html` (old facial page) returns 404; CSP denies camera.

---

## 8. Revision history
| Version | Date | Change |
|---|---|---|
| 1.0 | 2026-10-14 | Initial SRS after facial-recognition removal; exam-day wizard + photo-compulsion requirements captured |
