// ============================================================
// DW WhatsApp Bot — Versão AGENTE (GPT-4o) + Antiduplicação real
// - fs/promises
// - Sem reset do store no boot
// - Idempotência por messageId (TTL) + fallback por fingerprint (quando messageId vem vazio)
// - Lock por telefone (evita paralelo)
// - Fluxo com botões conforme combinado
// - ✅ IMAGEM + LOCAL = suficiente (tamanho vira opcional e é estimado)
// - ✅ Análise técnica da referência (sem firula) ANTES do preço
// - ✅ Tempo/horas estimado pela IA (com fallback), preço: 1ª hora R$150, demais R$100
// - ✅ In-flight guards (evita corrida entre webhooks simultâneos)
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

  // Preço (ajustado conforme você pediu)
  HOUR_FIRST: Number(process.env.HOUR_FIRST || 150), // ✅ 1ª hora 150
  HOUR_NEXT: Number(process.env.HOUR_NEXT || 100),   // ✅ demais 100

  // PIX + sinal
  PIX_KEY: process.env.PIX_KEY || "",
  SIGNAL_VALUE: Number(process.env.SIGNAL_VALUE || 50),
  SIGNAL_DEADLINE_HOURS: Number(process.env.SIGNAL_DEADLINE_HOURS || 4),

  // System prompt opcional no ENV (se vazio, usa o padrão do código)
  AGENT_SYSTEM_PROMPT: process.env.AGENT_SYSTEM_PROMPT || "",
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

// ✅ fallback idempotência (quando o Z-API não manda messageId ou manda ids diferentes em retry)
function fpHash(s) {
  return crypto.createHash("sha1").update(String(s)).digest("hex");
}

function makeFingerprint(inbound) {
  const base = [
    inbound.phone || "",
    inbound.buttonId || "",
    inbound.message || "",
    inbound.imageUrl || "",
    inbound.imageBase64 ? "b64" : "",
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
    agentContext: [],

    data: {
      name: "",
      bodyPart: "",
      sizeCm: null, // opcional (estimado se não vier)
      referenceImageUrl: "",
      changeNotes: "",

      // análise
      imageSummary: "",
      imageSummaryAt: null,
      imageEstSizeCm: null,
      imageEstHours: null,

      // orçamento final
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

function clamp(n, a, b) {
  const x = Number(n);
  if (!Number.isFinite(x)) return a;
  return Math.max(a, Math.min(b, x));
}

// preço: 1ª hora 150 + demais 100
function priceFromHours(hours) {
  const h = clamp(hours, 1, 20);
  const first = ENV.HOUR_FIRST;
  const rest = Math.max(0, h - 1) * ENV.HOUR_NEXT;
  return Math.round(first + rest);
}

// fallback (se IA falhar)
function fallbackHoursBySize(sizeCm, complexity = "media") {
  const s = Number(sizeCm || 0);
  const base = s <= 12 ? 1.2 : s <= 18 ? 2.0 : s <= 25 ? 3.0 : 4.0;
  const mult = complexity === "alta" ? 1.4 : complexity === "baixa" ? 1.0 : 1.15;
  return clamp(Number((Math.max(1, base * mult)).toFixed(1)), 1, 20);
}

// ============================================================================
// ✅ ANALISAR REFERÊNCIA (IMAGEM) — retorna descrição técnica + estimativas (JSON)
// ============================================================================

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

function descriptionToBullets(summary) {
  const s = String(summary || "").trim();
  if (!s) return "";
  const lines = s
    .split("\n")
    .map((x) => x.trim())
    .filter(Boolean);

  // se já veio em bullets, mantém
  if (lines.some((l) => l.startsWith("•") || l.startsWith("-"))) {
    return lines
      .slice(0, 8)
      .map((l) => (l.startsWith("•") ? l : `• ${l.replace(/^-+\s*/, "")}`))
      .join("\n");
  }

  // quebra por frases curtas
  const parts = s
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(0, 6);

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

/**
 * Retorna:
 * {
 *   description: "texto técnico curto e claro",
 *   estSizeCm: number (8..60),
 *   estHours: number (1..20)
 * }
 */
async function analyzeReferenceImage(imageUrlOrDataUrl, bodyPart = "", changeNotes = "") {
  if (!imageUrlOrDataUrl) return { description: "", estSizeCm: null, estHours: null };

  const promptText =
    "Você é um tatuador especialista. Analise a imagem de referência e responda SOMENTE em JSON válido.\n\n" +
    "Regras:\n" +
    "- Descrição técnica SEM firula, clara e útil pro cliente.\n" +
    "- Cite: tema/assunto, elementos principais, nível de detalhe, sombras/contraste, texturas, pontos que dão mais trabalho.\n" +
    "- Estime TAMANHO BASE em cm para ficar proporcional no local informado (se local vazio, use um tamanho médio).\n" +
    "- Estime HORAS de execução (realismo preto e cinza/whip shading), considerando a complexidade da referência.\n" +
    "- Não dê preço.\n\n" +
    "Schema exato:\n" +
    '{ "description": "string", "estSizeCm": number, "estHours": number }\n\n' +
    `Local no corpo: ${bodyPart || "(não informado)"}\n` +
    `Ajustes/pedidos extras do cliente: ${changeNotes || "(nenhum)"}\n`;

  // 1) tenta direto com URL/DataURL
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

    const raw = String(completion.choices?.[0]?.message?.content || "").trim();
    const parsed = safeJsonParse(raw);

    if (parsed && typeof parsed === "object") {
      const desc = String(parsed.description || "").trim();
      const estSizeCm = parsed.estSizeCm != null ? clamp(parsed.estSizeCm, 8, 60) : null;
      const estHours = parsed.estHours != null ? clamp(parsed.estHours, 1, 20) : null;

      return { description: desc, estSizeCm, estHours };
    }

    // fallback: se a IA não seguiu JSON, usa texto como descrição
    return { description: raw, estSizeCm: null, estHours: null };
  } catch (e1) {
    console.error("[IMAGE ANALYSIS DIRECT ERROR]", e1?.message || e1);

    // 2) fallback: se for URL http(s), baixa e manda base64
    try {
      if (/^https?:\/\//i.test(imageUrlOrDataUrl)) {
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

        const raw2 = String(completion2.choices?.[0]?.message?.content || "").trim();
        const parsed2 = safeJsonParse(raw2);

        if (parsed2 && typeof parsed2 === "object") {
          const desc = String(parsed2.description || "").trim();
          const estSizeCm = parsed2.estSizeCm != null ? clamp(parsed2.estSizeCm, 8, 60) : null;
          const estHours = parsed2.estHours != null ? clamp(parsed2.estHours, 1, 20) : null;
          return { description: desc, estSizeCm, estHours };
        }

        return { description: raw2, estSizeCm: null, estHours: null };
      }

      return { description: "", estSizeCm: null, estHours: null };
    } catch (e2) {
      console.error("[IMAGE ANALYSIS BASE64 ERROR]", e2?.message || e2);
      return { description: "", estSizeCm: null, estHours: null };
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

// ✅ envia texto respeitando antiRepeat
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

  // URL de imagem em vários formatos
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

  // base64/data url (se algum provedor mandar)
  const imageBase64 = pickFirstString(
    body?.image?.base64,
    body?.data?.image?.base64,
    body?.data?.message?.image?.base64,
    body?.data?.message?.imageMessage?.base64,
    body?.data?.message?.imageMessage?.jpegThumbnail // às vezes é miniatura; ainda ajuda
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

  // normaliza imageBase64 para dataURL se parecer base64 puro
  let imageDataUrl = null;
  if (imageBase64) {
    const b = imageBase64.trim();
    if (/^data:image\//i.test(b)) imageDataUrl = b;
    else if (/^[A-Za-z0-9+/=]+$/.test(b) && b.length > 200) imageDataUrl = `data:image/jpeg;base64,${b}`;
  }

  return {
    phone: phone ? String(phone) : null,
    fromMe,
    contactName: String(contactName || "").trim(),
    messageId: messageId ? String(messageId) : null,
    buttonId: buttonId ? String(buttonId) : null,
    message: text,
    imageUrl: imageUrl ? String(imageUrl) : null,
    imageBase64: imageDataUrl, // data:image/...;base64,...
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

// -------------------- SYSTEM PROMPT (final) --------------------
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
- (tamanho em cm é opcional)

4) Quando tiver referência + local:
Pergunte com botões:
"Você quer ajustar algo na ideia antes do orçamento?"
Botões:
- Quero ajustar
- Está tudo certo

5) Ajustar => peça a ideia/ajustes.
6) Está tudo certo => backend monta a análise técnica e o orçamento final (com horas estimadas e preço).
Depois pergunte se quer agendar.

7) Se quiser agendar: backend manda 4 botões de horário. Você confirma e pede o sinal:
- Sinal R$ 50 (ou valor do sistema)
- Prazo pra enviar comprovante e segurar a reserva

8) Comprovante recebido:
Agradeça e mande cuidados pré tattoo (com \\n\\n):
- água
- evitar álcool véspera
- comer bem
- hidratar pele
- evitar sol forte na área

9) Se o cliente pedir "quero falar com você / dúvidas": HANDOFF.
`;

const AGENT_SYSTEM = (ENV.AGENT_SYSTEM_PROMPT || "").trim() || DEFAULT_AGENT_SYSTEM;

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

  if (set.data && typeof set.data === "object") {
    session.data = { ...session.data, ...set.data };
  }
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

// -------------------- FLOW CONTROLLER (backend) --------------------
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

  // texto: tenta local/tamanho (tamanho opcional)
  if (inbound.message) {
    const bp = parseBodyPart(inbound.message);
    const sz = parseSizeCm(inbound.message);
    if (bp) session.data.bodyPart = bp;
    if (sz) session.data.sizeCm = sz;
  }

  // ✅ imagem: guarda + analisa (se for nova)
  const incomingImageRef = inbound.imageUrl || inbound.imageBase64 || null;
  if (incomingImageRef) {
    const isNew = incomingImageRef !== session.data.referenceImageUrl;
    session.data.referenceImageUrl = incomingImageRef;

    if (isNew) {
      const r = await analyzeReferenceImage(
        incomingImageRef,
        session.data.bodyPart || "",
        session.data.changeNotes || ""
      );

      session.data.imageSummary = r.description || "";
      session.data.imageEstSizeCm = r.estSizeCm != null ? r.estSizeCm : null;
      session.data.imageEstHours = r.estHours != null ? r.estHours : null;
      session.data.imageSummaryAt = nowMs();

      console.log("[IMAGE ANALYZED]", {
        ok: Boolean(session.data.imageSummary),
        chars: (session.data.imageSummary || "").length,
        estSizeCm: session.data.imageEstSizeCm,
        estHours: session.data.imageEstHours,
      });
    }
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
      session.stage = "collect_ref_body";
      scheduleSaveStore();

      const agentJson = await agentReply(session, "NEW_BUDGET");
      return applyAgentAction(phone, session, agentJson);
    }

    const txt =
      "Só me confirma como você quer seguir:\n\n" +
      "• Orçamento novo\n" +
      "• Outras dúvidas";
    return sendButtons(phone, txt, [
      { id: "first_new_budget", title: "Orçamento novo" },
      { id: "first_other_doubts", title: "Outras dúvidas" },
    ], "início");
  }

  if (session.stage === "handoff") {
    return;
  }

  // ✅ AGORA: só precisa IMAGEM + LOCAL (tamanho opcional)
  if (session.stage === "collect_ref_body") {
    const missing = [];
    if (!session.data.referenceImageUrl) missing.push("referência em imagem");
    if (!session.data.bodyPart) missing.push("local no corpo");

    if (missing.length > 0) {
      const agentJson = await agentReply(session, "MISSING_INFO", { missing, message: inbound.message || "" });
      return applyAgentAction(phone, session, agentJson);
    }

    // se não veio tamanho, usa estimativa da análise; se ainda não tiver, fallback simples
    if (!session.data.sizeCm) {
      if (session.data.imageEstSizeCm) session.data.sizeCm = session.data.imageEstSizeCm;
      else session.data.sizeCm = 18; // fallback neutro
      scheduleSaveStore();
    }

    session.stage = "ask_edit";
    scheduleSaveStore();

    const agentJson = await agentReply(session, "HAVE_MIN_INFO");
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
      return sendButtons(phone, txt, [
        { id: "edit_yes", title: "Quero ajustar" },
        { id: "edit_no", title: "Está tudo certo" },
      ], "ajustes");
    }
  }

  if (session.stage === "collect_changes") {
    const msg = (inbound.message || "").trim();
    if (msg) session.data.changeNotes = (session.data.changeNotes ? session.data.changeNotes + "\n" : "") + msg;

    // se já tem imagem, reanalisa com os changeNotes (pra ajustar horas)
    if (session.data.referenceImageUrl) {
      const r = await analyzeReferenceImage(
        session.data.referenceImageUrl,
        session.data.bodyPart || "",
        session.data.changeNotes || ""
      );
      session.data.imageSummary = r.description || session.data.imageSummary || "";
      session.data.imageEstSizeCm = r.estSizeCm != null ? r.estSizeCm : session.data.imageEstSizeCm;
      session.data.imageEstHours = r.estHours != null ? r.estHours : session.data.imageEstHours;
      session.data.imageSummaryAt = nowMs();
      if (!session.data.sizeCm && session.data.imageEstSizeCm) session.data.sizeCm = session.data.imageEstSizeCm;
      scheduleSaveStore();

      console.log("[IMAGE RE-ANALYZED]", {
        ok: Boolean(session.data.imageSummary),
        chars: (session.data.imageSummary || "").length,
        estSizeCm: session.data.imageEstSizeCm,
        estHours: session.data.imageEstHours,
      });
    }

    session.stage = "quote";
    scheduleSaveStore();
  }

  if (session.stage === "quote") {
    // horas: IA primeiro; fallback por tamanho/complexidade
    const complexity = session.data.changeNotes ? "alta" : "media";

    let hours = session.data.imageEstHours;
    if (!hours) hours = fallbackHoursBySize(session.data.sizeCm, complexity);
    hours = clamp(hours, 1, 20);

    const total = priceFromHours(hours);

    session.data.estHours = Number(hours.toFixed(1));
    session.data.estTotal = total;
    scheduleSaveStore();

    const agentJson = await agentReply(session, "QUOTE_READY");

    const bullets = descriptionToBullets(session.data.imageSummary);
    const sizeLine = session.data.sizeCm ? `• Tamanho base estimado: ${session.data.sizeCm}cm (ajustável)\n` : "";

    const preface =
      bullets
        ? "Pela sua referência, o trabalho envolve:\n\n" +
          `${bullets}\n\n`
        : "Fechado.\n\n";

    const quoteText =
      preface +
      `No(a) ${session.data.bodyPart}, a estimativa fica assim:\n\n` +
      (sizeLine || "") +
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

    const txt =
      "Show.\n\nSeparei algumas opções pra você escolher (ou me diz um horário específico):";
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
    if (incomingImageRef || messageLooksLikeReceipt(inbound.message)) {
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

  // fallback (sem triplicar)
  const fb =
    "Pra eu te atender certinho:\n\n" +
    "• me manda a referência em imagem\n" +
    "• local no corpo\n" +
    "(tamanho em cm é opcional)";
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
    console.log("[WEBHOOK HIT] keys:", Object.keys(req.body || {}));

    const inbound = parseInbound(req.body || {});
    const fp = makeFingerprint(inbound);

    console.log("[INBOUND PARSED]", {
      phone: inbound.phone,
      fromMe: inbound.fromMe,
      messageId: inbound.messageId,
      buttonId: inbound.buttonId,
      hasImageUrl: Boolean(inbound.imageUrl),
      hasImageBase64: Boolean(inbound.imageBase64),
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

    // ✅ In-flight guard: bloqueia duplicado simultâneo antes de qualquer coisa
    if (inbound.messageId) {
      if (INFLIGHT_MSG.has(inbound.messageId)) {
        console.log("[IGNORED] inflight messageId:", inbound.messageId);
        return;
      }
      INFLIGHT_MSG.add(inbound.messageId);
    } else {
      if (INFLIGHT_FP.has(fp)) {
        console.log("[IGNORED] inflight fingerprint:", fp);
        return;
      }
      INFLIGHT_FP.add(fp);
    }

    try {
      // idempotência por messageId
      if (inbound.messageId && wasProcessed(inbound.messageId)) {
        console.log("[IGNORED] already processed:", inbound.messageId);
        return;
      }

      // fallback idempotência por fingerprint (quando não tem messageId)
      if (!inbound.messageId && wasProcessedFp(fp)) {
        console.log("[IGNORED] already processed fp:", fp);
        return;
      }

      if (inbound.messageId) markProcessed(inbound.messageId, inbound.phone);
      else markProcessedFp(fp, inbound.phone);

      cleanupProcessed();

      await withPhoneLock(inbound.phone, async () => {
        console.log("[LOCK] processing phone:", inbound.phone);
        await handleInbound(inbound.phone, inbound);
        console.log("[DONE] processed phone:", inbound.phone);
      });
    } finally {
      // libera inflight
      if (inbound.messageId) INFLIGHT_MSG.delete(inbound.messageId);
      else INFLIGHT_FP.delete(fp);
    }
  } catch (e) {
    console.error("[WEBHOOK ERROR]", e?.message || e);
  }
});

// -------------------- BOOT --------------------
async function boot() {
  await loadStore();
  cleanupProcessed();

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
