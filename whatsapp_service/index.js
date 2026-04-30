/**
 * whatsapp_service/index.js
 * ─────────────────────────────────────────────────────────────
 * Baileys-based WhatsApp sender — exposes a small REST API
 * so the Python FastAPI backend can trigger sends/receive webhooks.
 *
 * One process per WA number. Run multiple instances on different ports
 * if you have multiple numbers (or let Python spawn them).
 *
 * API:
 *   GET  /status          → { ready, number, qr? }
 *   POST /send            → { to, message }
 *   POST /webhook-url     → { url }   (set Python webhook endpoint)
 *   GET  /qr              → { qr }    (base64 QR to scan)
 */

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeInMemoryStore,
  jidNormalizedUser,
} = require("@whiskeysockets/baileys");

const express  = require("express");
const pino     = require("pino");
const qrcode   = require("qrcode");
const axios    = require("axios");
const path     = require("path");
const fs       = require("fs");

// ── Config ────────────────────────────────────────────
const PORT         = parseInt(process.env.PORT || process.env.WA_PORT || "3001");
const NUMBER_ID    = process.env.WA_NUMBER_ID       || "default";   // unique ID for this number
const AUTH_DIR     = process.env.WA_AUTH_DIR        || `./auth_${NUMBER_ID}`;
const PYTHON_API   = process.env.PYTHON_API_URL     || "http://localhost:8000";
const INTERNAL_KEY = process.env.INTERNAL_KEY       || "changeme";  // shared secret

// ── State ─────────────────────────────────────────────
let sock        = null;
let latestQR    = null;
let isReady     = false;
let myNumber    = null;
let webhookUrl  = `${PYTHON_API}/whatsapp/incoming`;

const logger = pino({ level: "silent" });   // silence Baileys noise
const store  = makeInMemoryStore({ logger });

// ── Express app ───────────────────────────────────────
const app = express();
app.use(express.json());

// Auth middleware
app.use((req, res, next) => {
  if (req.headers["x-internal-key"] !== INTERNAL_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
});

app.get("/status", (req, res) => {
  res.json({ ready: isReady, number: myNumber, number_id: NUMBER_ID, has_qr: !!latestQR });
});

app.get("/qr", async (req, res) => {
  if (!latestQR) return res.json({ qr: null, message: isReady ? "Already connected" : "No QR yet, starting..." });
  try {
    const dataUrl = await qrcode.toDataURL(latestQR);
    res.json({ qr: dataUrl });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/send", async (req, res) => {
  const { to, message } = req.body;
  if (!to || !message) return res.status(400).json({ error: "to and message required" });
  if (!isReady)         return res.status(503).json({ error: "WhatsApp not connected" });

  try {
    // Normalize number → JID
    const jid = formatJID(to);
    await sock.sendMessage(jid, { text: message });
    console.log(`✅ Sent to ${jid}`);
    res.json({ ok: true, jid });
  } catch (e) {
    console.error(`❌ Send failed: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

app.post("/webhook-url", (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "url required" });
  webhookUrl = url;
  res.json({ ok: true, webhook_url: webhookUrl });
});

// ── Baileys connection ─────────────────────────────────
async function connectWA() {
  if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version }          = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    logger,
    auth: state,
    printQRInTerminal: true,
    browser: ["Titan Forger", "Chrome", "1.0.0"],
    syncFullHistory: false,
    markOnlineOnConnect: false,
  });

  store.bind(sock.ev);

  // ── QR / connection events ─────────────────────────
  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      latestQR = qr;
      isReady  = false;
      console.log(`📱 [${NUMBER_ID}] QR updated — scan at GET /qr`);
    }

    if (connection === "open") {
      latestQR = null;
      isReady  = true;
      myNumber = jidNormalizedUser(sock.user.id).replace("@s.whatsapp.net", "");
      console.log(`✅ [${NUMBER_ID}] Connected as ${myNumber}`);

      // Notify Python backend that this number is online
      try {
        await axios.post(`${PYTHON_API}/whatsapp/number-online`, {
          number_id: NUMBER_ID,
          phone: myNumber,
        }, { headers: { "x-internal-key": INTERNAL_KEY }, timeout: 5000 });
      } catch (_) {}
    }

    if (connection === "close") {
      isReady = false;
      const code = lastDisconnect?.error?.output?.statusCode;
      console.log(`🔌 [${NUMBER_ID}] Disconnected (${code})`);

      if (code === DisconnectReason.loggedOut) {
        console.log("Logged out — delete auth folder and restart to re-scan.");
        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
      } else {
        // Auto-reconnect after 5s
        setTimeout(connectWA, 5000);
      }
    }
  });

  sock.ev.on("creds.update", saveCreds);

  // ── Incoming messages ──────────────────────────────
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      if (msg.key.fromMe) continue;              // ignore our own messages
      if (!msg.message)   continue;

      const from    = msg.key.remoteJid;
      const text    = extractText(msg);
      if (!text) continue;

      const phone   = from.replace("@s.whatsapp.net", "").replace("@g.us", "");
      console.log(`📨 [${NUMBER_ID}] Message from ${phone}: ${text.slice(0, 60)}`);

      // Mark as read
      try { await sock.readMessages([msg.key]); } catch (_) {}

      // Forward to Python backend
      try {
        await axios.post(webhookUrl, {
          number_id:   NUMBER_ID,
          from_phone:  phone,
          message:     text,
          timestamp:   new Date().toISOString(),
          wa_jid:      from,
        }, { headers: { "x-internal-key": INTERNAL_KEY }, timeout: 10000 });
      } catch (e) {
        console.error(`❌ Webhook failed: ${e.message}`);
      }
    }
  });
}

// ── Helpers ───────────────────────────────────────────
function formatJID(phone) {
  // Strip everything except digits
  const digits = phone.replace(/\D/g, "");
  // Ensure country code included
  return `${digits}@s.whatsapp.net`;
}

function extractText(msg) {
  const m = msg.message;
  return (
    m?.conversation ||
    m?.extendedTextMessage?.text ||
    m?.imageMessage?.caption ||
    m?.videoMessage?.caption ||
    ""
  );
}

// ── Start ─────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 [${NUMBER_ID}] WhatsApp service on port ${PORT}`);
  connectWA();
});
