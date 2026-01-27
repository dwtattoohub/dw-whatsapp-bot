// ============================================================
// DW WhatsApp Bot — Versão AGENTE (GPT-4o) + Antiduplicação real
// - fs/promises
// - Sem reset do store no boot
// - Idempotência por messageId (TTL) + fallback por fingerprint (quando messageId vem vazio)
// - ✅ In-flight guards (evita corrida entre webhooks simultâneos)
// - Lock por telefone (evita paralelo)
// - Fluxo com botões conforme combinado
// - ✅ NOVO: Referência + local = suficiente (tamanho é opcional)
// - ✅ NOVO: Descreve a imagem (texto técnico) + estima horas com o AGENTE
// - ✅ NOVO: Preço calculado por regra: 1ª hora R$150, demais R$100
// - ✅ NOVO: Cache de mídia por telefone (quando imagem e texto chegam em webhooks separados)
// ============================================================

import express from "express";
import crypto from "crypto";
import OpenAI from "openai";
import fsp from "fs/promises";f

const app = express();
app.use(express.json({ limit: "25mb" }));

// -------------------- ENV --------------------
const ENV = {
  PORT: Number(process.env.PORT || 10000),

  // Z-API
  ZAPI_INSTANCE_ID: process.env.ZAPI_INSTANCE_ID,
  ZAPI_INSTANCE_TOKEN: process.env.ZAPI_INSTANCE_TOKEN,
  ZAPI_CLIENT_TOKEN: process.env.ZAPI_CLIENT_TOKEN,

  // Owner (handoff)
  OWNER_PHONE: process.env.OWNER_PHONE || "5544991373995",

  // OpenAI
  OPENAI_API_KEY: process.env.OPENAI_API_KEY || "",
  OPENAI_MODEL: process.env.OPENAI_MODEL || "gpt-4o",

  // Store
  STORE_PATH: process.env.STORE_PATH || "./dw_store.json",
  IDEMPOTENCY_TTL_HOURS: Number(process.env.IDEMPOTENCY_TTL_HOURS || 48),

  // Preço (regra fixa)
  HOUR_FIRST: Number(process.env.HOUR_FIRST || 150), // ✅ 150 primeira hora
  HOUR_NEXT: Number(process.env.HOUR_NEXT || 100),   // ✅ 100 demais horas

  // PIX + sinal
  PIX_KEY: process.env.PIX_KEY || "",
  SIGNAL_VALUE: Number(process.env.SIGNAL_VALUE || 50),
  SIGNAL_DEADLINE_HOURS: Number(process.env.SIGNAL_DEADLINE_HOURS || 4),

  // System prompt opcional
  AGENT_SYSTEM_PROMPT: process.env.AGENT_SYSTEM_PROMPT || "",

  // Cache de mídia (minutos)
  MEDIA_CACHE_TTL_MIN: Number(process.env.MEDIA_CACHE_TTL_MIN || 20),
};

function missingEnvs() {
  const miss = [];
  if (!ENV.ZAPI_INSTANCE_ID) miss.push("ZAPI_INSTANCE_ID");
  if (!ENV.ZAPI_INSTANCE_TOKEN) miss.push("ZAPI_INSTANCE_TOKEN");
  if (!ENV.ZAPI_CLIENT_TOKEN) miss.push("ZAPI_CLIENT_TOKEN");
  if (!ENV.OPENAI_API_KEY) miss.push("OPENAI_API_KEY");
  return miss;
}

// -------------------- OpenAI --------------------
const openai = new OpenAI({ apiKey: ENV.OPENAI_API_KEY });

// -------------------- STORE --------------------
const STORE = {
  sessions: {},     // phone -> session
  processed: {},    // messageId -> { at, phone }
  processedFp: {},  // fingerprint -> { at, phone }
};

const saveDebounce = { t: null };

async function loadStore() {
  try {
    const raw = await fsp.readFile(ENV.STORE_PATH, "utf8");
    const data = JSON.parse(raw);
    STORE.sessions = data.sessions || {};
    STORE.processed = data.processed || {};
    STORE.processedFp = data.processedFp || {};
  } catch {
    // primeira execução
  }
}

function scheduleSaveStore() {
  if (saveDebounce.t) return;
  saveDebounce.t = setTimeout(async () => {
    saveDebounce.t = null;
    try {
      await fsp.writeFile(
        ENV.STORE_PATH,
        JSON.stringify(
          { sessions: STORE.sessions, processed: STORE.processed, processedFp: STORE.processedFp },
          null,
          2
        ),
        "utf8"
      );
    } catch (e) {
      console.error("[STORE SAVE ERROR]", e?.message || e);
    }
  }, 250);
}

function nowMs() {
  return Date.now();
}

function cleanupProcessed() {
  const ttl = ENV.IDEMPOTENCY_TTL_HOURS * 60 * 60 * 1000;
  const cut = nowMs() - ttl;

  for (const [id, v] of Object.entries(STORE.processed)) {
    if (!v?.at || v.at < cut) delete STORE.processed[id];
  }
  for (const [fp, v] of Object.entries(STORE.processedFp)) {
    if (!v?.at || v.at < cut) delete STORE.processedFp[fp];
  }
}

function wasProcessed(msgId) {
  if (!msgId) return false;
  const v = STORE.processed[msgId];
  if (!v?.at) return false;
  const ttl = ENV.IDEMPOTENCY_TTL_HOURS * 60 * 60 * 1000;
  return v.at >= nowMs() - ttl;
}

function markProcessed(msgId, phone) {
  if (!msgId) return;
  STORE.processed[msgId] = { at: nowMs(), phone };
  scheduleSaveStore();
}

// fingerprint idempotência
function fpHash(s) {
  return crypto.createHash("sha1").update(String(s)).digest("hex");
}
function makeFingerprint(inbound) {
  const base = [
    inbound.phone || "",
    inbound.buttonId || "",
    inbound.message || "",
    inbound.imageUrl || "",
    inbound.imageCacheKey || "",
    inbound.imageBase64 ? "has_b64" : "",
    inbound.raw?.timestamp || inbound.raw?.data?.timestamp || inbound.raw?.t || ""
  ].join("|");
  return fpHash(base);
}
function wasProcessedFp(fp) {
  if (!fp) return false;
  const v = STORE.processedFp[fp];
  if (!v?.at) return false;
  const ttl = ENV.IDEMPOTENCY_TTL_HOURS * 60 * 60 * 1000;
  return v.at >= nowMs() - ttl;
}
function markProcessedFp(fp, phone) {
  if (!fp) return;
  STORE.processedFp[fp] = { at: nowMs(), phone };
  scheduleSaveStore();
}

// -------------------- SESSIONS --------------------
function newSession() {
  return {
    stage: "start",
    lastSentHash: "",
    lastMenuAt: 0,
    agentContext: [],
    data: {
      name: "",
      bodyPart: "",
      sizeCm: null,              // opcional
      referenceImageUrl: "",
      referenceImageBase64: "",  // opcional
      changeNotes: "",
      imageSummary: "",
      imageSummaryAt: null,
      estHours: null,
      estTotal: null,
      chosenSchedule: "",
      wantsSchedule: false,
      signalSentAt: null,
      receiptReceived: false,
    },
  };
}

function getSession(phone) {
  if (!STORE.sessions[phone]) {
    STORE.sessions[phone] = newSession();
    scheduleSaveStore();
  }
  return STORE.sessions[phone];
}

function resetSession(phone) {
  STORE.sessions[phone] = newSession();
  scheduleSaveStore();
}

// -------------------- LOCK por telefone --------------------
const PHONE_LOCKS = new Map();
async function withPhoneLock(phone, fn) {
  const prev = PHONE_LOCKS.get(phone) || Promise.resolve();
  let release;
  const cur = new Promise((r) => (release = r));
  PHONE_LOCKS.set(phone, prev.then(() => cur));

  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (PHONE_LOCKS.get(phone) === cur) PHONE_LOCKS.delete(phone);
  }
}

// ✅ In-flight guards (evita corrida entre webhooks simultâneos)
const INFLIGHT_MSG = new Set(); // messageId
const INFLIGHT_FP = new Set();  // fingerprint

// -------------------- UTIL --------------------
function hash(t) {
  return crypto.createHash("md5").update(String(t)).digest("hex");
}
function antiRepeat(session, text) {
  const h = hash(text);
  if (session.lastSentHash === h) return true;
  session.lastSentHash = h;
  scheduleSaveStore();
  return false;
}
function norm(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}
function safeName(name) {
  const n = String(name || "").trim();
  if (!n) return "";
  if (/undefined|null|unknown/i.test(n)) return "";
  return n.length > 24 ? n.slice(0, 24) : n;
}
function parseSizeCm(text) {
  const t = norm(text);
  let m = t.match(/(\d{1,2})\s*(cm|centimetros|centimetro)\b/);
  if (m) {
    const n = parseInt(m[1], 10);
    if (n >= 1 && n <= 60) return n;
  }
  const hasContext = /\b(tamanho|aprox|aproximado|uns|cerca|medida)\b/.test(t);
  if (hasContext) {
    m = t.match(/\b(\d{1,2})\b/);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n >= 1 && n <= 60) return n;
    }
  }
  return null;
}
function parseBodyPart(text) {
  const t = norm(text);
  const parts = [
    { r: /antebraco/, v: "antebraço" },
    { r: /\bbraco\b/, v: "braço" },
    { r: /\bombro\b/, v: "ombro" },
    { r: /\bcostas\b/, v: "costas" },
    { r: /\bpeito\b/, v: "peito" },
    { r: /\bperna\b/, v: "perna" },
    { r: /\bpanturrilha\b/, v: "panturrilha" },
    { r: /\bcanela\b/, v: "canela" },
    { r: /\bcoxa\b/, v: "coxa" },
    { r: /\bjoelho\b/, v: "joelho" },
    { r: /\bcostela\b/, v: "costela" },
    { r: /\bpescoco\b/, v: "pescoço" },
    { r: /\bmao\b/, v: "mão" },
    { r: /\bpunho\b/, v: "punho" },
    { r: /\bdedo\b/, v: "dedo" },
    { r: /\bpe\b/, v: "pé" },
    { r: /\btornozelo\b/, v: "tornozelo" },
    { r: /\bnuca\b/, v: "nuca" },
    { r: /\bescapula\b/, v: "escápula" },
  ];
  for (const p of parts) if (p.r.test(t)) return p.v;
  return null;
}
function calcTotalFromHours(hours) {
  const h = Math.max(1, Number(hours || 1));
  const first = ENV.HOUR_FIRST;
  const rest = Math.max(0, h - 1) * ENV.HOUR_NEXT;
  return Math.round(first + rest);
}

// -------------------- CACHE DE MÍDIA (quando webhooks chegam separados) --------------------
const MEDIA_CACHE = new Map(); // phone -> { imageUrl, imageBase64, at }
function mediaCacheCleanup() {
  const ttl = ENV.MEDIA_CACHE_TTL_MIN * 60 * 1000;
  const cut = nowMs() - ttl;
  for (const [phone, v] of MEDIA_CACHE.entries()) {
    if (!v?.at || v.at < cut) MEDIA_CACHE.delete(phone);
  }
}
function setMediaCache(phone, { imageUrl, imageBase64 }) {
  if (!phone) return;
  MEDIA_CACHE.set(phone, { imageUrl: imageUrl || "", imageBase64: imageBase64 || "", at: nowMs() });
}
function getMediaCache(phone) {
  mediaCacheCleanup();
  return MEDIA_CACHE.get(phone) || null;
}

// ============================================================================
// ✅ AGENTE: descreve imagem + estima horas (tamanho opcional)
// ============================================================================

function summarizeToBullets(summary) {
  const s = String(summary || "").trim();
  if (!s) return "";
  const parts = s
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(0, 5);
  if (parts.length === 0) return "";
  return parts.map((p) => `• ${p.replace(/[.]+$/g, "")}`).join("\n");
}

async function fetchAsDataUrl(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`fetch image failed: ${resp.status}`);
  const ct = resp.headers.get("content-type") || "image/jpeg";
  const ab = await resp.arrayBuffer();
  const b64 = Buffer.from(ab).toString("base64");
  return `data:${ct};base64,${b64}`;
}

function safeJsonParse(raw) {
  const s = String(raw || "").trim();
  const noFences = s.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim();
  try {
    return JSON.parse(noFences);
  } catch {}
  const start = noFences.indexOf("{");
  const end = noFences.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const chunk = noFences.slice(start, end + 1);
    try {
      return JSON.parse(chunk);
    } catch {}
  }
  return null;
}

async function analyzeAndEstimate({ imageUrl, imageBase64, bodyPart, sizeCm, changeNotes }) {
  // retorna { summaryText, estHours }
  const prompt =
    "Você é um tatuador especialista em realismo preto e cinza.\n" +
    "Analise a referência e responda APENAS em JSON válido com este schema:\n\n" +
    "{\n" +
    '  "summary": "texto curto e técnico em português (sem preço)",\n' +
    '  "estHours": 2.5\n' +
    "}\n\n" +
    "Regras:\n" +
    "- summary: explicar objetivamente o que existe na referência (elementos, sombras/contraste, texturas, pontos críticos).\n" +
    "- estHours: estimativa realista em horas para executar bem (acabamento limpo), considerando o local informado.\n" +
    "- Se sizeCm estiver vazio, estime um tamanho coerente pro local baseado na composição (não precisa escrever o tamanho; só use pra estimar horas).\n" +
    "- Se changeNotes existir, considere mais tempo.\n" +
    "- Não invente firula, mas agregue valor técnico.\n";

  let imgInput = imageUrl || "";
  if (!imgInput && imageBase64) imgInput = imageBase64;

  // se tiver URL mas OpenAI não conseguir buscar, cai pro base64
  const tryCall = async (finalUrl) => {
    const completion = await openai.chat.completions.create({
      model: ENV.OPENAI_MODEL,
      temperature: 0.2,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt + `\nDados:\nlocal=${bodyPart || ""}\nsizeCm=${sizeCm || ""}\nchangeNotes=${changeNotes || ""}` },
            { type: "image_url", image_url: { url: finalUrl } },
          ],
        },
      ],
    });
    return completion.choices?.[0]?.message?.content || "";
  };

  try {
    if (!imgInput) return { summaryText: "", estHours: 2.0 };

    let raw = "";
    if (imgInput.startsWith("data:")) {
      raw = await tryCall(imgInput);
    } else {
      try {
        raw = await tryCall(imgInput);
      } catch {
        const dataUrl = await fetchAsDataUrl(imgInput);
        raw = await tryCall(dataUrl);
      }
    }

    const parsed = safeJsonParse(raw) || {};
    const summaryText = String(parsed.summary || "").trim();
    const estHours = Number(parsed.estHours || 0);

    return {
      summaryText,
      estHours: Number.isFinite(estHours) && estHours > 0 ? Math.max(1, Number(estHours.toFixed(1))) : 2.0,
    };
  } catch (e) {
    console.error("[AGENT IMAGE ESTIMATE ERROR]", e?.message || e);
    return { summaryText: "", estHours: 2.0 };
  }
}

// -------------------- Z-API HELPERS --------------------
async function zapiFetch(p, payload) {
  const url = `https://api.z-api.io/instances/${ENV.ZAPI_INSTANCE_ID}/token/${ENV.ZAPI_INSTANCE_TOKEN}${p}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "client-token": ENV.ZAPI_CLIENT_TOKEN,
    },
    body: JSON.stringify(payload || {}),
  });
  const text = await resp.text().catch(() => "");
  if (!resp.ok) throw new Error(`ZAPI ${resp.status}: ${text}`);
  try {
    return JSON.parse(text);
  } catch {
    return { ok: true, raw: text };
  }
}

async function humanDelay() {
  await new Promise((r) => setTimeout(r, 900 + Math.random() * 650));
}

async function sendText(phone, message) {
  await humanDelay();
  return zapiFetch("/send-text", { phone, message });
}

async function sendTextOnce(phone, session, message) {
  if (!message) return;
  if (antiRepeat(session, message)) return;
  return sendText(phone, message);
}

async function sendButtons(phone, text, buttons, label = "menu") {
  await humanDelay();

  try {
    await zapiFetch("/send-button-list", {
      phone,
      message: text,
      buttonList: {
        title: label,
        buttons: buttons.map((b) => ({ id: b.id, label: b.title })),
      },
    });
    return true;
  } catch {}

  try {
    await zapiFetch("/send-buttons", {
      phone,
      message: text,
      buttons: buttons.map((b) => ({ id: b.id, title: b.title })),
    });
    return true;
  } catch {}

  let fb = `${text}\n\n`;
  buttons.forEach((b, i) => (fb += `${i + 1}) ${b.title}\n`));
  await sendText(phone, fb.trim());
  return false;
}

async function notifyOwner(text) {
  if (!ENV.OWNER_PHONE) return;
  try {
    await zapiFetch("/send-text", { phone: ENV.OWNER_PHONE, message: text });
  } catch {}
}

// -------------------- INBOUND PARSER (robusto) --------------------
function pickFirstString(...vals) {
  for (const v of vals) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}
function pickFirstBase64(...vals) {
  for (const v of vals) {
    if (typeof v === "string" && v.trim()) {
      const s = v.trim();
      if (s.startsWith("data:image/")) return s;
      // às vezes vem só o base64 puro
      if (/^[A-Za-z0-9+/=]+$/.test(s) && s.length > 2000) return `data:image/jpeg;base64,${s}`;
    }
  }
  return null;
}

function isEmptyInbound(inbound) {
  return !inbound.message && !inbound.buttonId && !inbound.imageUrl && !inbound.imageBase64;
}

function parseInbound(body) {
  const phone =
    body?.phone ||
    body?.from ||
    body?.sender ||
    body?.senderPhone ||
    body?.remoteJid ||
    body?.chatId ||
    body?.data?.phone ||
    body?.data?.from ||
    null;

  const fromMe = Boolean(body?.fromMe || body?.data?.fromMe);

  const contactName =
    body?.senderName ||
    body?.pushName ||
    body?.contact?.name ||
    body?.data?.senderName ||
    body?.data?.pushName ||
    "";
  const msg = pickTextCandidate(body) || "";

  const imageUrl = pickFirstString(
    body?.image?.imageUrl,
    body?.image?.url,
    body?.imageUrl,
    body?.media?.url,
    body?.mediaUrl,
    body?.data?.image?.imageUrl,
    body?.data?.imageUrl,
    body?.data?.mediaUrl,
    body?.data?.media?.url,
    body?.data?.message?.image?.url,
    body?.data?.message?.image?.imageUrl,
    body?.data?.message?.media?.url,
    body?.data?.message?.mediaUrl,
    body?.message?.image?.url,
    body?.message?.image?.imageUrl,
    body?.message?.media?.url,
    body?.message?.mediaUrl,
    body?.data?.message?.imageMessage?.url,
    body?.data?.message?.documentMessage?.url,
    body?.data?.message?.videoMessage?.url
  );

  const imageBase64 = pickFirstBase64(
    body?.image?.base64,
    body?.image?.data,
    body?.data?.image?.base64,
    body?.data?.image?.data,
    body?.data?.message?.image?.base64,
    body?.data?.message?.image?.data,
    body?.message?.image?.base64,
    body?.message?.image?.data,
    body?.data?.message?.imageMessage?.jpegThumbnail // às vezes vem miniatura
  );

  // opcional: algum "cacheKey" (se você estiver usando isso em outra parte)
  const imageCacheKey = pickFirstString(
    body?.image?.cacheKey,
    body?.data?.image?.cacheKey,
    body?.data?.message?.image?.cacheKey,
    body?.message?.image?.cacheKey
  );

  const messageId =
    body?.messageId ||
    body?.data?.messageId ||
    body?.id ||
    body?.data?.id ||
    body?.message?.id ||
    body?.data?.message?.id ||
    body?.data?.key?.id ||
    body?.message?.key?.id ||
    null;

  const buttonId =
    body?.buttonId ||
    body?.data?.buttonId ||
    body?.data?.message?.interactive?.button_reply?.id ||
    body?.data?.message?.interactive?.list_reply?.id ||
    body?.message?.interactive?.button_reply?.id ||
    body?.message?.interactive?.list_reply?.id ||
    body?.data?.message?.buttonsResponseMessage?.selectedButtonId ||
    body?.data?.message?.interactive?.button_reply?.title ||
    body?.data?.message?.interactive?.list_reply?.title ||
    body?.data?.message?.listResponseMessage?.singleSelectReply?.selectedRowId ||
    body?.message?.buttonsResponseMessage?.selectedButtonId ||
    body?.message?.listResponseMessage?.singleSelectReply?.selectedRowId ||
    body?.data?.selectedButtonId ||
    body?.data?.selectedRowId ||
    body?.data?.selectedId ||
    null;

  const buttonTitle =
    body?.buttonTitle ||
    body?.data?.buttonTitle ||
    body?.message?.interactive?.button_reply?.title ||
    body?.message?.interactive?.list_reply?.title ||
    body?.data?.message?.buttonsResponseMessage?.selectedDisplayText ||
    body?.data?.message?.listResponseMessage?.singleSelectReply?.title ||
    body?.message?.buttonsResponseMessage?.selectedDisplayText ||
    null;

  const text = (buttonTitle || (typeof msg === "string" ? msg : "") || buttonId || "").toString().trim();

  return {
    phone: phone ? String(phone) : null,
    fromMe,
    contactName: String(contactName || "").trim(),
    messageId: messageId ? String(messageId) : null,
    buttonId: buttonId ? String(buttonId) : null,
    message: text,
    imageUrl: imageUrl ? String(imageUrl) : null,
    imageBase64: imageBase64 ? String(imageBase64) : null,
    imageCacheKey: imageCacheKey ? String(imageCacheKey) : null,
    raw: body,
  };
}

// -------------------- AGENDA (4 botões) --------------------
function randomPick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}
function formatScheduleLabel(d, hour) {
  const weekday = ["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"][d.getDay()];
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${weekday} — ${dd}/${mm} às ${hour}`;
}
function generateScheduleButtons() {
  const now = new Date();

  const d1 = new Date(now.getTime() + 86400000 * (1 + Math.floor(Math.random() * 4)));
  const h1 = randomPick(["13:30", "14:00", "15:00", "16:00"]);

  const d2 = new Date(now.getTime() + 86400000 * (2 + Math.floor(Math.random() * 5)));
  const h2 = randomPick(["19:00", "19:30", "20:00"]);

  const d3 = new Date(now.getTime());
  while (d3.getDay() !== 0 && d3.getDay() !== 6) d3.setDate(d3.getDate() + 1);
  const h3 = randomPick(["14:00", "15:00", "16:30", "18:00", "19:00"]);

  return [
    { id: "sched_1", title: formatScheduleLabel(d1, h1) },
    { id: "sched_2", title: formatScheduleLabel(d2, h2) },
    { id: "sched_3", title: formatScheduleLabel(d3, h3) },
    { id: "sched_other", title: "Outro horário (me diz qual)" },
  ];
}

// -------------------- SYSTEM PROMPT (fluxo) --------------------
const DEFAULT_AGENT_SYSTEM = `
Você é o DW Tattooer atendendo no WhatsApp.

TOM
- Humano, profissional e direto.
- Simpático sem bajular.
- Sempre escreva com parágrafos curtos (use \\n\\n).
- Nunca diga que é IA/bot/sistema.

OBJETIVO DO FLUXO
- Para orçamento, o mínimo é: referência em imagem + local no corpo.
- Tamanho em cm é opcional (se vier, use; se não vier, estime internamente).
- Antes do preço: agregue valor descrevendo tecnicamente a referência (sem exagero).
`;

const AGENT_SYSTEM = (ENV.AGENT_SYSTEM_PROMPT || "").trim() || DEFAULT_AGENT_SYSTEM;

// -------------------- FLOW CONTROLLER --------------------
function decideFirstChoice(inbound) {
  const id = inbound.buttonId;
  const t = norm(inbound.message);
  const idNorm = norm(inbound.buttonId);

  if (id === "first_new_budget") return "new_budget";
  if (id === "first_other_doubts") return "other_doubts";

  if (t === "orcamento novo") return "new_budget";
  if (t === "outras duvidas") return "other_doubts";

  if (idNorm.includes("orcamento")) return "new_budget";
  if (idNorm.includes("duvida")) return "other_doubts";


  if (t.includes("orcamento") || t.includes("orçamento") || t === "1") return "new_budget";
  if (t.includes("duvida") || t.includes("dúvida") || t.includes("falar") || t === "2") return "other_doubts";

  return null;
}
function decideEditChoice(inbound) {
  const id = inbound.buttonId;
  const t = norm(inbound.message);

  if (id === "edit_yes") return "yes";
  if (id === "edit_no") return "no";

  if (t.includes("ajust") || t.includes("quero ajustar") || t === "1") return "yes";
  if (t.includes("tudo certo") || t.includes("seguir") || t === "2") return "no";

  return null;
}
function decideScheduleChoice(inbound) {
  const id = inbound.buttonId;
  if (id === "sched_1" || id === "sched_2" || id === "sched_3") return "picked";
  if (id === "sched_other") return "other";
  return null;
}
function messageLooksLikeReceipt(text) {
  const t = norm(text);
  return /comprovante|paguei|pix feito|enviei o pix|ta pago/.test(t);
}

// -------------------- CORE HANDLER --------------------
async function handleInbound(phone, inbound) {
  const session = getSession(phone);

  const nm = safeName(inbound.contactName);
  if (nm && !session.data.name) session.data.name = nm;

  // 1) Captura imagem (URL/base64) e guarda também no cache por telefone
  if (inbound.imageUrl || inbound.imageBase64) {
    if (inbound.imageUrl) session.data.referenceImageUrl = inbound.imageUrl;
    if (inbound.imageBase64) session.data.referenceImageBase64 = inbound.imageBase64;
    setMediaCache(phone, { imageUrl: inbound.imageUrl, imageBase64: inbound.imageBase64 });
    scheduleSaveStore();
     if (nowMs() - session.lastMenuAt < 20000) {
      return;
    }

    session.lastMenuAt = nowMs();
    scheduleSaveStore();


  }

  // 2) Tenta body/size no texto
  if (inbound.message) {
    const bp = parseBodyPart(inbound.message);
    const sz = parseSizeCm(inbound.message);
    if (bp) session.data.bodyPart = bp;
    if (sz) session.data.sizeCm = sz; // opcional
  }

  // 3) Se não veio imagem neste webhook, tenta recuperar do cache (caso a imagem tenha chegado separada)
  if (!session.data.referenceImageUrl && !session.data.referenceImageBase64) {
    const cached = getMediaCache(phone);
    if (cached?.imageUrl || cached?.imageBase64) {
      session.data.referenceImageUrl = cached.imageUrl || "";
      session.data.referenceImageBase64 = cached.imageBase64 || "";
      scheduleSaveStore();
    }
  }

  // -------------------- STAGES --------------------
  if (session.stage === "start") {
    session.stage = "await_first_choice";
    scheduleSaveStore();

    const txt =
      "Oi! Aqui é o DW Tattooer — realismo preto e cinza e whip shading.\n\n" +
      "Como você quer seguir?";
    return sendButtons(phone, txt, [
      { id: "first_new_budget", title: "Orçamento novo" },
      { id: "first_other_doubts", title: "Outras dúvidas" },
    ], "início");
  }

  if (session.stage === "await_first_choice") {
     if (isEmptyInbound(inbound)) {
      return;
    }

    const choice = decideFirstChoice(inbound);

    if (choice === "other_doubts") {
      session.stage = "handoff";
      scheduleSaveStore();

      const txt = "Fechado. Me chama no meu Whats pessoal que eu te respondo por lá.";
      await sendTextOnce(phone, session, txt);
      await notifyOwner(`📩 HANDOFF — cliente pediu dúvidas\n\nNúmero: ${phone}\nStage: ${session.stage}`);
      return;
    }

    if (choice === "new_budget") {
      session.stage = "collect_ref_body";
      scheduleSaveStore();

      const txt =
        "Pra eu te passar o orçamento certinho, me manda:\n\n" +
        "• a referência em imagem\n" +
        "• o local no corpo\n\n" +
        "Se você souber o tamanho em cm, manda também (opcional).";
      return sendTextOnce(phone, session, txt);
    }

    const txt =
      "Só me confirma como você quer seguir:\n\n" +
      "• Orçamento novo\n" +
      "• Outras dúvidas";

    if (nowMs() - session.lastMenuAt < 20000) {
      return;
    }

    session.lastMenuAt = nowMs();
    scheduleSaveStore();


    return sendButtons(phone, txt, [
      { id: "first_new_budget", title: "Orçamento novo" },
      { id: "first_other_doubts", title: "Outras dúvidas" },
    ], "início");
  }

  if (session.stage === "handoff") return;

  // ✅ agora o mínimo é: referência + local (tamanho é opcional)
  if (session.stage === "collect_ref_body") {
    const missing = [];
    const hasRef = Boolean(session.data.referenceImageUrl || session.data.referenceImageBase64);
    if (!hasRef) missing.push("referência em imagem");
    if (!session.data.bodyPart) missing.push("local no corpo");

    if (missing.length > 0) {
      const txt =
        "Pra eu te atender certinho, só falta:\n\n" +
        missing.map((m) => `• ${m}`).join("\n") +
        "\n\nTamanho em cm é opcional.";
      return sendTextOnce(phone, session, txt);
    }

    session.stage = "ask_edit";
    scheduleSaveStore();

    const txt = "Você quer ajustar algo na ideia antes do orçamento?";
    return sendButtons(phone, txt, [
      { id: "edit_yes", title: "Quero ajustar" },
      { id: "edit_no", title: "Está tudo certo" },
    ], "ajustes");
  }

  if (session.stage === "ask_edit") {
    const ch = decideEditChoice(inbound);

    if (ch === "yes") {
      session.stage = "collect_changes";
      scheduleSaveStore();

      const txt = "Me diz o que você quer ajustar (detalhes, elementos, estilo, etc.).";
      return sendTextOnce(phone, session, txt);
    }

    if (ch === "no") {
      session.stage = "quote";
      scheduleSaveStore();
    } else {
      const txt = "Você quer ajustar algo na ideia antes do orçamento?";
      return sendButtons(phone, txt, [
        { id: "edit_yes", title: "Quero ajustar" },
        { id: "edit_no", title: "Está tudo certo" },
      ], "ajustes");
    }
  }

  if (session.stage === "collect_changes") {
    const msg = (inbound.message || "").trim();
    if (msg) session.data.changeNotes = (session.data.changeNotes ? session.data.changeNotes + "\n" : "") + msg;

    session.stage = "quote";
    scheduleSaveStore();
  }

  if (session.stage === "quote") {
    const hasRef = Boolean(session.data.referenceImageUrl || session.data.referenceImageBase64);
    if (!hasRef || !session.data.bodyPart) {
      session.stage = "collect_ref_body";
      scheduleSaveStore();
      const txt =
        "Pra eu fechar o orçamento, preciso da referência e do local no corpo.\n\n" +
        "• referência em imagem\n" +
        "• local no corpo";
      return sendTextOnce(phone, session, txt);
    }

    // ✅ descreve + estima horas com AGENTE (tamanho opcional)
    const imgUrl = session.data.referenceImageUrl || "";
    const imgB64 = session.data.referenceImageBase64 || "";

    const { summaryText, estHours } = await analyzeAndEstimate({
      imageUrl: imgUrl,
      imageBase64: imgB64,
      bodyPart: session.data.bodyPart,
      sizeCm: session.data.sizeCm,
      changeNotes: session.data.changeNotes,
    });

    session.data.imageSummary = summaryText || "";
    session.data.imageSummaryAt = nowMs();
    session.data.estHours = estHours;
    session.data.estTotal = calcTotalFromHours(estHours);
    scheduleSaveStore();

    console.log("[IMAGE ANALYZED]", { ok: true, chars: (summaryText || "").length, estHours });

    const bullets = summarizeToBullets(summaryText);
    const preface =
      bullets
        ? "Pelo que eu vi na sua referência:\n\n" +
          `${bullets}\n\n` +
          `No(a) ${session.data.bodyPart}, isso pede atenção pra manter as transições limpas e o acabamento bem fechado.\n\n`
        : `Fechado.\n\nNo(a) ${session.data.bodyPart}, eu vou focar em acabamento limpo e bom envelhecimento.\n\n`;

    const quoteText =
      preface +
      `Estimativa de tempo: ${session.data.estHours}h\n` +
      `Investimento: R$ ${session.data.estTotal}\n\n` +
      "Quer que eu te mande opções de datas e horários pra agendar?";

    session.stage = "ask_schedule";
    scheduleSaveStore();

    return sendButtons(phone, quoteText, [
      { id: "sched_go", title: "Quero agendar" },
      { id: "sched_no", title: "Agora não" },
    ], "agenda");
  }

  if (session.stage === "ask_schedule") {
    const t = norm(inbound.message);
    const id = inbound.buttonId;

    const wants =
      id === "sched_go" ||
      t.includes("agendar") ||
      t.includes("quero") ||
      t === "1";

    const notNow =
      id === "sched_no" ||
      t.includes("agora nao") ||
      t.includes("agora não") ||
      t.includes("depois") ||
      t === "2";

    if (notNow) {
      const txt =
        "Fechado.\n\nQuando você quiser seguir com o agendamento, é só me chamar aqui que eu te mando as opções.";
      session.stage = "post_quote";
      scheduleSaveStore();
      return sendTextOnce(phone, session, txt);
    }

    if (!wants) {
      const txt = "Quer que eu te mande opções de datas e horários agora?";
      return sendButtons(phone, txt, [
        { id: "sched_go", title: "Quero agendar" },
        { id: "sched_no", title: "Agora não" },
      ], "agenda");
    }

    const scheduleButtons = generateScheduleButtons();
    session.stage = "await_schedule_pick";
    scheduleSaveStore();

    const txt = "Show.\n\nSeparei algumas opções pra você escolher (ou me diz um horário específico):";
    return sendButtons(phone, txt, scheduleButtons, "horários");
  }

  if (session.stage === "await_schedule_pick") {
    const ch = decideScheduleChoice(inbound);

    if (ch === "picked") {
      session.data.chosenSchedule = inbound.message || inbound.buttonId;
      session.stage = "signal";
      scheduleSaveStore();
    } else if (ch === "other") {
      session.stage = "await_custom_schedule";
      scheduleSaveStore();

      const txt =
        "Fechado.\n\nMe manda o dia e horário que você prefere (ex: terça 19h / sábado 15h) que eu tento encaixar na agenda.";
      return sendTextOnce(phone, session, txt);
    } else {
      const scheduleButtons = generateScheduleButtons();
      const txt = "Escolhe uma opção por aqui, ou clica em “Outro horário”.";
      return sendButtons(phone, txt, scheduleButtons, "horários");
    }
  }

  if (session.stage === "await_custom_schedule") {
    const msg = (inbound.message || "").trim();
    if (!msg) return;

    session.data.chosenSchedule = msg;
    session.stage = "signal";
    scheduleSaveStore();
  }

  if (session.stage === "signal") {
    const pix = ENV.PIX_KEY || "SEU_PIX_AQUI";
    const txt =
      "Fechamos assim:\n\n" +
      `• Horário: ${session.data.chosenSchedule}\n\n` +
      `Pra segurar a reserva, o sinal é de R$ ${ENV.SIGNAL_VALUE},00 (abatido do total no dia).\n\n` +
      `Chave Pix:\n${pix}\n\n` +
      `Depois que fizer, me manda o comprovante aqui no Whats.\n\n` +
      `Obs: o sinal precisa ser enviado em até ${ENV.SIGNAL_DEADLINE_HOURS} horas pra garantir a reserva.`;

    session.data.signalSentAt = nowMs();
    session.stage = "await_receipt";
    scheduleSaveStore();

    return sendTextOnce(phone, session, txt);
  }

  if (session.stage === "await_receipt") {
    if (inbound.imageUrl || inbound.imageBase64 || messageLooksLikeReceipt(inbound.message)) {
      session.data.receiptReceived = true;
      session.stage = "done";
      scheduleSaveStore();

      const txt =
        "Obrigado! Comprovante recebido.\n\n" +
        "Antes da sessão:\n\n" +
        "• Beba bastante água.\n" +
        "• Evite álcool no dia anterior.\n" +
        "• Se alimente bem antes de vir.\n" +
        "• Hidrate a pele da região nos dias anteriores.\n" +
        "• Evite sol forte na área.\n\n" +
        "Qualquer dúvida até o dia, me chama por aqui.";

      await notifyOwner(`✅ Comprovante recebido — ${phone}\nHorário: ${session.data.chosenSchedule}`);
      return sendTextOnce(phone, session, txt);
    }

    const txt = "Pra confirmar a reserva, me manda a foto do comprovante aqui no Whats.";
    return sendTextOnce(phone, session, txt);
  }

  if (session.stage === "post_quote") {
    const t = norm(inbound.message);
    if (t.includes("orcamento") || t.includes("orçamento") || t.includes("fazer outra")) {
      resetSession(phone);
      const s2 = getSession(phone);
      s2.stage = "await_first_choice";
      scheduleSaveStore();
      const txt = "Beleza.\n\nComo você quer seguir?";
      return sendButtons(phone, txt, [
        { id: "first_new_budget", title: "Orçamento novo" },
        { id: "first_other_doubts", title: "Outras dúvidas" },
      ], "início");
    }
    return;
  }

  if (session.stage === "done") {
    const t = norm(inbound.message);
    if (t.includes("orcamento") || t.includes("orçamento") || t.includes("quero outra")) {
      resetSession(phone);
      const s2 = getSession(phone);
      s2.stage = "await_first_choice";
      scheduleSaveStore();
      const txt = "Como você quer seguir?";
      return sendButtons(phone, txt, [
        { id: "first_new_budget", title: "Orçamento novo" },
        { id: "first_other_doubts", title: "Outras dúvidas" },
      ], "início");
    }
    return;
  }

  // fallback
  const fb =
    "Pra eu te atender certinho:\n\n" +
    "• me manda a referência em imagem\n" +
    "• local no corpo\n\n" +
    "Tamanho em cm é opcional.";
  return sendTextOnce(phone, session, fb);
}

// -------------------- ROUTES --------------------
app.get("/", (req, res) => res.status(200).send("OK"));

app.get("/health", (req, res) => {
  const miss = missingEnvs();
  res.status(miss.length ? 500 : 200).json({
    ok: miss.length === 0,
    missing: miss,
    sessions: Object.keys(STORE.sessions).length,
    model: ENV.OPENAI_MODEL,
    storePath: ENV.STORE_PATH,
    mediaCache: MEDIA_CACHE.size,
  });
});

app.post("/", async (req, res) => {
  res.status(200).json({ ok: true });

  try {
    mediaCacheCleanup();
    cleanupProcessed();

    console.log("[WEBHOOK HIT] keys:", Object.keys(req.body || {}));

    const inbound = parseInbound(req.body || {});

    const rawText = pickTextCandidate(req.body || {});

    if (rawText && !inbound.message) {
      inbound.message = rawText.trim();
      if (inbound.message) {
        console.log("[PATCHED] message recovered from rawText");
      }
    }
    console.log("[INBOUND PARSED]", {
      phone: inbound.phone,
      fromMe: inbound.fromMe,
      messageId: inbound.messageId,
      buttonId: inbound.buttonId,
      hasImageUrl: Boolean(inbound.imageUrl),
      hasImageBase64: Boolean(inbound.imageBase64),
      hasImageCacheKey: Boolean(inbound.imageCacheKey),
      imageUrl: inbound.imageUrl ? inbound.imageUrl.slice(0, 120) : null,
      message: inbound.message ? inbound.message.slice(0, 120) : "",
    });

    if (isEmptyInbound(inbound)) {
     const body = req.body || {};
     console.log("[EMPTY INBOUND DIAG]", {
        bodyKeys: Object.keys(body || {}),
        dataKeys: Object.keys(body?.data || {}),
        messageKeys: Object.keys(body?.data?.message || {}),
        bodySnippet: JSON.stringify(body).slice(0, 600),
      });
      console.log("[IGNORED] empty inbound event (no text/button/media)");
      return;
    }

    if (!inbound.phone) {
      console.log("[NO PHONE] body sample:", JSON.stringify(req.body || {}).slice(0, 1200));
      return;
    }

    if (inbound.fromMe) {
      console.log("[IGNORED] fromMe");
      return;
    }

    // ✅ fingerprint calculado já aqui
    const fp = makeFingerprint(inbound);

    // ✅ In-flight guard (bloqueia duplicata simultânea)
    if (inbound.messageId && INFLIGHT_MSG.has(inbound.messageId)) {
      console.log("[IGNORED] inflight msgId:", inbound.messageId);
      return;
    }
    if (fp && INFLIGHT_FP.has(fp)) {
      console.log("[IGNORED] inflight fp:", fp);
      return;
    }

    if (inbound.messageId) INFLIGHT_MSG.add(inbound.messageId);
    if (fp) INFLIGHT_FP.add(fp);

    // ✅ lock por telefone primeiro, depois idempotência (sem corrida)
    await withPhoneLock(inbound.phone, async () => {
      try {
        console.log("[LOCK] processing phone:", inbound.phone);

        if (inbound.messageId && wasProcessed(inbound.messageId)) {
          console.log("[IGNORED] already processed msgId:", inbound.messageId);
          return;
        }
        if (fp && wasProcessedFp(fp)) {
          console.log("[IGNORED] already processed fp:", fp);
          return;
        }

        if (inbound.messageId) markProcessed(inbound.messageId, inbound.phone);
        if (fp) markProcessedFp(fp, inbound.phone);

        await handleInbound(inbound.phone, inbound);

        console.log("[DONE] processed phone:", inbound.phone);
      } finally {
        if (inbound.messageId) INFLIGHT_MSG.delete(inbound.messageId);
        if (fp) INFLIGHT_FP.delete(fp);
      }
    });
  } catch (e) {
    console.error("[WEBHOOK ERROR]", e?.message || e);
  }
});

// -------------------- BOOT --------------------
async function boot() {
  await loadStore();
  cleanupProcessed();
  mediaCacheCleanup();

  console.log("🚀 DW BOT ONLINE");
  console.log("Modelo:", ENV.OPENAI_MODEL);
  console.log("Sessions:", Object.keys(STORE.sessions).length);

  const miss = missingEnvs();
  if (miss.length) console.log("⚠ Missing ENV:", miss.join(", "));

  app.listen(ENV.PORT, () => console.log("Servidor na porta:", ENV.PORT));
}

boot().catch((e) => {
  console.error("❌ BOOT ERROR", e?.message || e);
  process.exit(1);
});
