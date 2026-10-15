# ImpedeX (EIPS) — UML Diagrams

Mermaid UML for the **Electronic Exam Identity & Proctoring System (ImpedeX)**.
View on GitHub/GitLab or any Mermaid-enabled editor.

---

## 1. Use Case Diagram

```mermaid
flowchart LR
    S(("Student"))
    A(("Admin"))
    D(("ZKTeco<br/>Scanner"))

    subgraph SYS["ImpedeX System"]
        UC1["Register account<br/>(photo + fingerprint)"]
        UC2["Login / Logout"]
        UC3["Forgot password (OTP)"]
        UC4["Register courses"]
        UC5["Select exam course"]
        UC6["View seat / schedule"]
        UC7["View notifications"]
        UC8["Admin login<br/>(password + admin key)"]
        UC9["Manage courses & schedules"]
        UC10["Manage students"]
        UC11["Run exam-day verification<br/>(Level → Course → Fingerprint)"]
        UC12["Approve student & allocate seat"]
        UC13["View reports & logs"]
        UC14["Capture / match fingerprint"]
    end

    S --> UC1 & UC2 & UC3 & UC4 & UC5 & UC6 & UC7
    A --> UC8 & UC9 & UC10 & UC11 & UC12 & UC13
    D --> UC14
    UC1 --> UC14
    UC11 --> UC14
```

---

## 2. Component / Architecture Diagram

```mermaid
flowchart TB
    subgraph BROWSER["Browser (Frontend)"]
        direction LR
        PAGES["Static pages<br/>index, register, login,<br/>dashboard, admin-*.html"]
        APPJS["js/app.js<br/>UI logic, wizard, validation"]
        APIJS["js/api.js<br/>fetch wrapper, JWT"]
        BIOM["js/biometrics.js<br/>fingerprint bridge client"]
        PAGES --- APPJS --- APIJS --- BIOM
    end

    subgraph CLOUD["Render Cloud"]
        direction TB
        subgraph NODE["Node.js (server/)"]
            BOTH["both.js — combined entry (npm start)"]
            IDX["index.js :4000<br/>student API"]
            ADM["admin-server.js :4001<br/>admin API"]
            APIR["api.js — all routes"]
            DBM["db.js — SQLite access + migrations"]
            MAIL["mailer.js"]
            BOTH --> IDX & ADM
            IDX & ADM --> APIR --> DBM
            APIR -.-> MAIL
        end
        SQLITE[("PostgreSQL")]
        DBM --> SQLITE
    end

    subgraph EXAMPCH["Exam-day PC (local LAN)"]
        BR["bridge/zkbridge.py :8765<br/>/health /capture /match /match-many"]
        ZK["ZKTeco USB scanner<br/>(vendor SDK)"]
        BR --- ZK
    end

    BIOM -->|"HTTP local<br/>ZKBRIDGE_ORIGINS"| BR
    BIOM -->|"HTTPS<br/>REST + JWT"| APIR
    APPJS --> APIR
```

---

## 3. Class Diagram (Domain Model)

```mermaid
classDiagram
    class Student {
        +string matric PK
        +string firstName
        +string lastName
        +string email
        +string department
        +string faculty
        +string level
        +string session
        +string passwordSalt
        +string passwordHash
        +string photo "compulsory data URL"
        +string fingerprintCredentialId "zk or webauthn"
        +int createdAt
        +int registeredAt
        +enrollFingerprint(template)
        +registerCourses(codes)
    }

    class Course {
        +string code PK
        +string title
        +int unit
        +string type "compulsory|elective"
        +int level
    }

    class CourseRegistration {
        +int id PK
        +string matric FK
        +string courseCode FK
        +string type
        +int registeredAt
    }

    class ExamSelection {
        +string matric PK,FK
        +string courseCode FK
        +int selectedAt
    }

    class ExamSchedule {
        +string courseCode PK,FK
        +string date
        +string time
        +string hall
        +int updatedAt
    }

    class Seat {
        +int id PK
        +string matric FK
        +string courseCode FK
        +string hall
        +int seatNumber
        +int rowNumber
        +int allocatedAt
    }

    class VerificationLog {
        +int id PK
        +string matric
        +string result "pass/fail/attendance"
        +string details
        +int time
    }

    class CarryOver {
        +int id PK
        +string matric FK
        +string courseCode FK
        +int addedAt
    }

    class AdminAccount {
        +string email PK
        +string firstName
        +string lastName
        +string salt
        +string hash
        +string accessSalt "admin key"
        +string accessHash
    }

    class Notification {
        +int id PK
        +string matric
        +string type
        +string title
        +string message
        +boolean read
        +int createdAt
    }

    class Otp {
        +string matric PK
        +string salt
        +string hash
        +int expiresAt
        +boolean used
    }

    class ZKBridge {
        +int port
        +health()
        +capture() Capture
        +match(Capture) Match
        +matchMany(templates) BestMatch
    }

    Student "1" --> "0..*" CourseRegistration : registers
    Student "1" --> "0..1" ExamSelection : selects
    Student "1" --> "0..*" Seat : allocated
    Student "1" --> "0..*" VerificationLog : attempts
    Student "1" --> "0..*" CarryOver : owes
    Student "1" --> "0..*" Notification : receives
    Course "1" --> "0..*" CourseRegistration : in
    Course "1" --> "0..1" ExamSchedule : scheduled
    Course "1" --> "0..*" Seat : hall map
    Student ..> ZKBridge : fingerprint enroll / verify
    AdminAccount ..> Student : manages / approves
```

---

## 4. Entity–Relationship Diagram (SQLite schema)

```mermaid
erDiagram
    students ||--o{ course_registrations : "registers"
    students ||--o| exam_selections : "picks one exam course"
    students ||--o{ seats : "holds seat per course"
    students ||--o{ verification_log : "scan attempts"
    students ||--o{ carry_overs : "owes"
    students ||--o{ notifications : "receives"
    course_catalog ||--o{ course_registrations : "offered as"
    course_catalog ||--o| exam_schedules : "scheduled"
    course_catalog ||--o{ exam_selections : "chosen for"
    course_catalog ||--o{ seats : "seated in"

    students {
        TEXT matric PK
        TEXT first_name
        TEXT last_name
        TEXT email
        TEXT phone
        TEXT department
        TEXT faculty
        TEXT level
        TEXT session
        TEXT password_salt
        TEXT password_hash
        TEXT photo "data URL, compulsory"
        TEXT fingerprint_credential_id "zk:.. or webauthn, encrypted"
        INTEGER created_at
        INTEGER registered_at
    }
    course_catalog {
        TEXT code PK
        TEXT title
        INTEGER unit
        TEXT type "compulsory|elective"
        INTEGER level
    }
    course_registrations {
        INTEGER id PK
        TEXT matric FK
        TEXT course_code FK
        TEXT type
        INTEGER registered_at
    }
    exam_selections {
        TEXT matric PK, FK
        TEXT course_code FK
        INTEGER selected_at
    }
    exam_schedules {
        TEXT course_code PK,FK
        TEXT date
        TEXT time
        TEXT hall
        INTEGER updated_at
    }
    seats {
        INTEGER id PK
        TEXT matric FK
        TEXT course_code FK
        TEXT hall
        INTEGER seat_number
        INTEGER row_number
        INTEGER allocated_at
    }
    verification_log {
        INTEGER id PK
        TEXT matric
        TEXT result "pass|fail|attendance"
        TEXT details
        INTEGER time
    }
    carry_overs {
        INTEGER id PK
        TEXT matric FK
        TEXT course_code FK
        INTEGER added_at
    }
    admin_accounts {
        TEXT email PK
        TEXT first_name
        TEXT last_name
        TEXT salt
        TEXT hash
        TEXT access_salt "admin key hash"
        TEXT access_hash
    }
    otps {
        TEXT matric PK
        TEXT salt
        TEXT hash
        INTEGER expires_at
        INTEGER used
    }
    notifications {
        INTEGER id PK
        TEXT matric
        TEXT type
        TEXT title
        TEXT message
        INTEGER read
        INTEGER created_at
    }
```

---

## 5. Sequence Diagram — Student Registration & Biometric Enrolment

```mermaid
sequenceDiagram
    autonumber
    actor S as Student
    participant R as register.html<br/>+ app.js
    participant API as API :4000<br/>POST /api/auth/register
    participant DB as SQLite (eips.db)
    participant B as biometric-collection.html
    participant BR as zkbridge.py :8765
    participant ZK as ZKTeco scanner

    S->>R: Fill details + upload photo
    R->>R: Validate matric (11 digits)<br/>+ photo present
    R->>API: POST /auth/register {photo data URL, ...}
    API->>API: Reject if photo missing (400)
    API->>DB: createStudent (salted hash, photo)
    DB-->>API: OK
    API-->>R: 201 {token, student}
    R->>B: Redirect + token

    S->>B: Place finger, tap "Capture"
    B->>BR: GET /health
    BR-->>B: 200 ok
    B->>BR: POST /capture
    BR->>ZK: SDK Capture
    ZK-->>BR: template bytes
    BR-->>B: zk:base64 template
    B->>API: POST /api/verify/fingerprint-enroll<br/>Authorization: Bearer token
    API->>API: Encrypt template (EIPS_ENCRYPTION_KEY)
    API->>DB: UPDATE students SET fingerprint_credential_id
    DB-->>API: OK
    API-->>B: {ok:true, enrolled:true}
    B-->>S: "Biometric enrolment complete" → dashboard
```

---

## 6. Sequence Diagram — Exam-Day Verification (critical path)

```mermaid
sequenceDiagram
    autonumber
    actor A as Admin
    participant AV as admin-verify.html
    participant API as API :4001<br/>admin routes
    participant DB as SQLite
    participant BR as zkbridge.py :8765
    participant ZK as ZKTeco scanner

    A->>AV: Login (email + password + admin key)
    AV->>API: POST /api/admin/login
    API-->>AV: portal cookie (4h) + token
    A->>AV: Step 1: pick Level (100–500)
    AV->>API: GET /api/admin/courses/level/:level
    API-->>AV: course list
    A->>AV: Step 2: pick Course
    AV->>API: GET /api/admin/fingerprints?course=CODE
    API-->>AV: zk-only template index (course-scoped)
    AV->>AV: Step 3: start scan (flow-token guard)
    AV->>BR: GET /health
    AV->>BR: POST /match-many {templates}
    BR->>ZK: SDK Capture + match
    ZK-->>BR: best score/index
    BR->>BR: Skip invalid base64 templates<br/>map bestIndex → original list
    BR-->>AV: {bestIndex, score, compared}

    alt No match
        AV-->>A: Error modal + "Scan Again"
    else Match found
        AV->>API: GET /api/admin/student/:matric
        API-->>AV: student (photo, examSelection)
        AV->>AV: examSelection == selected course?
        alt Not registered for course
            AV-->>A: WARN modal — no fp pass logged, no approval
        else Registered
            AV->>API: POST /api/admin/student/:matric/verify
            API->>DB: INSERT verification_log (result=pass, details contains Fingerprint)
            API-->>AV: {ok}
            AV->>API: POST /api/admin/student/:matric/approve?course_code=...
            API->>API: Require recent fp pass + exam schedule
            API->>DB: allocateSeat (idempotent)
            DB-->>AV: seat_number, row, hall
            API-->>AV: {seat}
            AV-->>A: Modal: photo, name, matric, course, seat no.
        end
    end

    A->>AV: "Scan Next" → next student
```

---

## 7. State Diagram — Student Lifecycle

```mermaid
stateDiagram-v2
    [*] --> Unregistered
    Unregistered --> Registered : Submit step 1–2<br/>(details + photo + courses)
    Registered --> BiometricPending : Login success
    BiometricPending --> BiometricEnrolled : Fingerprint captured<br/>+ encrypted at rest
    BiometricEnrolled --> ExamReady : Exam selection saved
    ExamReady --> Verified : Exam-day scan pass<br/>(verification_log = Fingerprint PASS)
    ExamReady --> Unverified : Scan fail / not registered
    Unverified --> ExamReady : Re-scan
    Verified --> SeatAllocated : Auto-approve<br/>(idempotent allocateSeat)
    SeatAllocated --> ExamComplete : Attendance recorded
    ExamComplete --> [*]
    BiometricPending --> [*] : Logout
```

---

## 8. Activity Diagram — Exam-Day Wizard Flow

```mermaid
flowchart TD
    START([Admin opens admin-verify.html]) --> LOGIN{Portal cookie valid?}
    LOGIN -->|No| RELOGIN[Redirect to admin-login.html]
    LOGIN -->|Yes| LVL[Select Level 100 / 200 / 300 / 400 / 500]
    LVL --> CRSE[Course list for level loads]
    CRSE --> PICK[Select course]
    PICK --> TPL[Fetch course-scoped fingerprint index]
    TPL --> SCAN[Auto-start fingerprint scan<br/>flow-token guard active]
    SCAN --> BRIDGE[bridge /match-many<br/>invalid templates skipped]
    BRIDGE --> Q1{Match found?}
    Q1 -->|No| ERR[Error modal + retry button]
    ERR --> SCAN
    Q1 -->|Yes| Q2{Registered for course<br/>and examSelection matches?}
    Q2 -->|No| WARN[WARN modal — rejected,<br/>no fp pass logged]
    WARN --> LVL
    Q2 -->|Yes| LOG[Log Fingerprint PASS<br/>to verification_log]
    LOG --> APRV{Schedule exists?}
    APRV -->|No| SCHED[Error modal — contact admin]
    APRV -->|Yes| SEAT[allocateSeat idempotent]
    SEAT --> MODAL[Result modal: photo, name,<br/>matric, course, seat no.]
    MODAL -->|Scan Next| LVL
    MODAL -->|Close| END([End])
```

---

## 9. Deployment Diagram

```mermaid
flowchart LR
    subgraph CLOUD["Render (cloud)"]
        direction TB
        WEB["Web service<br/>Root dir: server<br/>Start: npm start (both.js)<br/>Port: process.env.PORT"]
        PGSVC["Managed PostgreSQL<br/>DATABASE_URL"]
        ENV["Env vars<br/>EIPS_JWT_SECRET<br/>EIPS_ENCRYPTION_KEY<br/>DATABASE_URL"]
        WEB --- ENV
        WEB --- PGSVC
    end

    subgraph EXAMPC["Exam-day PC (campus LAN)"]
        PY["Python 3<br/>zkbridge.py :8765"]
        USB["ZKTeco USB scanner"]
        PY --- USB
    end

    subgraph CLIENTS["Clients"]
        STU["Student browsers<br/>(HTTPS)"]
        ADMPC["Admin browser on exam PC<br/>(HTTPS to Render + HTTP to localhost:8765)"]
    end

    STU -->|HTTPS REST| WEB
    ADMPC -->|HTTPS REST| WEB
    ADMPC -->|localhost:8765<br/>ZKBRIDGE_ORIGINS=https://your-app.onrender.com| PY
    PGSVC -. note .-> PGLOCAL["Local dev: scripts/pg-local.cjs<br/>starts embedded PostgreSQL on :5432<br/>(database eips) — the sandboxed dev shell<br/>cannot run it (stripped SeCreateGlobalPrivilege);<br/>run it from a normal terminal"]
```

---

*Generated for ImpedeX v1 — facial recognition intentionally out of scope (removed); fingerprint-only biometrics.*
