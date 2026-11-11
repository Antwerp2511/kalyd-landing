// Kalyd website contact form → Supabase table "leads" + email to the admin inbox via Zoho.
// Runs as a Vercel Function in Frankfurt (see vercel.json).
//
// Environment variables (Vercel → Settings → Environment Variables):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   added by the Supabase integration
//   ZOHO_APP_PASSWORD                         Zoho app password for the admin mailbox (you add it)
//   ZOHO_USER        optional, default admin@mail.kalyd.app
//   ZOHO_SMTP_HOST   optional, default smtp.zoho.eu (use smtp.zoho.com for a zoho.com account)
//   LEADS_TO         optional, where notifications go, default = ZOHO_USER

const nodemailer = require('nodemailer');

const LIMITS = {
  name: 200, email: 320, company: 200, role: 100, company_type: 100,
  fleet: 50, orders_week: 50, channels: 300, description: 4000, source: 20, lang: 5,
};
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// small in-memory rate limit per IP (resets when the function instance restarts)
const hits = new Map();
function tooMany(ip) {
  const now = Date.now(), win = 10 * 60 * 1000, max = 5;
  const list = (hits.get(ip) || []).filter(t => now - t < win);
  list.push(now);
  hits.set(ip, list);
  return list.length > max;
}

function clean(v, max) {
  if (Array.isArray(v)) v = v.join(', ');
  if (v === undefined || v === null) return null;
  v = String(v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return v ? v.slice(0, max) : null;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function saveLead(lead) {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Supabase is not configured');
  const r = await fetch(`${url}/rest/v1/leads`, {
    method: 'POST',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(lead),
  });
  if (!r.ok) throw new Error(`Supabase insert failed: ${r.status} ${await r.text()}`);
  const [row] = await r.json();
  return row;
}

async function markSent(id) {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  await fetch(`${url}/rest/v1/leads?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email_sent: true }),
  });
}

async function sendMail(lead) {
  const user = process.env.ZOHO_USER || 'admin@mail.kalyd.app';
  const pass = process.env.ZOHO_APP_PASSWORD;
  if (!pass) throw new Error('ZOHO_APP_PASSWORD is not set');
  const transport = nodemailer.createTransport({
    host: process.env.ZOHO_SMTP_HOST || 'smtp.zoho.eu',
    port: 465,
    secure: true,
    auth: { user, pass },
  });
  const rows = [
    ['Type', lead.source], ['Name', lead.name], ['Email', lead.email], ['Company', lead.company],
    ['Role', lead.role], ['Company type', lead.company_type], ['Fleet size', lead.fleet],
    ['Orders per week', lead.orders_week], ['How orders arrive', lead.channels],
    ['Notes', lead.description], ['Language', lead.lang],
  ].filter(([, v]) => v);
  const text = rows.map(([k, v]) => `${k}: ${v}`).join('\n');
  const html = `<table cellpadding="6" style="font:14px/1.5 sans-serif;border-collapse:collapse">${
    rows.map(([k, v]) => `<tr><td style="color:#666;vertical-align:top">${esc(k)}</td><td>${esc(v).replace(/\n/g, '<br>')}</td></tr>`).join('')
  }</table>`;
  await transport.sendMail({
    from: `"Kalyd website" <${user}>`,
    to: process.env.LEADS_TO || user,
    replyTo: lead.email,
    subject: `New ${lead.source || 'website'} request: ${lead.name}${lead.company ? ', ' + lead.company : ''}`,
    text,
    html,
  });
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'method' });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = null; } }
  if (!body || typeof body !== 'object') return res.status(400).json({ ok: false, error: 'bad_request' });

  // spam traps: a hidden field people never fill, and a form filled faster than a human can
  if (body.website) return res.status(200).json({ ok: true });
  const openedFor = Number(body.t) ? Date.now() - Number(body.t) : null;
  if (openedFor !== null && openedFor < 2500) return res.status(200).json({ ok: true });

  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (tooMany(ip)) return res.status(429).json({ ok: false, error: 'rate_limited' });

  const lead = {};
  for (const [k, max] of Object.entries(LIMITS)) lead[k] = clean(body[k], max);
  if (!lead.name || !lead.email || !EMAIL_RE.test(lead.email)) {
    return res.status(422).json({ ok: false, error: 'invalid' });
  }
  if (lead.source === 'free pilot') lead.source = 'pilot';
  if (lead.source && !['demo', 'pilot'].includes(lead.source)) lead.source = null;

  let row;
  try {
    row = await saveLead(lead);
  } catch (err) {
    console.error('[contact] save failed', err.message);
    // still try to email so the request is not lost
    try { await sendMail(lead); return res.status(200).json({ ok: true }); }
    catch (mailErr) { console.error('[contact] mail failed', mailErr.message); }
    return res.status(500).json({ ok: false, error: 'server' });
  }

  try {
    await sendMail(lead);
    await markSent(row.id);
  } catch (err) {
    // the lead is safe in the database; the email can be resent later
    console.error('[contact] mail failed', err.message);
  }
  return res.status(200).json({ ok: true });
};
