// Sends the password-reset OTP by email when SMTP is configured via
// environment variables (SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, and
// optionally SMTP_FROM). This app is designed to run entirely offline on a
// school LAN, so when SMTP isn't configured — the default — the OTP is
// logged to the server console instead. Whoever is running the server (the
// principal) can then read it there and relay it to the teacher, so
// password reset keeps working with no internet connection required.

let transporter = null;
let attemptedInit = false;

function getTransporter() {
  if (attemptedInit) return transporter;
  attemptedInit = true;
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) return null;
  try {
    const nodemailer = require("nodemailer");
    transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: Number(SMTP_PORT) || 587,
      secure: Number(SMTP_PORT) === 465,
      auth: { user: SMTP_USER, pass: SMTP_PASS }
    });
  } catch (e) {
    console.warn("SMTP configured but nodemailer failed to initialize:", e.message);
    transporter = null;
  }
  return transporter;
}

async function sendOtpEmail(toEmail, otp, teacherName) {
  const t = getTransporter();
  if (!t) {
    console.log(`\n[Password Reset OTP] ${teacherName} <${toEmail}>: ${otp}  (valid 10 minutes)`);
    console.log("SMTP is not configured (set SMTP_HOST/SMTP_USER/SMTP_PASS to send real emails) — relay this code to the teacher directly.\n");
    return { delivered: false };
  }
  await t.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: toEmail,
    subject: "Your password reset code — Teacher Appraisal System",
    text: `Hi ${teacherName},\n\nYour password reset code is: ${otp}\n\nThis code expires in 10 minutes. If you didn't request this, you can ignore this email.`
  });
  return { delivered: true };
}

module.exports = { sendOtpEmail };
