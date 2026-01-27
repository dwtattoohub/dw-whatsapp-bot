// ============================================================
// DW WhatsApp Bot — Versão AGENTE (GPT-4o) + Antiduplicação real (FIXES)
// - ✅ Idempotência real: messageId + fingerprint SEM timestamp (retry-safe)
// - ✅ Usa processedFp de verdade no webhook (antes estava definido mas não aplicado)
// - ✅ Captura imagem: URL + base64/thumbnail do webhook (sem depender de URL pública)
// - ✅ Cache em memória p/ base64 (não grava base64 no store)
// - ✅ Logs úteis p/ diagnosticar imagem/análise
// ============================================================

import express from "express";
import crypto from "crypto";
import OpenAI from "openai";
import fsp from "fs/promises";

// -------------------- APP --------------------
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

  // Preço (default ajustado)
  HOUR_FIRST: Number(process.env.HOUR_FIRST || 150),
  HOUR_NEXT: Number(process.env.HOUR_NEXT || 120),

  // PIX + sinal
  PIX_KEY: process.env.PIX_KEY || "",
  SIGNAL_VALUE: Number(process.env.SIGNAL_VALUE || 50),
  SIGNAL_DEADLINE_HOURS: Number(process.env.SIGNAL_DEADLINE_HOURS || 4),

  // System prompt opcional no ENV (se vazio, usa o padrão do código)
  AGENT_SYSTEM_PROMPT: process.env.AGENT_SYSTEM_PROMPT || "",

  // Cache de mídia (base64) em memória
  MEDIA_CACHE_TTL_MIN: Number(process.env.MEDIA_CACHE_TTL_MIN || 60),
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
  sessions: {}, // phone -> session
  processed: {}, // messageId -> { at, phone }
  processedFp: {}, // fingerprint -> { at, phone }
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
          {
            sessions: STORE.sessions,
            processed: STORE.processed,
            processedFp: STORE.processedFp,
          },
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

// ✅ fingerprint idempotência (retry-safe): NÃO usa timestamp
function fpHash(s) {
  return crypto.createHash("sha1").update(String(s)).digest("hex");
}

function makeFingerprint(inbound) {
  const base = [
    inbound.phone || "",
    inbound.buttonId || "",
    inbound.message || "",
    inbound.imageUrl || "",
    inbound.imageCacheKey || "", // quando vier base64
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

// -------------------- MEDIA CACHE (base64 em memória) --------------------
// Evita salvar base64 no store e mantém disponível p/ análise.
const MEDIA_CACHE = new Map(); // key -> { dataUrl, at }

function mediaCachePut(dataUrl) {
  const key = crypto.randomBytes(12).toString("hex");
  MEDIA_CACHE.set(key, { dataUrl, at: nowMs() });
  return key;
}

function mediaCacheGet(key) {
  const v = MEDIA_CACHE.get(key);
  if (!v?.dataUrl) return null;
  return v.dataUrl;
}

function mediaCacheCleanup() {
  const ttl = ENV.MEDIA_CACHE_TTL_MIN * 60 * 1000;
  const cut = nowMs() - ttl;
  for (const [k, v] of MEDIA_CACHE.entries()) {
    if (!v?.at || v.at < cut) MEDIA_CACHE.delete(k);
  }
}

// -------------------- SESSIONS --------------------
function newSession() {
  return {
    stage: "start",
    lastSentHash: "",
    agentContext: [],
    data: {
      name: "",
      bodyPart: "",
      sizeCm: null,
      referenceImageUrl: "",
      referenceImageCacheKey: "", // ✅ quando a imagem vier em base64
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

// -------------------- LOCK por telefone (evita paralelismo) --------------------
const PHONE_LOCKS = new Map();

// ✅ In-flight guards (evita corrida entre webhooks simultâneos)
const INFLIGHT_MSG = new Set(); // messageId
const INFLIGHT_FP = new Set();  // fingerprint
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

function calcHoursAndPrice(sizeCm, complexity = "media") {
  const s = Number(sizeCm || 0);
  const base = s <= 12 ? 1.2 : s <= 18 ? 2 : s <= 25 ? 3 : 4;
  const mult = complexity === "alta" ? 1.5 : complexity === "baixa" ? 1.0 : 1.2;
  const hours = Math.max(1, base * mult);

  const first = ENV.HOUR_FIRST;
  const rest = Math.max(0, hours - 1) * ENV.HOUR_NEXT;
  const total = Math.round(first + rest);

  return { hours: Number(hours.toFixed(1)), total };
}

// ============================================================================
// ✅ ANALISAR REFERÊNCIA (IMAGEM) — aceita URL ou dataURL (base64)
// ============================================================================

function summarizeToBullets(summary) {
  const s = String(summary || "").trim();
  if (!s) return "";
  const parts = s
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(0, 4);

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

async function analyzeReferenceImage(imageUrlOrDataUrl) {
  if (!imageUrlOrDataUrl) return "";

  const promptText =
    "Analise a imagem de referência da tatuagem e descreva tecnicamente, em português, " +
    "de forma curta e objetiva, destacando: tema/assunto, quantidade de elementos, " +
    "nível de detalhe, sombras/contraste, texturas (pele, cabelo, metal, tecido), " +
    "áreas que exigem mais tempo (rostos, mãos, fundo, transições). " +
    "Não dê preço. Retorne só texto.";

  // 1) se já veio dataURL (base64), manda direto
  if (String(imageUrlOrDataUrl).startsWith("data:")) {
    try {
      const completion = await openai.chat.completions.create({
        model: ENV.OPENAI_MODEL,
        temperature: 0.2,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: promptText },
              { type: "image_url", image_url: { url: imageUrlOrDataUrl } },
            ],
          },
        ],
      });
      return String(completion.choices?.[0]?.message?.content || "").trim();
    } catch (e0) {
      console.error("[IMAGE ANALYSIS DATAURL ERROR]", e0?.message || e0);
      return "";
    }
  }

  // 2) tenta direto com URL
  try {
    const completion = await openai.chat.completions.create({
      model: ENV.OPENAI_MODEL,
      temperature: 0.2,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: promptText },
            { type: "image_url", image_url: { url: imageUrlOrDataUrl } },
          ],
        },
      ],
    });
    return String(completion.choices?.[0]?.message?.content || "").trim();
  } catch (e1) {
    console.error("[IMAGE ANALYSIS URL ERROR]", e1?.message || e1);

    // 3) fallback: baixa e manda base64 (resolve quando URL não é público)
    try {
      const dataUrl = await fetchAsDataUrl(imageUrlOrDataUrl);
      const completion2 = await openai.chat.completions.create({
        model: ENV.OPENAI_MODEL,
        temperature: 0.2,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: promptText },
              { type: "image_url", image_url: { url: dataUrl } },
            ],
          },
        ],
      });
      return String(completion2.choices?.[0]?.message?.content || "").trim();
    } catch (e2) {
      console.error("[IMAGE ANALYSIS BASE64 ERROR]", e2?.message || e2);
      return "";
    }
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
    if (typeof v === "string" && v.trim().length > 64) return v.trim();
  }
  return null;
}

function normalizeMime(m) {
  const s = String(m || "").toLowerCase().trim();
  if (!s) return "image/jpeg";
  if (s.includes("png")) return "image/png";
  if (s.includes("webp")) return "image/webp";
  return "image/jpeg";
}

// Monta dataURL se vier base64 no webhook
function buildDataUrlFromBase64(b64, mime) {
  if (!b64) return null;
  const clean = b64.replace(/^data:.*;base64,/, "");
  const mt = normalizeMime(mime);
  return `data:${mt};base64,${clean}`;
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

  const msg =
    body?.message ||
    body?.text?.message ||
    body?.text ||
    body?.Body ||
    body?.data?.message ||
    body?.data?.text ||
    "";

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
    // whatsapp-like
    body?.data?.message?.imageMessage?.url,
    body?.data?.message?.documentMessage?.url,
    body?.data?.message?.videoMessage?.url
  );

  // ✅ base64/thumbnail (alguns webhooks mandam isso em vez de URL)
  const b64 = pickFirstBase64(
    body?.image?.base64,
    body?.image?.data,
    body?.data?.image?.base64,
    body?.data?.image?.data,
    body?.data?.message?.image?.base64,
    body?.data?.message?.image?.data,
    body?.data?.message?.imageMessage?.jpegThumbnail, // comum em payloads
    body?.message?.image?.base64,
    body?.message?.image?.data
  );

  const mime = pickFirstString(
    body?.image?.mimetype,
    body?.image?.mimeType,
    body?.data?.image?.mimetype,
    body?.data?.image?.mimeType,
    body?.data?.message?.image?.mimetype,
    body?.data?.message?.image?.mimeType,
    body?.data?.message?.imageMessage?.mimetype
  );

  const imageDataUrl = b64 ? buildDataUrlFromBase64(b64, mime) : null;

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
    body?.message?.interactive?.button_reply?.id ||
    body?.message?.buttonsResponseMessage?.selectedButtonId ||
    body?.message?.listResponseMessage?.singleSelectReply?.selectedRowId ||
    null;

  const buttonTitle =
    body?.buttonTitle ||
    body?.data?.buttonTitle ||
    body?.message?.interactive?.button_reply?.title ||
    body?.message?.buttonsResponseMessage?.selectedDisplayText ||
    body?.message?.listResponseMessage?.title ||
    null;

  const text = (buttonTitle || (typeof msg === "string" ? msg : "") || "").toString().trim();

  // ✅ se veio dataUrl, guarda em cache e usa key (sem persistir base64 no store)
  let imageCacheKey = null;
  if (imageDataUrl) {
    imageCacheKey = mediaCachePut(imageDataUrl);
  }

  return {
    phone: phone ? String(phone) : null,
    fromMe,
    contactName: String(contactName || "").trim(),
    messageId: messageId ? String(messageId) : null,
    buttonId: buttonId ? String(buttonId) : null,
    message: text,
    imageUrl: imageUrl ? String(imageUrl) : null,
    imageCacheKey, // ✅ chave do cache se veio base64
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

// -------------------- SYSTEM PROMPT --------------------
const DEFAULT_AGENT_SYSTEM = `
Você é o DW Tattooer atendendo no WhatsApp.

TOM
- Humano, profissional e direto.
- Simpático sem bajular.
- NÃO repita palavras tipo “perfeito”.
- Sempre escreva com parágrafos curtos (use \\n\\n).
- Nunca diga que é IA/bot/sistema.

FORMATO
Responda SEMPRE e APENAS em JSON válido (sem crases, sem texto fora).
Schema:

{
  "text": "mensagem",
  "buttons": [{"id":"...","title":"..."}],
  "action": "NONE | HANDOFF_TO_OWNER | RESET_SESSION",
  "set": {
    "stage": "string",
    "data": { "changeNotes": "...", "wantsSchedule": true/false }
  }
}

REGRAS DO FLUXO
1) Saudação inicial (primeiro contato ou reinício):
Texto (com \\n\\n):
"Oi! Aqui é o DW Tattooer — especialista em realismo preto e cinza e whip shading.\\n\\nObrigado por me procurar e confiar no meu trabalho. Como você quer seguir?"
Botões:
- Orçamento novo
- Outras dúvidas

2) Outras dúvidas => action HANDOFF_TO_OWNER.
Texto: "Fechado. Me chama no meu Whats pessoal que eu te respondo por lá."

3) Orçamento novo:
Peça (com \\n\\n):
- referência em imagem
- local no corpo
- tamanho em cm

4) Quando tiver referência + local + tamanho:
Pergunte com botões:
"Você quer ajustar algo na ideia antes do orçamento?"
Botões:
- Quero ajustar
- Está tudo certo

5) Ajustar => peça a ideia/ajustes.
6) Está tudo certo => faça orçamento e mostre:
- R$ {{estTotal}}
- {{estHours}}h (estimativa)
Depois pergunte se quer agendar.

7) Se quiser agendar: o backend manda 4 botões. Confirma e pede o sinal.

8) Comprovante recebido: agradeça e mande cuidados pré tattoo.

9) Se o cliente pedir "quero falar com você / dúvidas": HANDOFF.
`;

const AGENT_SYSTEM = (ENV.AGENT_SYSTEM_PROMPT || "").trim() || DEFAULT_AGENT_SYSTEM;

// -------------------- JSON parse robusto --------------------
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

// -------------------- AGENT CALL --------------------
async function agentReply(session, eventName, extra = {}) {
  const messages = [
    { role: "system", content: AGENT_SYSTEM },
    ...session.agentContext,
    {
      role: "user",
      content: JSON.stringify({
        event: eventName,
        message: extra.message || "",
        session: session.data,
        extra,
      }),
    },
  ];

  const completion = await openai.chat.completions.create({
    model: ENV.OPENAI_MODEL,
    temperature: 0.2,
    messages,
  });

  const raw = completion.choices?.[0]?.message?.content || "";
  const parsed = safeJsonParse(raw);

  session.agentContext.push({ role: "assistant", content: raw });
  if (session.agentContext.length > 10) session.agentContext = session.agentContext.slice(-10);
  scheduleSaveStore();

  if (!parsed) {
    return {
      text: "Não peguei sua mensagem direito.\n\nPode me mandar de novo, por favor?",
      buttons: [],
      action: "NONE",
      set: { stage: session.stage },
    };
  }

  if (!parsed.buttons) parsed.buttons = [];
  if (!parsed.action) parsed.action = "NONE";
  if (!parsed.set) parsed.set = { stage: session.stage, data: {} };
  if (!parsed.set.data) parsed.set.data = {};

  return parsed;
}

async function applyAgentAction(phone, session, agentJson, forcedButtons = null) {
  const { text = "", buttons = [], action = "NONE", set = {} } = agentJson;

  if (set.stage) session.stage = String(set.stage);
  if (set.data && typeof set.data === "object") session.data = { ...session.data, ...set.data };
  scheduleSaveStore();

  if (action === "HANDOFF_TO_OWNER") {
    if (text) await sendTextOnce(phone, session, text);

    await notifyOwner(
      `📩 HANDOFF — cliente pediu falar com você\n\n` +
        `Número: ${phone}\n` +
        `Stage: ${session.stage}\n` +
        `Última msg: ${String(text).slice(0, 200)}`
    );
    return;
  }

  if (action === "RESET_SESSION") {
    resetSession(phone);
    if (text) await sendText(phone, text);
    return;
  }

  if (!text) return;

  if (antiRepeat(session, text)) return;

  const b = forcedButtons || buttons;
  if (Array.isArray(b) && b.length > 0) {
    await sendButtons(phone, text, b);
  } else {
    await sendText(phone, text);
  }
}

// -------------------- FLOW CONTROLLER --------------------
function decideFirstChoice(inbound) {
  const id = inbound.buttonId;
  const t = norm(inbound.message);

  if (id === "first_new_budget") return "new_budget";
  if (id === "first_other_doubts") return "other_doubts";

  if (t.includes("orcamento") || t === "1") return "new_budget";
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

async function handleInbound(phone, inbound) {
  const session = getSession(phone);

  const nm = safeName(inbound.contactName);
  if (nm && !session.data.name) session.data.name = nm;

  // ✅ se chegou imagem: URL OU base64(cacheKey)
  if (inbound.imageUrl || inbound.imageCacheKey) {
    const newUrl = inbound.imageUrl || "";
    const newKey = inbound.imageCacheKey || "";

    const isNew =
      (newUrl && newUrl !== session.data.referenceImageUrl) ||
      (newKey && newKey !== session.data.referenceImageCacheKey);

    if (newUrl) session.data.referenceImageUrl = newUrl;
    if (newKey) session.data.referenceImageCacheKey = newKey;

    scheduleSaveStore();

    if (isNew) {
      try {
        console.log("[IMAGE RECEIVED]", {
          hasUrl: Boolean(newUrl),
          hasCacheKey: Boolean(newKey),
          url: newUrl ? newUrl.slice(0, 120) : null,
        });

        const dataUrl = newKey ? mediaCacheGet(newKey) : null;
        const toAnalyze = dataUrl || newUrl;

        const summary = await analyzeReferenceImage(toAnalyze);
        session.data.imageSummary = summary || "";
        session.data.imageSummaryAt = nowMs();

        console.log("[IMAGE ANALYZED]", {
          ok: Boolean(summary),
          chars: (summary || "").length,
        });

        scheduleSaveStore();
      } catch (e) {
        console.error("[IMAGE ANALYSIS UNCAUGHT]", e?.message || e);
      }
    }
  }

  // texto: tenta body/size
  if (inbound.message) {
    const bp = parseBodyPart(inbound.message);
    const sz = parseSizeCm(inbound.message);
    if (bp) session.data.bodyPart = bp;
    if (sz) session.data.sizeCm = sz;
  }

  scheduleSaveStore();

  // -------------------- STAGES --------------------
  if (session.stage === "start") {
    session.stage = "await_first_choice";
    scheduleSaveStore();

    const agentJson = await agentReply(session, "FIRST_CONTACT");
    const forcedButtons = [
      { id: "first_new_budget", title: "Orçamento novo" },
      { id: "first_other_doubts", title: "Outras dúvidas" },
    ];
    return applyAgentAction(phone, session, agentJson, forcedButtons);
  }

  if (session.stage === "await_first_choice") {
    const choice = decideFirstChoice(inbound);

    if (choice === "other_doubts") {
      const agentJson = await agentReply(session, "OTHER_DOUBTS");
      agentJson.action = "HANDOFF_TO_OWNER";
      agentJson.set = { ...(agentJson.set || {}), stage: "handoff", data: {} };
      return applyAgentAction(phone, session, agentJson);
    }

    if (choice === "new_budget") {
      session.stage = "collect_ref_body_size";
      scheduleSaveStore();

      const agentJson = await agentReply(session, "NEW_BUDGET");
      return applyAgentAction(phone, session, agentJson);
    }

    const txt = "Só me confirma como você quer seguir:\n\n• Orçamento novo\n• Outras dúvidas";
    return sendButtons(
      phone,
      txt,
      [
        { id: "first_new_budget", title: "Orçamento novo" },
        { id: "first_other_doubts", title: "Outras dúvidas" },
      ],
      "início"
    );
  }

  if (session.stage === "handoff") return;

  if (session.stage === "collect_ref_body_size") {
    const missing = [];
    if (!session.data.referenceImageUrl && !session.data.referenceImageCacheKey) missing.push("referência em imagem");
    if (!session.data.bodyPart) missing.push("local no corpo");
    if (!session.data.sizeCm) missing.push("tamanho em cm");

    if (missing.length > 0) {
      const agentJson = await agentReply(session, "MISSING_INFO", { missing, message: inbound.message || "" });
      return applyAgentAction(phone, session, agentJson);
    }

    session.stage = "ask_edit";
    scheduleSaveStore();

    const agentJson = await agentReply(session, "HAVE_ALL_INFO");
    const forcedButtons = [
      { id: "edit_yes", title: "Quero ajustar" },
      { id: "edit_no", title: "Está tudo certo" },
    ];
    return applyAgentAction(phone, session, agentJson, forcedButtons);
  }

  if (session.stage === "ask_edit") {
    const ch = decideEditChoice(inbound);

    if (ch === "yes") {
      session.stage = "collect_changes";
      scheduleSaveStore();

      const agentJson = await agentReply(session, "EDIT_YES");
      return applyAgentAction(phone, session, agentJson);
    }

    if (ch === "no") {
      session.stage = "quote";
      scheduleSaveStore();
    } else {
      const txt = "Você quer ajustar algo na ideia antes do orçamento?";
      return sendButtons(
        phone,
        txt,
        [
          { id: "edit_yes", title: "Quero ajustar" },
          { id: "edit_no", title: "Está tudo certo" },
        ],
        "ajustes"
      );
    }
  }

  if (session.stage === "collect_changes") {
    const msg = (inbound.message || "").trim();
    if (msg) session.data.changeNotes = (session.data.changeNotes ? session.data.changeNotes + "\n" : "") + msg;

    session.stage = "quote";
    scheduleSaveStore();
  }

  if (session.stage === "quote") {
    const complexity = session.data.changeNotes ? "alta" : "media";
    const { hours, total } = calcHoursAndPrice(session.data.sizeCm, complexity);
    session.data.estHours = hours;
    session.data.estTotal = total;
    scheduleSaveStore();

    const agentJson = await agentReply(session, "QUOTE_READY");

    const bullets = summarizeToBullets(session.data.imageSummary);
    const preface = bullets
      ? "Pelo que eu vi na sua referência, o projeto tem esses pontos principais:\n\n" +
        `${bullets}\n\n` +
        "Isso influencia direto no tempo (sombras, transições e acabamento) pra ficar limpo e com bom envelhecimento.\n\n"
      : "Fechado.\n\n";

    const quoteText =
      preface +
      `Pra ${session.data.sizeCm}cm no(a) ${session.data.bodyPart}, a estimativa fica assim:\n\n` +
      `• Tempo: ${session.data.estHours}h (estimativa)\n` +
      `• Investimento: R$ ${session.data.estTotal}\n\n` +
      "Quer que eu te mande opções de datas e horários pra agendar?";

    agentJson.text = quoteText;

    session.stage = "ask_schedule";
    scheduleSaveStore();

    return applyAgentAction(phone, session, agentJson, [
      { id: "sched_go", title: "Quero agendar" },
      { id: "sched_no", title: "Agora não" },
    ]);
  }

  if (session.stage === "ask_schedule") {
    const t = norm(inbound.message);
    const id = inbound.buttonId;

    const wants = id === "sched_go" || t.includes("agendar") || t.includes("quero") || t === "1";
    const notNow = id === "sched_no" || t.includes("agora nao") || t.includes("agora não") || t.includes("depois") || t === "2";

    if (notNow) {
      const txt = "Fechado.\n\nQuando você quiser seguir com o agendamento, é só me chamar aqui que eu te mando as opções.";
      session.stage = "post_quote";
      scheduleSaveStore();
      return sendTextOnce(phone, session, txt);
    }

    if (!wants) {
      const txt = "Quer que eu te mande opções de datas e horários agora?";
      return sendButtons(
        phone,
        txt,
        [
          { id: "sched_go", title: "Quero agendar" },
          { id: "sched_no", title: "Agora não" },
        ],
        "agenda"
      );
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

      const txt = "Fechado.\n\nMe manda o dia e horário que você prefere (ex: terça 19h / sábado 15h) que eu tento encaixar na agenda.";
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
    if (inbound.imageUrl || inbound.imageCacheKey || messageLooksLikeReceipt(inbound.message)) {
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
      return sendButtons(
        phone,
        txt,
        [
          { id: "first_new_budget", title: "Orçamento novo" },
          { id: "first_other_doubts", title: "Outras dúvidas" },
        ],
        "início"
      );
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
      return sendButtons(
        phone,
        txt,
        [
          { id: "first_new_budget", title: "Orçamento novo" },
          { id: "first_other_doubts", title: "Outras dúvidas" },
        ],
        "início"
      );
    }
    return;
  }

  // fallback (anti duplicação)
  const fb = "Pra eu te atender certinho:\n\n• me manda a referência em imagem\n• local no corpo\n• tamanho em cm";
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
  });
});

app.post("/", async (req, res) => {
  res.status(200).json({ ok: true });

  try {
    mediaCacheCleanup();
    cleanupProcessed();

    console.log("[WEBHOOK HIT] keys:", Object.keys(req.body || {}));

    const inbound = parseInbound(req.body || {});

    console.log("[INBOUND PARSED]", {
      phone: inbound.phone,
      fromMe: inbound.fromMe,
      messageId: inbound.messageId,
      buttonId: inbound.buttonId,
      hasImageUrl: Boolean(inbound.imageUrl),
      hasImageCacheKey: Boolean(inbound.imageCacheKey),
      imageUrl: inbound.imageUrl ? inbound.imageUrl.slice(0, 120) : null,
      message: inbound.message ? inbound.message.slice(0, 120) : "",
    });

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

    // ✅ lock por telefone primeiro, depois idempotência
    await withPhoneLock(inbound.phone, async () => {
      try {
        console.log("[LOCK] processing phone:", inbound.phone);

        // ✅ idempotência dentro do lock (sem corrida)
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
        // ✅ sempre libera o inflight
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
