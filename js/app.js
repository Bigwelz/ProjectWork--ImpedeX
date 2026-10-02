/* =============================================
   EIPS — Global JavaScript (js/app.js)
   Exam Impersonation Prevention System.
   Requires js/api.js to be loaded BEFORE this file,
   plus js/biometrics.js on pages using the
   camera / fingerprint sensor.
============================================= */

"use strict";

/* ─────────────────────────────────────────
   INSECURE CONTEXT WARNING
   Camera (getUserMedia) and WebAuthn fingerprint
   sensors only work over https:// or http://localhost.
   Serve this site through the backend (node server/index.js)
   at http://localhost:4000 — never file://
───────────────────────────────────────── */
(function warnIfInsecureContext() {
  if (window.isSecureContext) return;
  const bar = document.createElement("div");
  bar.id = "eips-insecure-banner";
  bar.innerHTML =
    '<i class="fas fa-triangle-exclamation"></i> This page was opened as a local file. Serve the site through the backend — run <code>npm start</code> inside the <code>server</code> folder and open <code>http://localhost:4000</code>.';
  Object.assign(bar.style, {
    position: "fixed",
    top: "0",
    left: "0",
    right: "0",
    zIndex: "999999",
    background: "#7a1f1f",
    color: "#fff",
    fontSize: "1.3rem",
    padding: "1rem 1.6rem",
    textAlign: "center",
    fontFamily: "system-ui, sans-serif",
  });
  document.addEventListener("DOMContentLoaded", () => {
    document.body.prepend(bar);
    document.body.style.paddingTop = "3.6rem";
  });
})();

/* ─────────────────────────────────────────
   DARK MODE — theme toggle
   Applies a persisted theme, then injects a
   sun/moon button into the navbar (student pages)
   or the topbar (admin pages).
───────────────────────────────────────── */
(function initThemeToggle() {
  const KEY = "eipsis_theme";

  function apply(t) {
    document.documentElement.setAttribute("data-theme", t);
    try {
      localStorage.setItem(KEY, t);
    } catch (_) {}
  }

  let theme = (function () {
    try {
      const saved = localStorage.getItem(KEY);
      if (saved === "light" || saved === "dark") return saved;
    } catch (_) {}
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
})();
  apply(theme);

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "theme-switch";
  btn.title = "Toggle dark mode";
  btn.setAttribute("role", "switch");
  btn.setAttribute("aria-label", "Toggle dark mode");
  btn.innerHTML = '<span class="switch-track"><span class="switch-thumb"></span><span class="switch-moon"><i class="fas fa-moon"></i></span></span>';

  function syncSwitchState() {
    const isDark = theme === "dark";
    btn.setAttribute("aria-checked", isDark);
    btn.classList.toggle("on", isDark);
  }
  syncSwitchState();

  btn.addEventListener("click", () => {
    theme = theme === "dark" ? "light" : "dark";
    apply(theme);
    syncSwitchState();
  });

  // Place the switch immediately AFTER the "Get Started" button on pages
  // that have one (landing + student pages), and after the Back link on
  // pages that don't (login / forgot-password).
  const container = document.querySelector(".lp-nav-actions") || document.querySelector(".topnav-right");
  if (container) {
    btn.classList.add("lp-theme-switch");
    const getStarted = container.querySelector('a[href="register.html"]');
    const back = container.querySelector(".topnav-back") || container.querySelector(".nav-back");
    if (getStarted) getStarted.insertAdjacentElement("afterend", btn);
    else if (back) back.insertAdjacentElement("afterend", btn);
    else container.appendChild(btn);
    return;
  }

  const navLinks = document.querySelector("ul.nav-links") || document.querySelector("ul.topnav-links");

  if (navLinks) {
    const li = document.createElement("li");
    li.className = "nav-theme-item";
    li.appendChild(btn);
    const getStarted = navLinks.querySelector('a[href="register.html"]');
    if (getStarted) getStarted.closest("li").insertAdjacentElement("afterend", li);
    else navLinks.appendChild(li);
    return;
  }

  document.body.appendChild(btn);
})();

/* ─────────────────────────────────────────
   SESSION HELPERS (backed by the API)
───────────────────────────────────────── */
async function requireLogin(redirectTo = "login.html") {
  if (!isLoggedIn("student")) {
    window.location.href = redirectTo;
    return null;
  }
  try {
    return await apiMe();
  } catch (err) {
    if (err.status === 401) {
      clearSession();
      window.location.href = redirectTo;
      return null;
    }
    showToast(err.message, "danger");
    return null;
  }
}

function requireAdmin(redirectTo = "admin-login.html") {
  if (!isLoggedIn("admin")) window.location.href = redirectTo;
}

function logout() {
  clearSession();
  window.location.href = "login.html";
}

/* ─────────────────────────────────────────
   ANIMATED AUTH — Login / Register slider
───────────────────────────────────────── */
(function initAuthSlider() {
  const card = document.querySelector(".auth-card-animated");
  if (!card) return;
  const tabLogin = document.getElementById("tabLogin");
  const tabRegister = document.getElementById("tabRegister");
  const footerSwitch = document.getElementById("authFooterSwitch");

  function setMode(isRegister) {
    card.classList.toggle("show-register", isRegister);
    if (tabLogin) tabLogin.classList.toggle("active", !isRegister);
    if (tabRegister) tabRegister.classList.toggle("active", isRegister);
    if (footerSwitch) {
      footerSwitch.innerHTML = isRegister
        ? 'Already have an account? <a href="#" id="switchToLogin">Login here</a>'
        : 'Don\'t have an account? <a href="#" id="switchToRegister">Register here</a>';
      const a = footerSwitch.querySelector("a");
      if (a) a.addEventListener("click", (e) => {
        e.preventDefault();
        setMode(!isRegister);
      });
    }
  }

  if (tabLogin) tabLogin.addEventListener("click", () => setMode(false));
  if (tabRegister) tabRegister.addEventListener("click", () => setMode(true));

  try {
    const mode = new URLSearchParams(window.location.search).get("mode");
    setMode(mode === "register");
  } catch (_) {
    setMode(false);
  }
})();

/* ─────────────────────────────────────────
   1. NAVBAR — Hamburger Toggle
───────────────────────────────────────── */
const hamburger = document.getElementById("hamburger");
const navLinks = document.querySelector(".nav-links");
if (hamburger && navLinks) {
  hamburger.addEventListener("click", () => navLinks.classList.toggle("open"));
}
const topnavLinks = document.querySelector(".topnav-links");
if (hamburger && topnavLinks) {
  hamburger.addEventListener("click", () => topnavLinks.classList.toggle("open"));
}
const lpHamburger = document.getElementById("lpHamburger");
const lpNavLinks = document.querySelector(".lp-nav-links");
if (lpHamburger && lpNavLinks) {
  lpHamburger.addEventListener("click", () => lpNavLinks.classList.toggle("open"));
}

/* ─────────────────────────────────────────
   Hero navbar — hides on scroll down, returns on scroll up
───────────────────────────────────────── */
(function heroNavHideOnScroll() {
  const nav = document.querySelector(".navbar-hero");
  if (!nav) return;
  let lastY = window.scrollY;
  let ticking = false;
  window.addEventListener(
    "scroll",
    () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        ticking = false;
        const y = window.scrollY;
        if (y > lastY + 6 && y > 2 && !nav.classList.contains("nav-hidden")) {
          nav.classList.add("nav-hidden");
        } else if (y <= 2 && nav.classList.contains("nav-hidden")) {
          nav.classList.remove("nav-hidden");
        }
        lastY = y;
      });
    },
    { passive: true }
  );
})();

/* ─────────────────────────────────────────
   Exam rules gallery — 3D rotating box carousel
───────────────────────────────────────── */
(function initRuleCarousel() {
  const box = document.querySelector(".carousel-3d");
  if (!box) return;
  const faces = box.children;
  const total = faces.length;
  if (total < 2) return;

  const placeFaces = () => {
    const w = box.clientWidth;
    const radius = w / 2 / Math.tan(Math.PI / total);
    Array.from(faces).forEach((face, i) => {
      face.style.transform = `rotateY(${i * (360 / total)}deg) translateZ(${radius}px)`;
    });
  };

  placeFaces();
  window.addEventListener("resize", placeFaces);

  let index = 0;
  const dotsWrap = document.querySelector(".carousel-dots");
  Array.from(faces).forEach((_, i) => {
    const dot = document.createElement("button");
    dot.type = "button";
    dot.setAttribute("aria-label", `Slide ${i + 1}`);
    dot.addEventListener("click", () => goTo(i));
    dotsWrap.appendChild(dot);
  });
  const dots = dotsWrap.children;

  const show = () => {
    box.style.transform = `rotateY(-${index * (360 / total)}deg)`;
    Array.from(dots).forEach((d, i) => d.classList.toggle("active", i === index));
  };

  const goTo = (i) => {
    index = (i + total) % total;
    show();
  };

  let timer = setInterval(() => goTo(index + 1), 4000);
  const parent = box.parentElement;
  parent.addEventListener("mouseenter", () => clearInterval(timer));
  parent.addEventListener("mouseleave", () => {
    timer = setInterval(() => goTo(index + 1), 4000);
  });
  show();
})();

/* ─────────────────────────────────────────
   2. ADMIN SIDEBAR — Toggle Collapse
───────────────────────────────────────── */
function toggleSidebar() {
  const sidebar = document.getElementById("sidebar");
  const adminMain = document.getElementById("adminMain");
  if (!sidebar) return;
  sidebar.classList.toggle("open");
  sidebar.classList.toggle("collapsed");
  if (adminMain) adminMain.classList.toggle("expanded");
}

function setAdminSession(loggedIn) {
  if (!loggedIn) {
    clearSession();
    window.location.href = "admin-login.html";
  }
}

function adminSessionGuard() {
  if (!isLoggedIn("admin")) {
    window.location.href = "admin-login.html";
    return false;
  }
  return true;
}

/* ─────────────────────────────────────────
   3. PASSWORD VISIBILITY TOGGLE
───────────────────────────────────────── */
function toggleEye(inputId, iconEl) {
  const input = document.getElementById(inputId);
  if (!input) return;
  if (input.type === "password") {
    input.type = "text";
    iconEl.classList.replace("fa-eye", "fa-eye-slash");
  } else {
    input.type = "password";
    iconEl.classList.replace("fa-eye-slash", "fa-eye");
  }
}

/* ─────────────────────────────────────────
   4. REGISTRATION — Multi-Step Form
───────────────────────────────────────── */
function nextStep(current) {
  const currentStep = document.getElementById(`formStep${current}`);
  const nextStepEl = document.getElementById(`formStep${current + 1}`);
  const currentInd = document.getElementById(`step-ind-${current}`);
  const nextInd = document.getElementById(`step-ind-${current + 1}`);

  if (!currentStep || !nextStepEl) return;

  const inputs = currentStep.querySelectorAll("input[required], select[required]");
  let valid = true;
  inputs.forEach((inp) => {
    inp.style.borderColor = "";
    if (!inp.value.trim()) {
      inp.style.borderColor = "var(--danger)";
      inp.focus();
      valid = false;
    }
  });

  if (valid && current === 1) {
    const matricEl = document.getElementById("regMatric");
    if (matricEl && !isValidMatric(matricEl.value)) {
      showToast("Matric number must be exactly 11 digits, e.g. 20211292002.", "danger");
      matricEl.style.borderColor = "var(--danger)";
      valid = false;
    }
  }
  if (valid && current === 2) {
    const pass = document.getElementById("regPass");
    const pass2 = document.getElementById("regPass2");
    if (pass && pass.value.length < 8) {
      showToast("Password must be at least 8 characters long.", "danger");
      pass.style.borderColor = "var(--danger)";
      valid = false;
    } else if (pass && pass2 && pass.value !== pass2.value) {
      showToast("Passwords do not match.", "danger");
      pass2.style.borderColor = "var(--danger)";
      valid = false;
    }
  }

  if (!valid) {
    if (current !== 1) showToast("Please fill in all required fields.", "danger");
    return;
  }

  currentStep.classList.add("hidden");
  nextStepEl.classList.remove("hidden");

  if (currentInd) {
    currentInd.classList.remove("active");
    currentInd.classList.add("done");
    const circle = currentInd.querySelector(".rv-circle");
    if (circle) circle.innerHTML = '<i class="fas fa-check"></i>';
  }
  if (nextInd) nextInd.classList.add("active");

  if (current + 1 === 3) populateConfirmStep();
}

function prevStep(current) {
  const currentStep = document.getElementById(`formStep${current}`);
  const prevStepEl = document.getElementById(`formStep${current - 1}`);
  const currentInd = document.getElementById(`step-ind-${current}`);
  const prevInd = document.getElementById(`step-ind-${current - 1}`);

  if (!currentStep || !prevStepEl) return;

  currentStep.classList.add("hidden");
  prevStepEl.classList.remove("hidden");

  if (currentInd) currentInd.classList.remove("active");
  if (prevInd) {
    prevInd.classList.remove("done");
    prevInd.classList.add("active");
    const circle = prevInd.querySelector(".rv-circle");
    if (circle) circle.textContent = current - 1;
  }
}

function populateConfirmStep() {
  const grid = document.getElementById("regConfirmGrid");
  if (!grid) return;
  const v = (id) => { const el = document.getElementById(id); return el ? el.value || "—" : "—"; };
  grid.innerHTML = `
    <div class="rc-item"><span class="rc-lbl">Full Name</span><span>${v("regFirstName")} ${v("regLastName") || ""}</span></div>
    <div class="rc-item"><span class="rc-lbl">Matric Number</span><span>${v("regMatric")}</span></div>
    <div class="rc-item"><span class="rc-lbl">Email</span><span>${v("regEmail")}</span></div>
    <div class="rc-item"><span class="rc-lbl">Phone</span><span>${v("regPhone")}</span></div>
    <div class="rc-item"><span class="rc-lbl">Department</span><span>${v("regDepartment")}</span></div>
    <div class="rc-item"><span class="rc-lbl">Level</span><span>${v("regLevel")}</span></div>
    <div class="rc-item"><span class="rc-lbl">Session</span><span>${v("regSession")}</span></div>
    <div class="rc-item"><span class="rc-lbl">Faculty</span><span>${v("regFaculty")}</span></div>
  `;
}

/* Photo upload preview for registration step 1 */
(function initPhotoUpload() {
  const input = document.getElementById("regPhotoInput");
  if (!input) return;
  input.addEventListener("change", () => {
    const file = input.files && input.files[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      showToast("Please choose an image file.", "danger");
      input.value = "";
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = document.getElementById("photoPreviewImg");
      const icon = document.getElementById("photoPreviewIcon");
      const removeBtn = document.getElementById("photoRemoveBtn");
      if (img && icon) {
        img.src = e.target.result;
        img.classList.remove("hidden");
        icon.classList.add("hidden");
      }
      if (removeBtn) removeBtn.classList.remove("hidden");
    };
    reader.readAsDataURL(file);
  });
})();

function clearPhotoUpload() {
  const input = document.getElementById("regPhotoInput");
  const img = document.getElementById("photoPreviewImg");
  const icon = document.getElementById("photoPreviewIcon");
  const removeBtn = document.getElementById("photoRemoveBtn");
  if (input) input.value = "";
  if (img) {
    img.src = "";
    img.classList.add("hidden");
  }
  if (icon) icon.classList.remove("hidden");
  if (removeBtn) removeBtn.classList.add("hidden");
}

/* ── Camera Modal for Profile Picture ── */
let _modalStream = null;

function openCameraModal() {
  const modal = document.getElementById("cameraModal");
  if (modal) modal.classList.remove("hidden");
}

function closeCameraModal() {
  const modal = document.getElementById("cameraModal");
  if (modal) modal.classList.add("hidden");
  modalStopCamera();
}

async function modalStartCamera() {
  const video = document.getElementById("modalVideoFeed");
  const placeholder = document.getElementById("modalCameraPlaceholder");
  const startBtn = document.getElementById("modalStartCamBtn");
  const captureBtn = document.getElementById("modalCaptureBtn");

  if (!video) return;

  try {
    _modalStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: 640, height: 480 } });
    video.srcObject = _modalStream;
    video.classList.remove("hidden");
    if (placeholder) placeholder.style.display = "none";
    if (startBtn) startBtn.classList.add("hidden");
    if (captureBtn) captureBtn.classList.remove("hidden");
  } catch (err) {
    showToast("Could not access camera: " + err.message, "danger");
  }
}

function modalCapturePhoto() {
  const video = document.getElementById("modalVideoFeed");
  const canvas = document.getElementById("modalSnapCanvas");
  const captureBtn = document.getElementById("modalCaptureBtn");
  const retakeBtn = document.getElementById("modalRetakeBtn");

  if (!video || !canvas) return;

  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext("2d").drawImage(video, 0, 0);

  const dataUrl = canvas.toDataURL("image/jpeg", 0.9);

  // Set the captured photo as the profile picture
  const img = document.getElementById("photoPreviewImg");
  const icon = document.getElementById("photoPreviewIcon");
  const removeBtn = document.getElementById("photoRemoveBtn");
  if (img) {
    img.src = dataUrl;
    img.classList.remove("hidden");
  }
  if (icon) icon.classList.add("hidden");
  if (removeBtn) removeBtn.classList.remove("hidden");

  // Store the photo data for registration
  window.__regPhoto = dataUrl;

  // Stop camera and close modal
  modalStopCamera();
  closeCameraModal();
  showToast("Photo captured successfully!", "success");
}

function modalRetakePhoto() {
  const captureBtn = document.getElementById("modalCaptureBtn");
  const retakeBtn = document.getElementById("modalRetakeBtn");
  if (captureBtn) captureBtn.classList.remove("hidden");
  if (retakeBtn) retakeBtn.classList.add("hidden");
}

function modalStopCamera() {
  if (_modalStream) {
    _modalStream.getTracks().forEach(t => t.stop());
    _modalStream = null;
  }
  const video = document.getElementById("modalVideoFeed");
  const placeholder = document.getElementById("modalCameraPlaceholder");
  const startBtn = document.getElementById("modalStartCamBtn");
  const captureBtn = document.getElementById("modalCaptureBtn");
  const retakeBtn = document.getElementById("modalRetakeBtn");
  if (video) { video.srcObject = null; video.classList.add("hidden"); }
  if (placeholder) placeholder.style.display = "";
  if (startBtn) startBtn.classList.remove("hidden");
  if (captureBtn) captureBtn.classList.add("hidden");
  if (retakeBtn) retakeBtn.classList.add("hidden");
}

function isValidMatric(matric) {
  return typeof matric === "string" && /^\d{11}$/.test(matric.trim());
}

/* ─────────────────────────────────────────
   5. REGISTRATION FORM — Submit
───────────────────────────────────────── */
const regForm = document.getElementById("regForm");
if (regForm) {
  regForm.addEventListener("submit", async (e) => {
    e.preventDefault();

    const field = (id) => {
      const el = document.getElementById(id);
      return el ? el.value.trim() : "";
    };

    const matric = field("regMatric");
    const password = field("regPass");

    if (!isValidMatric(matric)) {
      showToast("Matric number must be exactly 11 digits, e.g. 20211292002.", "danger");
      return;
    }
    if (password.length < 8) {
      showToast("Password must be at least 8 characters long.", "danger");
      return;
    }

    const submitBtn = document.getElementById("submitBtn");
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Creating account...';
    }

    const fullName = field("regFirstName") || field("regFullName");
    const nameParts = fullName.trim().split(/\s+/);
    const payload = {
      matric,
      password,
      firstName: nameParts[0] || fullName,
      lastName: nameParts.slice(1).join(" "),
      email: field("regEmail"),
      phone: field("regPhone"),
      department: field("regDepartment"),
      faculty: field("regFaculty"),
      level: field("regLevel"),
      session: field("regSession"),
    };

    const uploadedPhoto = document.getElementById("photoPreviewImg");
    let photoSrc = null;
    if (uploadedPhoto && uploadedPhoto.src && !uploadedPhoto.classList.contains("hidden")) {
      photoSrc = uploadedPhoto.src;
    }
    if (photoSrc) {
      payload.photo = photoSrc;
    }

    try {
      await apiRegister(payload);
      const modal = document.getElementById("successModal");
      if (modal) modal.classList.remove("hidden");
    } catch (err) {
      console.error(err);
      showToast(err.message || "Registration failed. Please try again.", "danger");
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.innerHTML = '<i class="fas fa-paper-plane"></i> Submit Registration';
      }
    }
  });
}

/* ─────────────────────────────────────────
   6. STUDENT LOGIN — Submit
───────────────────────────────────────── */
const loginForm = document.getElementById("loginForm");
if (loginForm) {
  loginForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const matric = document.getElementById("matricNo").value.trim();
    const pass = document.getElementById("loginPass").value;
    const btn = document.getElementById("loginBtn");

    if (!matric || !pass) {
      showToast("Please enter your matric number and password.", "danger");
      return;
    }
    if (!isValidMatric(matric)) {
      showToast("Matric number must be exactly 11 digits, e.g. 20211292002.", "danger");
      return;
    }

    if (btn) {
      btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Logging in...';
      btn.disabled = true;
    }

    try {
      await apiLogin(matric, pass);
      window.location.href = "student-dashboard.html";
    } catch (err) {
      console.error(err);
      showToast(err.message || "Login failed. Please try again.", "danger");
    } finally {
      if (btn) {
        btn.innerHTML = '<i class="fas fa-right-to-bracket"></i> Login';
        btn.disabled = false;
      }
    }
  });
}

/* ─────────────────────────────────────────
   6b. FORGOT PASSWORD — Request / Verify / Reset
───────────────────────────────────────── */
const fpRequestForm = document.getElementById("fpRequestForm");
if (fpRequestForm) {
  fpRequestForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const matric = document.getElementById("fpMatric").value.trim();
    const email = document.getElementById("fpEmail").value.trim().toLowerCase();
    const btn = fpRequestForm.querySelector("button[type='submit']");

    if (!isValidMatric(matric)) {
      showToast("Matric number must be exactly 11 digits.", "danger");
      return;
    }

    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Sending...';
    }

    try {
      const data = await apiForgotRequest(matric, email);
      window.__eipsFpMatric = matric;

      document.getElementById("fpStep1").classList.add("hidden");
      document.getElementById("fpStep2").classList.remove("hidden");

      const demoBox = document.getElementById("fpDemoOtp");
      if (demoBox && data.demoOtp) {
        demoBox.textContent = data.demoOtp;
        demoBox.closest(".fp-demo-box").classList.remove("hidden");
      }
      showToast("Verification code generated (see demo box below).", "success");
    } catch (err) {
      console.error(err);
      showToast(err.message || "Could not generate a code. Please try again.", "danger");
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-paper-plane"></i> Send Verification Code';
      }
    }
  });
}

const fpOtpForm = document.getElementById("fpOtpForm");
if (fpOtpForm) {
  fpOtpForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const matric = window.__eipsFpMatric;
    const btn = fpOtpForm.querySelector("button[type='submit']");
    if (!matric) {
      showToast("Session expired. Please start again.", "danger");
      return;
    }
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Verifying...';
    }
    try {
      await apiForgotVerify(matric, document.getElementById("fpOtpCode").value.trim());
      document.getElementById("fpStep2").classList.add("hidden");
      document.getElementById("fpStep3").classList.remove("hidden");
      showToast("Code verified. Choose a new password.", "success");
    } catch (err) {
      console.error(err);
      showToast(err.message || "Could not verify the code. Please try again.", "danger");
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-circle-check"></i> Verify Code';
      }
    }
  });
}

const fpResetForm = document.getElementById("fpResetForm");
if (fpResetForm) {
  fpResetForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const p1 = document.getElementById("fpNewPass");
    const p2 = document.getElementById("fpNewPass2");
    const matric = window.__eipsFpMatric;
    const btn = fpResetForm.querySelector("button[type='submit']");

    if (p1.value.length < 8) {
      showToast("Password must be at least 8 characters long.", "danger");
      return;
    }
    if (p1.value !== p2.value) {
      showToast("Passwords do not match.", "danger");
      return;
    }
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Resetting...';
    }
    try {
      await apiForgotReset(matric, p1.value);
      document.getElementById("fpStep3").classList.add("hidden");
      document.getElementById("fpStep4").classList.remove("hidden");
      showToast("Password changed successfully.", "success");
    } catch (err) {
      console.error(err);
      showToast(err.message || "Could not change the password. Please try again.", "danger");
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-rotate"></i> Reset Password';
      }
    }
  });
}

/* ─────────────────────────────────────────
   7. ADMIN LOGIN
   Real credentials now validated server-side.
   Default seed: username "admin", password
   "ChangeMe123!", access code "112233".
───────────────────────────────────────── */
const adminLoginForm = document.getElementById("adminLoginForm");
if (adminLoginForm) {
  adminLoginForm.addEventListener("submit", async (e) => {
    e.preventDefault();

    const email = document.getElementById("adminEmail").value.trim();
    const password = document.getElementById("adminPass").value;
    const adminKey = document.getElementById("adminKey").value;

    if (!email || !password || !adminKey) {
      showToast("All fields are required.", "danger");
      return;
    }

    const btn = adminLoginForm.querySelector("button[type='submit']");
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Authenticating...';
    }

    const resetBtn = () => {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-right-to-bracket"></i> Login to Dashboard';
      }
    };

    try {
      await apiAdminLogin(email, password, adminKey);
      window.location.href = "admin-dashboard.html";
    } catch (err) {
      resetBtn();
      console.error(err);
      showToast(err.message || "Login failed. Please try again.", "danger");
    }
  });
}

/* ─────────────────────────────────────────
   8b. COURSE REGISTRATION PAGE
───────────────────────────────────────── */
const MAX_UNITS = 24;
let selectedExamCourseCode = null;
let EIPS_ALL_COURSES = [];
let selectedCarryOvers = [];
let studentLevel = 0;

async function loadCourseCatalog() {
  if (EIPS_ALL_COURSES.length) return EIPS_ALL_COURSES;
  const courses = await apiFetch("/api/courses");
  EIPS_ALL_COURSES = courses;
  return courses;
}

function courseUnitsSum(list) {
  return list.reduce((sum, c) => sum + c.unit, 0);
}

function renderCourseTables(compulsory, elective, previouslyRegisteredCodes) {
  const compBody = document.getElementById("compulsoryTbody");
  const electBody = document.getElementById("electiveTbody");
  if (!compBody) return;

  const prevSet = new Set(previouslyRegisteredCodes || []);

  const rowHtml = (c) => `
    <tr>
      <td><input type="checkbox" class="course-checkbox reg-cb" data-code="${c.code}" data-unit="${c.unit}" data-type="${c.type}" ${
        prevSet.has(c.code) ? "checked" : ""
      } onchange="handleCourseChange(this)" /></td>
      <td class="course-code-cell">${c.code}</td>
      <td>${c.title}</td>
      <td>${c.unit}</td>
      <td><span class="course-type-badge ${c.type === "Compulsory" ? "compulsory" : "elective"}">${c.type}</span></td>
    </tr>`;

  compBody.innerHTML = compulsory.map(rowHtml).join("");
  if (electBody) electBody.innerHTML = elective.map(rowHtml).join("");

  updateUnitCounter();
}

function toggleElectives() {
  const section = document.getElementById("electiveSection");
  const coSection = document.getElementById("carryoverSection");
  const btn = document.getElementById("addBorrowBtn");
  if (!section) return;
  section.classList.toggle("hidden");
  if (coSection) coSection.classList.toggle("hidden");
  if (btn) {
    const collapsed = section.classList.contains("hidden");
    btn.innerHTML = collapsed
      ? '<i class="fas fa-plus"></i> Add/Borrow &amp; Carry-Over'
      : '<i class="fas fa-minus"></i> Hide Sections';
  }
  if (!section.classList.contains("hidden")) {
    populateCarryOverLevelFilter();
  }
}

function populateCarryOverLevelFilter() {
  const sel = document.getElementById("carryoverLevelFilter");
  if (!sel || studentLevel <= 200) return;
  sel.innerHTML = '<option value="">-- Select Level to Browse --</option>';
  for (let lv = 200; lv < studentLevel; lv += 100) {
    sel.innerHTML += `<option value="${lv}">${lv} Level</option>`;
  }
}

async function loadCarryOverCourses() {
  const level = document.getElementById("carryoverLevelFilter").value;
  const listEl = document.getElementById("carryoverCourseList");
  if (!level || !listEl) {
    if (listEl) listEl.innerHTML = "";
    return;
  }
  listEl.innerHTML = `<p><i class="fas fa-spinner fa-spin"></i> Loading courses...</p>`;
  try {
    const courses = await apiCoursesByLevel(level);
    if (!courses.length) {
      listEl.innerHTML = `<p style="color: var(--text-muted)">No courses found for ${level} level.</p>`;
      return;
    }
    const existing = new Set([
      ...document.querySelectorAll(".reg-cb:checked").length
        ? Array.from(document.querySelectorAll(".reg-cb:checked")).map((cb) => cb.dataset.code)
        : [],
      ...selectedCarryOvers.map((c) => c.code),
    ]);
    listEl.innerHTML = courses.map((c) => {
      const alreadySelected = existing.has(c.code);
      return `<div class="carryover-option ${alreadySelected ? "selected" : ""}" onclick="addCarryOver('${c.code}', '${c.title.replace(/'/g, "\\'")}', ${c.unit}, ${level})">
        <strong>${c.code}</strong> — ${c.title} (${c.unit} unit${c.unit === 1 ? "" : "s"})
        ${alreadySelected ? '<span class="status-badge verified" style="margin-left:auto"><i class="fas fa-check"></i> Added</span>' : '<button class="btn btn-outline btn-sm" style="margin-left:auto"><i class="fas fa-plus"></i> Add</button>'}
      </div>`;
    }).join("");
  } catch (err) {
    listEl.innerHTML = `<p style="color: var(--danger)"><i class="fas fa-circle-exclamation"></i> ${err.message}</p>`;
  }
}

function addCarryOver(code, title, unit, level) {
  if (selectedCarryOvers.find((c) => c.code === code)) {
    showToast(`${code} is already added.`, "warning");
    return;
  }
  selectedCarryOvers.push({ code, title, unit, level: Number(level) });
  renderCarryOverTable();
  loadCarryOverCourses();
  updateUnitCounter();
  showToast(`${code} added to carry-over courses.`, "success");
}

function removeCarryOver(code) {
  selectedCarryOvers = selectedCarryOvers.filter((c) => c.code !== code);
  renderCarryOverTable();
  loadCarryOverCourses();
  updateUnitCounter();
}

function renderCarryOverTable() {
  const tbody = document.getElementById("carryoverTbody");
  const empty = document.getElementById("carryoverEmpty");
  if (!tbody) return;
  if (!selectedCarryOvers.length) {
    tbody.innerHTML = "";
    if (empty) empty.classList.remove("hidden");
    return;
  }
  if (empty) empty.classList.add("hidden");
  tbody.innerHTML = selectedCarryOvers.map((c) => `
    <tr>
      <td><button class="act-btn delete" onclick="removeCarryOver('${c.code}')"><i class="fas fa-trash"></i></button></td>
      <td class="course-code-cell">${c.code}</td>
      <td>${c.title}</td>
      <td>${c.unit}</td>
      <td>${c.level}L</td>
    </tr>`).join("");
}

function handleCourseChange(cb) {
  let total = 0;
  document.querySelectorAll(".reg-cb:checked").forEach((c) => (total += Number(c.dataset.unit)));
  selectedCarryOvers.forEach((c) => (total += Number(c.unit)));

  if (total > MAX_UNITS) {
    cb.checked = false;
    showToast(
      `Registering that course would exceed the ${MAX_UNITS}-unit maximum load. Uncheck another course first.`,
      "warning"
    );
  }
  updateUnitCounter();
}

function updateUnitCounter() {
  const counter = document.getElementById("unitCounter");
  if (!counter) return;

  let total = 0;
  document.querySelectorAll(".reg-cb:checked").forEach((cb) => (total += Number(cb.dataset.unit)));
  selectedCarryOvers.forEach((c) => (total += Number(c.unit)));

  counter.innerHTML = `<i class="fas fa-layer-group"></i> ${total} of ${MAX_UNITS} units`;
  counter.classList.remove("near-limit", "at-limit");
  if (total >= MAX_UNITS) counter.classList.add("at-limit");
  else if (total >= MAX_UNITS - 4) counter.classList.add("near-limit");
}

const courseRegForm = document.getElementById("courseRegForm");
if (courseRegForm) {
  courseRegForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const student = await requireLogin();
    if (!student) return;

    const registered = [];
    const carryOverCodes = [];
    document.querySelectorAll(".reg-cb:checked").forEach((cb) => {
      const course = EIPS_ALL_COURSES.find((c) => c.code === cb.dataset.code);
      if (course) registered.push({ code: course.code, type: cb.dataset.type || course.type });
    });
    selectedCarryOvers.forEach((c) => carryOverCodes.push(c.code));

    if (!registered.length && !carryOverCodes.length) {
      showToast("Please select at least one course to register.", "danger");
      return;
    }

    const btn = document.getElementById("registerCoursesBtn");
    if (btn) {
      btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Registering...';
      btn.disabled = true;
    }

    try {
      await apiRegisterCourses(registered, carryOverCodes);
      const updated = await apiMe();
      showToast("Courses registered successfully!", "success");
      openExamSelectModal(updated.registeredCourses || registered);
    } catch (err) {
      console.error(err);
      showToast(err.message || "Could not register courses.", "danger");
    } finally {
      if (btn) {
        btn.innerHTML = '<i class="fas fa-paper-plane"></i> Register Courses';
        btn.disabled = false;
      }
    }
  });
}

function openExamSelectModal(registered) {
  const modal = document.getElementById("examSelectModal");
  if (!modal) return;
  modal.classList.remove("hidden");
}

async function proceedToBiometric() {
  window.location.href = "biometric-collection.html";
}

/* ─────────────────────────────────────────
   BIOMETRIC COLLECTION PAGE
   Student captures face photo + fingerprint
   after course registration.
───────────────────────────────────────── */
let _bioStream = null;
let _capturedPhoto = null;

(async function initBiometricCollection() {
  const nameEl = document.getElementById("bioStudentName");
  if (!nameEl) return; // not on biometric-collection.html

  const student = await requireLogin();
  if (!student) return;
  window.__student = student;

  const fullName = `${student.firstName} ${student.lastName}`;
  nameEl.textContent = fullName;
  const subEl = document.getElementById("bioStudentSub");
  if (subEl) {
    subEl.innerHTML = `<span>${student.matric}</span> &bull; ${student.department || "—"} &bull; ${student.level || "—"}`;
  }

  // If biometrics already collected, show completion
  if (student.faceDescriptor && student.fingerprintCredentialId) {
    document.getElementById("faceSection").classList.add("hidden");
    document.getElementById("fingerprintSection").classList.add("hidden");
    document.getElementById("completionSection").classList.remove("hidden");
    updateSteps(4);
    return;
  }

  // If face already collected, skip to fingerprint
  if (student.faceDescriptor) {
    document.getElementById("faceSection").classList.add("hidden");
    document.getElementById("fingerprintSection").classList.remove("hidden");
    updateSteps(3);
    return;
  }
})();

function updateSteps(step) {
  const vs1 = document.getElementById("vs1");
  const vs2 = document.getElementById("vs2");
  const vs3 = document.getElementById("vs3");
  const vs4 = document.getElementById("vs4");

  if (step >= 2) { vs1.classList.add("done"); vs1.innerHTML = '<i class="fas fa-circle-check"></i> Logged In'; }
  if (step >= 3) { vs2.classList.add("done"); vs2.innerHTML = '<i class="fas fa-circle-check"></i> Face Photo'; vs3.classList.add("active"); vs3.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Fingerprint'; }
  if (step >= 4) { vs3.classList.add("done"); vs3.innerHTML = '<i class="fas fa-circle-check"></i> Fingerprint'; vs4.classList.add("done"); vs4.innerHTML = '<i class="fas fa-circle-check"></i> Complete'; }
}

async function capturePhoto() {
  const video = document.getElementById("bioVideo");
  const canvas = document.getElementById("bioCanvas");
  const placeholder = document.getElementById("bioPlaceholder");
  const captureBtn = document.getElementById("capturePhotoBtn");
  const retakeBtn = document.getElementById("retakePhotoBtn");
  const resultEl = document.getElementById("faceResult");

  if (!_bioStream) {
    // Start camera
    try {
      _bioStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: 640, height: 480 } });
      video.srcObject = _bioStream;
      placeholder.style.display = "none";
      captureBtn.innerHTML = '<i class="fas fa-camera"></i> Capture Photo';
      return;
    } catch (err) {
      showToast("Could not access camera: " + err.message, "danger");
      return;
    }
  }

  // Capture photo
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(video, 0, 0);
  _capturedPhoto = canvas.toDataURL("image/jpeg", 0.9);

  // Stop camera
  if (_bioStream) {
    _bioStream.getTracks().forEach(t => t.stop());
    _bioStream = null;
  }

  // Get face descriptor
  captureBtn.disabled = true;
  captureBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Processing...';

  const img = new Image();
  img.src = _capturedPhoto;
  await new Promise(r => { img.onload = r; });

  const descriptor = await getFaceDescriptor(img);
  if (!descriptor) {
    showToast("No face detected. Please retake with your face clearly visible.", "danger");
    captureBtn.disabled = false;
    captureBtn.innerHTML = '<i class="fas fa-camera"></i> Capture Photo';
    return;
  }

  // Enroll face on server
  try {
    await apiEnrollFace(descriptor, _capturedPhoto);
    resultEl.classList.remove("hidden");
    captureBtn.classList.add("hidden");
    retakeBtn.classList.add("hidden");
    updateSteps(3);

    // Show fingerprint section
    setTimeout(() => {
      document.getElementById("faceSection").classList.add("hidden");
      document.getElementById("fingerprintSection").classList.remove("hidden");
    }, 1500);
  } catch (err) {
    showToast("Failed to save face data: " + err.message, "danger");
    captureBtn.disabled = false;
    captureBtn.innerHTML = '<i class="fas fa-camera"></i> Capture Photo';
  }
}

function retakePhoto() {
  const video = document.getElementById("bioVideo");
  const placeholder = document.getElementById("bioPlaceholder");
  const captureBtn = document.getElementById("capturePhotoBtn");

  _capturedPhoto = null;
  if (_bioStream) {
    _bioStream.getTracks().forEach(t => t.stop());
    _bioStream = null;
  }
  video.srcObject = null;
  placeholder.style.display = "";
  captureBtn.innerHTML = '<i class="fas fa-camera"></i> Capture Photo';
}

async function enrollFingerprintStep() {
  const student = window.__student;
  if (!student) return;

  const btn = document.getElementById("enrollFpBtn");
  const statusEl = document.getElementById("fpStatus");

  if (!webAuthnSupported()) {
    if (statusEl) {
      statusEl.textContent = "This browser/device has no fingerprint sensor available. Fingerprint step will be skipped.";
      statusEl.className = "fp-status warn";
    }
    // Skip fingerprint, go to completion
    document.getElementById("fingerprintSection").classList.add("hidden");
    document.getElementById("completionSection").classList.remove("hidden");
    updateSteps(4);
    return;
  }

  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Waiting for sensor...';

  try {
    const credentialId = await enrollFingerprint(student.matric, `${student.firstName} ${student.lastName}`);
    await apiEnrollFingerprint(credentialId);

    if (statusEl) {
      statusEl.textContent = "Fingerprint enrolled successfully on this device.";
      statusEl.className = "fp-status ok";
    }

    updateSteps(4);

    // Show completion
    setTimeout(() => {
      document.getElementById("fingerprintSection").classList.add("hidden");
      document.getElementById("completionSection").classList.remove("hidden");
    }, 1500);
  } catch (err) {
    console.warn(err);
    const msg = err && err.message ? err.message : String(err);
    if (statusEl) {
      statusEl.textContent = "Fingerprint step failed or was cancelled: " + msg;
      statusEl.className = "fp-status err";
    }
    showToast("Fingerprint step failed: " + msg, "danger");
    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-fingerprint"></i> Try Again';
  }
}

/* ── Gate + populate the course-registration page ── */
(async function initCourseRegistrationPage() {
  const nameEl = document.getElementById("courseStudentName");
  if (!nameEl) return; // not on course-registration.html

  const student = await requireLogin();
  if (!student) return;

  window.__student = student;

  nameEl.textContent = `${student.firstName} ${student.lastName}`;
  const matricEl = document.getElementById("courseStudentMatric");
  const levelEl = document.getElementById("courseStudentLevel");
  const sessionEl = document.getElementById("courseStudentSession");
  const navNameEl = document.getElementById("courseNavStudentName");
  if (matricEl) matricEl.textContent = student.matric;
  if (levelEl) levelEl.textContent = student.level || "—";
  if (sessionEl) sessionEl.textContent = student.session || "—";
  if (navNameEl) navNameEl.textContent = `${student.firstName} ${student.lastName}`;

  const studentLevelStr = (student.level || "").replace(/\D/g, "");
  studentLevel = parseInt(studentLevelStr, 10) || 0;

  const courses = await loadCourseCatalog();
  const filtered = courses.filter((c) => {
    const m = c.code.match(/\d/);
    if (!m) return true;
    const courseLevel = parseInt(m[0], 10) * 100;
    return courseLevel === studentLevel;
  });
  const compulsory = filtered.filter((c) => c.type === "Compulsory");
  const elective = filtered.filter((c) => c.type === "Elective");
  const priorCodes = (student.registeredCourses || []).map((c) => c.code);
  renderCourseTables(compulsory, elective, priorCodes);

  const hintBox = document.querySelector(".reg-hint-box p");
  if ((student.registeredCourses || []).length && hintBox) {
    const when = student.registeredAt ? new Date(student.registeredAt).toLocaleString() : "previously";
    const banner = document.createElement("div");
    banner.className = "reg-hint-box";
    banner.style.marginTop = "1rem";
    banner.innerHTML = `<i class="fas fa-circle-info"></i><p>You already registered courses for this session on <strong>${when}</strong>. Submitting again below will update your registration.</p>`;
    hintBox.closest(".reg-hint-box").after(banner);
  }
})();

/* ─────────────────────────────────────────
   9. IDENTITY VERIFICATION PAGE
   Step A: Face — first time enrolls a descriptor
   from the live camera; later visits compare live
   capture against the stored descriptor.
   Step B: Fingerprint — WebAuthn enroll/verify.
   NOTE: a seat is NOT assigned here. On exam day the
   invigilator approves the student at the admin
   checkpoint and ONLY THEN is a seat allocated.
───────────────────────────────────────── */
let verifyStream = null;
let __verifyFaceOk = false;
let __verifyFpOk = false;

async function startVerification() {
  const placeholder = document.getElementById("verifyPlaceholder");
  const video = document.getElementById("verifyVideo");
  const scanLine = document.getElementById("scanLine");
  const startBtn = document.getElementById("startVerifyBtn");
  const vs2 = document.getElementById("vs2");

  const student = await requireLogin();
  if (!student || !video) return;

  try {
    verifyStream = await navigator.mediaDevices.getUserMedia({ video: true });
    video.srcObject = verifyStream;
    video.classList.remove("hidden");

    if (placeholder) placeholder.classList.add("hidden");
    if (scanLine) scanLine.style.display = "block";
    if (startBtn) startBtn.disabled = true;
    if (vs2) vs2.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Scanning Face';

    setTimeout(async () => {
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth || 480;
      canvas.height = video.videoHeight || 360;
      canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);

      stopVerifyCamera();

      let descriptor = null;
      try {
        descriptor = typeof getFaceDescriptor === "function" ? await getFaceDescriptor(canvas) : null;
      } catch (err) {
        console.warn("Face descriptor extraction failed:", err);
      }

      if (!descriptor) {
        showFaceStepResult(false, "No face could be detected clearly. Please retry with better lighting.");
        return;
      }

      if (!student.faceDescriptor) {
        try {
          await apiEnrollFace(descriptor, canvas.toDataURL("image/jpeg"));
          showFaceStepResult(true, "Face enrolled as your biometric reference.");
        } catch (err) {
          showFaceStepResult(false, err.message || "Could not save your face reference.");
        }
      } else {
        const { isMatch, distance } = faceMatches(descriptor, student.faceDescriptor);
        if (isMatch) {
          showFaceStepResult(true, `Face match confidence: ${(100 - distance * 100).toFixed(1)}%`);
        } else {
          showFaceStepResult(false, "Face did not match your registered photo. An alert would be sent to the administrator.");
        }
      }
    }, 2500);
  } catch {
    showToast("Camera access denied. Cannot perform verification.", "danger");
  }
}

function stopVerifyCamera() {
  if (verifyStream) verifyStream.getTracks().forEach((t) => t.stop());
  const scanLine = document.getElementById("scanLine");
  if (scanLine) scanLine.style.display = "none";
}

function showFaceStepResult(success, detailText) {
  const resultSuccess = document.getElementById("verifyResult");
  const resultFailed = document.getElementById("verifyFailed");
  const retryBtn = document.getElementById("retryVerifyBtn");
  const startBtn = document.getElementById("startVerifyBtn");
  const vs2 = document.getElementById("vs2");
  const fpSection = document.getElementById("fingerprintSection");

  __verifyFaceOk = success;

  if (success) {
    if (resultSuccess) {
      resultSuccess.classList.remove("hidden");
      const detail = resultSuccess.querySelector("p");
      if (detail) detail.textContent = detailText;
    }
    if (vs2) {
      vs2.classList.remove("active");
      vs2.classList.add("done");
      vs2.innerHTML = '<i class="fas fa-circle-check"></i> Face Verified';
    }
    if (fpSection) fpSection.classList.remove("hidden");
    showToast("Face step complete.", "success");
  } else {
    if (resultFailed) {
      resultFailed.classList.remove("hidden");
      const detail = resultFailed.querySelector("p");
      if (detail) detail.textContent = detailText;
    }
    if (retryBtn) retryBtn.classList.remove("hidden");
    if (startBtn) startBtn.classList.add("hidden");
    if (vs2) {
      vs2.classList.remove("active");
      vs2.innerHTML = '<i class="fas fa-circle-xmark"></i> Scan Failed';
      vs2.style.color = "var(--danger)";
    }
    showToast(detailText, "danger");
  }
}

function retryVerification() {
  const resultFailed = document.getElementById("verifyFailed");
  const retryBtn = document.getElementById("retryVerifyBtn");
  const startBtn = document.getElementById("startVerifyBtn");
  const placeholder = document.getElementById("verifyPlaceholder");
  const video = document.getElementById("verifyVideo");
  const vs2 = document.getElementById("vs2");

  if (resultFailed) resultFailed.classList.add("hidden");
  if (retryBtn) retryBtn.classList.add("hidden");
  if (startBtn) {
    startBtn.disabled = false;
    startBtn.classList.remove("hidden");
  }
  if (placeholder) placeholder.classList.remove("hidden");
  if (video) {
    video.classList.add("hidden");
    video.srcObject = null;
  }
  if (vs2) {
    vs2.classList.add("active");
    vs2.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Scanning Face';
    vs2.style.color = "";
  }
}

/* Fingerprint step — real WebAuthn, run AFTER face succeeds */
async function runFingerprintStep() {
  const student = await requireLogin();
  if (!student) return;
  const btn = document.getElementById("fingerprintBtn");
  const statusEl = document.getElementById("fingerprintStatus");
  const vs3 = document.getElementById("vs3");

  if (!webAuthnSupported()) {
    if (statusEl) {
      statusEl.textContent =
        "This browser/device has no platform fingerprint sensor available (or the page isn't served over HTTPS). Fingerprint step skipped.";
      statusEl.className = "fp-status warn";
    }
    finishVerification(false);
    return;
  }

  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Waiting for sensor...';
  }

  try {
    if (!student.fingerprintCredentialId) {
      const credentialId = await enrollFingerprint(student.matric, `${student.firstName} ${student.lastName}`);
      await apiEnrollFingerprint(credentialId);
      if (statusEl) {
        statusEl.textContent = "Fingerprint enrolled successfully on this device.";
        statusEl.className = "fp-status ok";
      }
    } else {
      await verifyFingerprint(student.fingerprintCredentialId);
      if (statusEl) {
        statusEl.textContent = "Fingerprint verified successfully.";
        statusEl.className = "fp-status ok";
      }
    }
    if (vs3) {
      vs3.classList.add("done");
      vs3.innerHTML = '<i class="fas fa-circle-check"></i> Fingerprint Verified';
    }
    finishVerification(true);
  } catch (err) {
    console.warn(err);
    const msg = err && err.message ? err.message : String(err);
    if (statusEl) {
      statusEl.textContent = "Fingerprint step was cancelled or failed: " + msg;
      statusEl.className = "fp-status err";
    }
    showToast("Fingerprint step failed: " + msg, "danger");
    finishVerification(false);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<i class="fas fa-fingerprint"></i> Try Fingerprint Again';
    }
  }
}

async function finishVerification(fpOk) {
  __verifyFpOk = fpOk;
  const proceedBtn = document.getElementById("proceedSeatBtn");
  const doneBtn = document.getElementById("verifyDoneBtn");
  const vs4 = document.getElementById("vs4");
  const doneMsg = document.getElementById("verifyDoneMsg");

  if (__verifyFaceOk && __verifyFpOk) {
    if (vs4) {
      vs4.classList.add("done");
      vs4.innerHTML = '<i class="fas fa-circle-check"></i> Identity Confirmed';
    }
    showToast("Identity confirmed!", "success");
    if (doneMsg) doneMsg.classList.remove("hidden");
    if (doneBtn) doneBtn.classList.remove("hidden");
    // A seat is NOT assigned here — it is allocated by the invigilator on
    // exam day at the admin checkpoint. Show the seat button only if one
    // has already been approved.
    if (proceedBtn) {
      try {
        const seatData = await apiGetSeat();
        if (seatData && seatData.seat) proceedBtn.classList.remove("hidden");
      } catch {
        /* keep button hidden */
      }
    }
  }
}

/* Populate the verify.html student summary bar + exam badge on load */
(async function initVerifyPage() {
  const navNameEl = document.getElementById("loggedStudentName");
  const summaryNameEl = document.getElementById("summaryStudentName");
  if (!navNameEl && !summaryNameEl) return; // not on verify.html

  const student = await requireLogin();
  if (!student) return;

  const fullName = `${student.firstName} ${student.lastName}`;
  if (navNameEl) navNameEl.textContent = fullName;
  if (summaryNameEl) summaryNameEl.textContent = fullName;

  const summarySubEl = document.getElementById("summaryStudentSub");
  if (summarySubEl) {
    summarySubEl.innerHTML = `<span>${student.matric}</span> &bull; ${student.department || "—"} &bull; ${student.level || "—"}`;
  }

  const registered = student.registeredCourses || [];
  const examCourse =
    (student.examSelection && registered.find((c) => c.code === student.examSelection.course_code)) ||
    registered[0] ||
    null;

  const codeEl = document.getElementById("summaryExamCode");
  const metaEl = document.getElementById("summaryExamMeta");
  if (!examCourse) {
    const count = registered.length;
    if (codeEl) codeEl.textContent = count ? `${count} Course${count === 1 ? "" : "s"} Registered` : "No course registered";
    if (metaEl) metaEl.textContent = count ? `${registered.reduce((s, c) => s + (Number(c.units) || 0), 0)} Total Units` : "Go back to course registration";
    return;
  }

  window.__eipsExamCourse = examCourse;

  if (codeEl) codeEl.textContent = examCourse.code;
  if (metaEl) metaEl.textContent = examCourse.title || "—";
})();

/* ─────────────────────────────────────────
   10. SEAT PAGE
   Only shows a seat if the invigilator has approved
   the student on exam day (server-side allocation).
   Otherwise it clearly states the seat is pending
   allocation at the checkpoint.
───────────────────────────────────────── */
function buildHallGrid(seatNumber) {
  const grid = document.getElementById("hallGrid");
  if (!grid) return;

  const totalSeats = 50;
  for (let i = 1; i <= totalSeats; i++) {
    const seat = document.createElement("div");
    seat.classList.add("hall-seat");
    if (i === seatNumber) {
      seat.classList.add("yours");
      seat.title = "Your Seat";
    } else if (i < seatNumber) {
      seat.classList.add("occupied");
    }
    grid.appendChild(seat);
  }
}

(async function initSeatPage() {
  const seatNumEl = document.getElementById("seatNumDisplay");
  if (!seatNumEl) return;

  const student = await requireLogin();
  if (!student) return;

  const navNameEl = document.getElementById("seatNavStudentName");
  if (navNameEl) navNameEl.textContent = `${student.firstName} ${student.lastName}`;

  const seatData = await apiGetSeat();
  const seatCard = document.getElementById("seatCard");
  const pendingCard = document.getElementById("seatPendingCard");
  const hallMap = document.getElementById("hallMap");

  if (!seatData.seat) {
    // No seat yet — allocation only happens after admin approval on exam day.
    if (seatCard) seatCard.classList.add("hidden");
    if (hallMap) hallMap.classList.add("hidden");
    if (pendingCard) pendingCard.classList.remove("hidden");

    const pendingCourse = seatData.examCourse ? seatData.examCourse.code : "your selected course";
    const pendingMetaEl = document.getElementById("pendingCourseMeta");
    if (pendingMetaEl) {
      pendingMetaEl.textContent = seatData.schedule
        ? `${seatData.schedule.date} • ${seatData.schedule.time} • ${seatData.schedule.hall}`
        : "Schedule not yet published by the examination office.";
    }
    const pendingCourseEl = document.getElementById("pendingCourseCode");
    if (pendingCourseEl) pendingCourseEl.textContent = seatData.examCourse ? seatData.examCourse.code : "—";
    return;
  }

  const examCourse = student.registeredCourses.find(
    (c) => c.code === seatData.examCourse?.code
  ) || { code: seatData.examCourse?.code || "—", title: "" };

  const setText = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  };

  setText("seatNumDisplay", seatData.seat.seat);
  setText("seatStudentName", `${student.firstName} ${student.lastName}`);
  setText("seatMatric", student.matric);
  setText("seatCourse", `${examCourse.code} — ${examCourse.title || ""}`.trim());
  setText("seatHall", seatData.seat.hall);
  setText("seatRow", `Row ${seatData.seat.row}`);
  setText("seatTime", seatData.schedule ? seatData.schedule.time : "—");
  setText("seatDate", seatData.schedule ? seatData.schedule.date : "—");

  const printNote = document.getElementById("printSeatDate");
  if (printNote) printNote.textContent = new Date().toLocaleString();

  if (pendingCard) pendingCard.classList.add("hidden");
  buildHallGrid(seatData.seat.seat);
})();

/* ─────────────────────────────────────────
   STUDENT DASHBOARD — load profile, course
   registration status, exam details & seat
───────────────────────────────────────── */
(async function initStudentDashboard() {
  const nameEl = document.getElementById("smGreeting");
  if (!nameEl) return; // not on student-dashboard.html

  const student = await requireLogin();
  if (!student) return;
  window.__student = student;

  const setText = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  };

  const fullName = `${student.firstName} ${student.lastName}`.trim();
  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  setText("smGreeting", `${greeting}, ${student.firstName || fullName.split(" ")[0]}`);
  setText("smMatric", student.matric);

  const photoEl = document.getElementById("smPhoto");
  const fallbackEl = document.getElementById("smPhotoFallback");
  if (photoEl && student.photo) {
    photoEl.src = student.photo;
    photoEl.classList.add("has-photo");
    if (fallbackEl) fallbackEl.style.display = "none";
  }

  const courses = student.registeredCourses || [];
  setText("smRegCourses", courses.length);
  const totalUnits = courses.reduce((sum, c) => sum + (Number(c.unit) || 0), 0);
  setText("smRegUnits", `Total ${totalUnits} Units`);

  const bioReady = !!(student.faceDescriptor || student.fingerprintCredentialId);
  const bioEnrolled = [];
  if (student.faceDescriptor) bioEnrolled.push("Face");
  if (student.fingerprintCredentialId) bioEnrolled.push("Fingerprint");
  setText("smBioStatus", bioEnrolled.length ? bioEnrolled.join(" + ") : "Pending");
  setText("smBioDate", bioEnrolled.length ? "Biometrics enrolled" : "Not yet enrolled");

  const coursesById = {};
  (courses || []).forEach((c) => { coursesById[c.code] = c; });

  try {
    // Fetch all exams with schedules
    const examsData = await apiExams();
    const allExams = (examsData && examsData.exams) || [];
    
    // Find the next scheduled exam
    const scheduledExams = allExams.filter(e => e.date && e.time);
    const nextExam = scheduledExams.length > 0 ? scheduledExams[0] : null;
    
    // Also get seat data for the selected exam
    const seatData = await apiGetSeat();
    const hasSeat = Boolean(seatData.seat);
    
    // Use the next scheduled exam if available, otherwise use selected exam
    const displayExam = nextExam || (seatData.examCourse ? coursesById[seatData.examCourse.code] : null);
    const schedule = nextExam ? { date: nextExam.date, time: nextExam.time, hall: nextExam.hall } : seatData.schedule;

    setText("smNextExam", displayExam ? displayExam.code : "No exam");
    setText("smNextExamSub", schedule ? schedule.date || "Scheduled" : "No exam scheduled");
    setText("smExamCode", displayExam ? displayExam.code : "—");
    setText("smExamTitle", displayExam ? displayExam.title || "" : "No upcoming exam");
    setText("smExamDate", schedule ? schedule.date : "—");
    setText("smExamTime", schedule ? schedule.time : "—");
    setText("smExamHall", hasSeat ? seatData.seat.hall : (schedule ? schedule.hall : "Allocated on exam day"));

    const remaining = scheduledExams.length > 0 ? scheduledExams.length : courses.length;
    const completed = seatData.seatsCompleted != null ? seatData.seatsCompleted : 0;
    setText("smExamsRemaining", remaining);
    setText("smExamsCompleted", completed);
  } catch (err) {
    console.warn("Could not load seat/exam details:", err);
    setText("smNextExam", "No exam");
    setText("smExamCode", "—");
    setText("smExamTitle", "No upcoming exam");
    setText("smExamsRemaining", courses.length);
    setText("smExamsCompleted", 0);
  }

  const listEl = document.getElementById("smActivityList");
  if (listEl) {
    const items = [];
    if (bioEnrolled.length) items.push({ icon: "fa-fingerprint", text: "Biometric profile verified", time: "Today" });
    if (courses.length) items.push({ icon: "fa-book-open", text: `${courses.length} course${courses.length === 1 ? "" : "s"} registered`, time: "Today" });
    if (student.examSelection) items.push({ icon: "fa-file-alt", text: `Selected exam: ${student.examSelection.courseCode || "—"}`, time: "Today" });

    if (!items.length) {
      listEl.innerHTML = `<p style="color: var(--text-muted); font-size: 1.4rem; padding: 1.2rem 0;">No recent activity.</p>`;
    } else {
      listEl.innerHTML = items.map((it) => `
        <div class="sm-activity-item">
          <span class="sm-activity-icon"><i class="fas ${it.icon}"></i></span>
          <div class="sm-activity-info">
            <span>${it.text}</span>
            <small>${it.time}</small>
          </div>
        </div>`).join("");
    }
  }
})();

function clearActivity() {
  const listEl = document.getElementById("smActivityList");
  if (listEl) {
    listEl.innerHTML = `<p style="color: var(--text-muted); font-size: 1.4rem; padding: 1.2rem 0;">No recent activity.</p>`;
  }
}

/* ── Notification dropdown (student-dashboard.html) ── */
function toggleNotifications() {
  const dropdown = document.getElementById("smNotifDropdown");
  if (!dropdown) return;
  dropdown.classList.toggle("hidden");
  if (!dropdown.classList.contains("hidden")) {
    populateNotifications();
  }
}

async function populateNotifications() {
  const listEl = document.getElementById("smNotifList");
  const badge = document.getElementById("smNotifBadge");
  if (!listEl) return;

  try {
    const data = await apiGetNotifications();
    const notifications = data.notifications || [];
    const unread = data.unread || 0;

    if (badge) {
      if (unread > 0) {
        badge.textContent = unread;
        badge.classList.remove("hidden");
      } else {
        badge.classList.add("hidden");
      }
    }

    if (!notifications.length) {
      listEl.innerHTML = `<p class="sm-notif-empty">No notifications yet.</p>`;
    } else {
      listEl.innerHTML = notifications.map((n) => {
        const iconMap = {
          exam_schedule: { icon: "fa-calendar-check", cls: "" },
          course_upload: { icon: "fa-book-open", cls: "" },
          course_registration: { icon: "fa-book", cls: "success" },
          biometric_enrollment: { icon: "fa-shield-check", cls: "success" },
          seat_allocation: { icon: "fa-chair", cls: "warning" },
        };
        const info = iconMap[n.type] || { icon: "fa-bell", cls: "" };
        const timeAgo = getTimeAgo(n.created_at);
        return `
          <div class="sm-notif-item ${n.read ? "" : "unread"}" onclick="markNotifRead(${n.id})">
            <span class="sm-notif-icon ${info.cls}"><i class="fas ${info.icon}"></i></span>
            <div class="sm-notif-body">
              <p>${n.title}</p>
              <small>${n.message}</small>
              <br><small class="sm-notif-time">${timeAgo}</small>
            </div>
          </div>`;
      }).join("");
    }
  } catch (err) {
    console.warn("Could not load notifications:", err);
    listEl.innerHTML = `<p class="sm-notif-empty">Could not load notifications.</p>`;
  }
}

function getTimeAgo(timestamp) {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return "Just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

async function markNotifRead(id) {
  try {
    await apiMarkNotifRead(id);
    populateNotifications();
  } catch (err) {
    console.warn("Could not mark notification as read:", err);
  }
}

async function clearNotifications() {
  try {
    await apiClearNotifications();
    const listEl = document.getElementById("smNotifList");
    const badge = document.getElementById("smNotifBadge");
    if (listEl) listEl.innerHTML = `<p class="sm-notif-empty">No notifications yet.</p>`;
    if (badge) badge.classList.add("hidden");
  } catch (err) {
    console.warn("Could not clear notifications:", err);
  }
}

document.addEventListener("click", (e) => {
  const wrap = document.querySelector(".sm-bell-wrap");
  const dropdown = document.getElementById("smNotifDropdown");
  if (wrap && dropdown && !wrap.contains(e.target)) {
    dropdown.classList.add("hidden");
  }
});

/* ── Examinations page (examinations.html) ── */
(async function initExaminationsPage() {
  const tbody = document.getElementById("exTbody");
  if (!tbody) return; // not on examinations.html

  const student = await requireLogin();
  if (!student) return;

  const setText = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  };
  const fullName = `${student.firstName} ${student.lastName}`.trim();
  setText("exGreeting", fullName || student.matric);

  try {
    const data = await apiExams();
    const exams = (data && data.exams) || [];

    setText("exTotal", exams.length);
    const totalUnits = exams.reduce((sum, e) => sum + (Number(e.unit) || 0), 0);
    setText("exUnits", totalUnits);
    const scheduled = exams.filter((e) => e.date && e.time).length;
    setText("exScheduled", scheduled);
    setText("exCount", `${exams.length} course${exams.length === 1 ? "" : "s"}`);

    if (!exams.length) {
      tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; color:var(--text-muted); padding:3rem;">
        You have not registered for any courses yet.</td></tr>`;
      return;
    }

    tbody.innerHTML = exams.map((e) => {
      const scheduledStatus = e.date && e.time;
      const statusBadge = scheduledStatus
        ? `<span class="sm-status-badge scheduled"><i class="fas fa-circle-check"></i> Scheduled</span>`
        : `<span class="sm-status-badge pending"><i class="fas fa-clock"></i> Not Scheduled</span>`;
      return `
        <tr>
          <td class="sm-course-code">${e.code}</td>
          <td>${e.title || "—"}</td>
          <td class="sm-course-unit">${e.unit ?? "—"}</td>
          <td>${e.date || "—"}</td>
          <td>${e.time || "—"}</td>
          <td>${e.hall || "—"}</td>
          <td>${statusBadge}</td>
        </tr>`;
    }).join("");
  } catch (err) {
    console.warn("Could not load examinations:", err);
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; color:var(--text-muted); padding:3rem;">
      Could not load your examinations. Please try again.</td></tr>`;
  }
})();

/* ─────────────────────────────────────────
   STUDENT PROFILE SETTINGS
   Editable profile fields + photo. Persisted
   locally (no backend update endpoint exists).
───────────────────────────────────────── */
const PROFILE_KEY = "eipsis_profile_override";

function getProfileOverride() {
  try {
    return JSON.parse(localStorage.getItem(PROFILE_KEY)) || {};
  } catch (_) {
    return {};
  }
}

function setProfileOverride(overrides) {
  try {
    localStorage.setItem(PROFILE_KEY, JSON.stringify(overrides));
  } catch (_) {}
}

function openProfileSettings() {
  const modal = document.getElementById("profileSettingsModal");
  if (!modal) return;
  modal.classList.remove("hidden");
  populateSettingsModal();
}

function closeProfileSettings() {
  const modal = document.getElementById("profileSettingsModal");
  if (modal) modal.classList.add("hidden");
}

function populateSettingsModal() {
  const overrides = getProfileOverride();
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val || ""; };
  set("setFirstName", overrides.firstName || (window.__student || {}).firstName);
  set("setLastName", overrides.lastName || (window.__student || {}).lastName);
  set("setEmail", overrides.email || (window.__student || {}).email);
  set("setPhone", overrides.phone || (window.__student || {}).phone);
  set("setDepartment", overrides.department || (window.__student || {}).department);
  set("setFaculty", overrides.faculty || (window.__student || {}).faculty);
  set("setLevel", overrides.level || (window.__student || {}).level);
  set("setSession", overrides.session || (window.__student || {}).session);

  const img = document.getElementById("settingsPhoto");
  const fallback = document.getElementById("settingsPhotoFallback");
  const photo = overrides.photo || (window.__student || {}).photo;
  if (img && photo) {
    img.src = photo;
    img.classList.add("has-photo");
    if (fallback) fallback.style.display = "none";
  } else if (img && fallback) {
    img.src = "";
    img.classList.remove("has-photo");
    fallback.style.display = "flex";
  }
}

function saveProfileSettings() {
  const overrides = getProfileOverride();
  const read = (id) => { const el = document.getElementById(id); return el ? el.value.trim() : ""; };
  overrides.firstName = read("setFirstName");
  overrides.lastName = read("setLastName");
  overrides.email = read("setEmail");
  overrides.phone = read("setPhone");
  overrides.department = read("setDepartment");
  overrides.faculty = read("setFaculty");
  overrides.level = read("setLevel");
  overrides.session = read("setSession");

  const img = document.getElementById("settingsPhoto");
  if (img && img.classList.contains("has-photo")) overrides.photo = img.src;
  setProfileOverride(overrides);

  // Update the dashboard display immediately.
  const fullName = `${overrides.firstName} ${overrides.lastName}`.trim();
  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  const setText = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  setText("smGreeting", `${greeting}, ${overrides.firstName || fullName.split(" ")[0]}`);
  setText("smPhoneName", fullName || "");

  const dashPhoto = document.getElementById("smPhoto");
  const dashFallback = document.getElementById("smPhotoFallback");
  if (dashPhoto && overrides.photo) {
    dashPhoto.src = overrides.photo;
    dashPhoto.classList.add("has-photo");
    if (dashFallback) dashFallback.style.display = "none";
  }

  closeProfileSettings();
  showToast("Profile settings saved successfully.", "success");
}

function removeSettingsPhoto() {
  const img = document.getElementById("settingsPhoto");
  const fallback = document.getElementById("settingsPhotoFallback");
  if (img) {
    img.src = "";
    img.classList.remove("has-photo");
  }
  if (fallback) fallback.style.display = "flex";
  const input = document.getElementById("settingsPhotoInput");
  if (input) input.value = "";
}

(function initSettingsPhotoUpload() {
  const input = document.getElementById("settingsPhotoInput");
  if (!input) return;
  input.addEventListener("change", () => {
    const file = input.files && input.files[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      showToast("Please choose an image file.", "danger");
      input.value = "";
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = document.getElementById("settingsPhoto");
      const fallback = document.getElementById("settingsPhotoFallback");
      if (img) {
        img.src = e.target.result;
        img.classList.add("has-photo");
      }
      if (fallback) fallback.style.display = "none";
    };
    reader.readAsDataURL(file);
  });
})();

(function storeStudentForSettings() {
  // The dashboard init already exposes window.__student; this block is only
  // here for pages that include the settings modal without the dashboard.
  const modal = document.getElementById("profileSettingsModal");
  if (!modal || window.__student) return;
  (async () => {
    const student = await requireLogin();
    if (student) window.__student = student;
  })();
})();

/* ─────────────────────────────────────────
   11. ADMIN HELPERS — search/filter/select/view
───────────────────────────────────────── */
function filterStudents(query) {
  const rows = document.querySelectorAll("#studentTbody tr");
  const q = query.toLowerCase();
  rows.forEach((row) => {
    const text = row.textContent.toLowerCase();
    row.style.display = text.includes(q) ? "" : "none";
  });
}

function toggleAll(masterCb) {
  document.querySelectorAll("#studentTbody input[type='checkbox']").forEach((cb) => (cb.checked = masterCb.checked));
}

function viewStudent(name) {
  const modal = document.getElementById("viewModal");
  const nameEl = document.getElementById("modalStudentName");
  if (modal) modal.classList.remove("hidden");
  if (nameEl) nameEl.textContent = name;
}

async function deleteStudent(btn) {
  if (!confirm("Are you sure you want to delete this student record?")) return;
  const row = btn.closest("tr");
  const matric = row ? row.dataset.matric : null;
  if (matric) {
    try {
      await apiAdminDeleteStudent(matric);
      showToast("Student record deleted.", "danger");
    } catch (err) {
      showToast(err.message || "Could not delete student.", "danger");
      return;
    }
  }
  if (row) row.remove();
}

function resolveAlert(btn) {
  const item = btn.closest(".alert-item");
  if (!item) return;
  item.style.transition = "opacity .4s";
  item.style.opacity = "0";
  setTimeout(() => item.remove(), 400);
  showToast("Alert resolved.", "success");
}

/* ─────────────────────────────────────────
   12. EXPORT CSV — real data from the backend
───────────────────────────────────────── */
async function exportCSV() {
  let students;
  try {
    students = await apiAdminStudents();
  } catch (err) {
    showToast(err.message || "Could not load students.", "danger");
    return;
  }

  const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  let csv = "Matric No.,Name,Department,Level,Courses Registered,Fingerprint Enrolled,Face Enrolled\n";
  students.forEach((s) => {
    csv += [
      esc(s.matric),
      esc(`${s.firstName || ""} ${s.lastName || ""}`.trim()),
      esc(s.department),
      esc(s.level),
      (s.registeredCourses || []).length,
      s.fingerprintCredentialId ? "Yes" : "No",
      s.faceDescriptor ? "Yes" : "No",
    ].join(",") + "\n";
  });

  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "eips_students.csv";
  a.click();
  URL.revokeObjectURL(url);
  showToast("CSV exported successfully.", "success");
}

/* ─────────────────────────────────────────
   13. TOAST NOTIFICATION
───────────────────────────────────────── */
function showToast(message, type = "success") {
  document.querySelectorAll(".eips-toast").forEach((t) => t.remove());

  const colors = {
    success: "var(--success)",
    danger: "var(--danger)",
    warning: "var(--warning)",
    info: "var(--primary)",
  };
  const icons = {
    success: "fa-circle-check",
    danger: "fa-circle-xmark",
    warning: "fa-triangle-exclamation",
    info: "fa-circle-info",
  };

  const toast = document.createElement("div");
  toast.className = "eips-toast";
  toast.innerHTML = `<i class="fas ${icons[type] || icons.info}"></i> ${message}`;

  Object.assign(toast.style, {
    position: "fixed",
    bottom: "2.4rem",
    right: "2.4rem",
    background: "#fff",
    color: "#16372c",
    border: `1px solid ${colors[type]}`,
    borderLeft: `4px solid ${colors[type]}`,
    borderRadius: "10px",
    padding: "1.2rem 2rem",
    fontSize: "1.4rem",
    display: "flex",
    alignItems: "center",
    gap: "1rem",
    zIndex: "99999",
    boxShadow: "0 8px 24px rgba(0,0,0,0.15)",
    animation: "toastIn .3s ease",
    maxWidth: "36rem",
  });

  toast.querySelector("i").style.color = colors[type];

  if (!document.getElementById("toast-style")) {
    const s = document.createElement("style");
    s.id = "toast-style";
    s.textContent = `
      @keyframes toastIn {
        from { opacity: 0; transform: translateY(1.5rem); }
        to   { opacity: 1; transform: translateY(0); }
      }
    `;
    document.head.appendChild(s);
  }

  document.body.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transition = "opacity .4s";
    setTimeout(() => toast.remove(), 400);
  }, 3500);
}

/* ─────────────────────────────────────────
   14. CLOSE MODALS ON OVERLAY CLICK
───────────────────────────────────────── */
document.querySelectorAll(".modal-overlay").forEach((overlay) => {
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.classList.add("hidden");
  });
});

/* ─────────────────────────────────────────
   15. RESET SCROLL ON PAGE LOAD
   Disable the browser's scroll-position restore
   so a refresh always opens at the top of the page
   (unless an explicit #hash anchor is requested).
───────────────────────────────────────── */
if ("scrollRestoration" in history) {
  history.scrollRestoration = "manual";
}
window.addEventListener("pageshow", () => {
  if (!window.location.hash) {
    window.scrollTo(0, 0);
  }
});
