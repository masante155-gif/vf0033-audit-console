// Railway's Free/Trial/Hobby plans block outbound SMTP entirely (anti-spam
// measure), so email is sent through Resend's HTTPS API instead of SMTP —
// this works on every Railway plan since it's a plain HTTPS request.
// https://docs.railway.com/networking/outbound-networking#email-delivery

function isConfigured() {
  return !!process.env.RESEND_API_KEY;
}

async function sendMail({ to, subject, text, html }) {
  if (!isConfigured()) {
    throw new Error(
      "Email sending isn't configured yet. Set RESEND_API_KEY (and optionally MAIL_FROM) in the server's environment variables."
    );
  }

  const from = process.env.MAIL_FROM || "onboarding@resend.dev";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  let res;
  try {
    res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + process.env.RESEND_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from, to: [to], subject, text, html }),
      signal: controller.signal,
    });
  } catch (e) {
    if (e.name === "AbortError") {
      throw new Error("Timed out reaching the email service — try again in a moment.");
    }
    throw new Error("Couldn't reach the email service: " + e.message);
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    let detail = "";
    try {
      const body = await res.json();
      detail = body && body.message ? body.message : JSON.stringify(body);
    } catch (e) {
      detail = res.statusText;
    }
    throw new Error("Email service rejected the request: " + detail);
  }
}

module.exports = { sendMail, isConfigured };
