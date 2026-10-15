const fs = require("fs");
let s = fs.readFileSync("api.js", "utf8");
const before = s;

s = s.replace(
  'const registrations = db.db.prepare("SELECT matric FROM course_registrations WHERE course_code = ?").all(code);',
  'const registrations = await db.getRegisteredStudents(code);'
);

let wrapped = 0;
s = s.replace(
  /(app\.(?:get|post|put|delete)\("[^"]+",\s*auth(?:Student|Admin),)\s*\(req, res\) =>/g,
  (m, g1) => {
    wrapped++;
    return g1 + " wrap(async (req, res) =>";
  }
);

const methods = ["studentExists","getStudent","getStudentRaw","allStudents","createStudent","updateStudent","deleteStudent","allCourses","getCourse","insertCourse","updateCourse","deleteCourse","getRegisteredCourses","getRegisteredStudents","replaceRegistrations","getExamSelection","setExamSelection","setExamSchedule","getExamSchedule","allExamSchedules","deleteExamSchedule","getSeat","allSeats","hasRecentFingerprintPass","allocateSeat","logVerification","getVerificationLog","verificationStats","clearVerificationLog","clearAllData","getAdmin","createAdmin","verifyAdminCredentials","createOtp","verifyOtp","createNotification","getNotifications","getUnreadCount","markAsRead","markAllAsRead","clearNotifications","notifyAllStudents","getCarryOvers","addCarryOver","removeCarryOver","publicStudent"];
const re = new RegExp("\\bdb\\.(" + methods.join("|") + ")\\b\\(", "g");
let awaited = 0;
s = s.replace(re, (m, g1) => {
  awaited++;
  return "await db." + g1 + "(";
});

fs.writeFileSync("api.js", s);
console.log("handlers wrapped:", wrapped);
console.log("await injected:", awaited);
console.log("changed:", before !== s);
