// app.js (ESM)
// ENV no Render:
// OPENAI_API_KEY
// ZAPI_INSTANCE_ID
// ZAPI_INSTANCE_TOKEN
// ZAPI_CLIENT_TOKEN
// (opcional) SYSTEM_PROMPT
// (opcional) PIX_KEY
// (opcional) OWNER_PHONE   // ex: 5544999999999

import express from "express";
import OpenAI from "openai";

const GCAL_ENABLED = process.env.GCAL_ENABLED === "true";
const GCAL_CALENDAR_ID = process.env.GCAL_CALENDAR_ID || "";
const GCAL_SERVICE_ACCOUNT_JSON_BASE64 = process.env.GCAL_SERVICE_ACCOUNT_JSON_BASE64 || "";
const GCAL_SLOT_MINUTES = parseInt(process.env.GCAL_SLOT_MINUTES || "60");
const GCAL_TZ = process.env.GCAL_TZ || "America/Sao_Paulo";
const GCAL_WORK_HOURS_WEEKDAY = process.env.GCAL_WORK_HOURS_WEEKDAY || "0-23";
const GCAL_WORK_HOURS_WEEKEND = process.env.GCAL_WORK_HOURS_WEEKEND || "0-23";

const app = express();
app.use(express.json({ limit: "25mb" }));

/* DW_RULES_AGENDAMENTO
 * - Nunca pedir Pix/sinal antes de: (a) orçamento entregue e (b) agendamento confirmado no Calendar.
 * - Sugestões de agenda devem usar Google Calendar free/busy para não colidir com eventos existentes.
 */

// -------------------- ENV --------------------
const ENV = {
  OPENAI_API_KEY: process.env.OPENAI_API_KEY || "",
  ZAPI_INSTANCE_ID: process.env.ZAPI_INSTANCE_ID || "",
  ZAPI_INSTANCE_TOKEN: process.env.ZAPI_INSTANCE_TOKEN || "",
  ZAPI_CLIENT_TOKEN: process.env.ZAPI_CLIENT_TOKEN || "",
  SYSTEM_PROMPT: process.env.SYSTEM_PROMPT || "",
  PIX_KEY: process.env.PIX_KEY || "",
  OWNER_PHONE: process.env.OWNER_PHONE || "",
  PORT: process.env.PORT || "10000",
};

function missingEnvs() {
  const req = ["OPENAI_API_KEY", "ZAPI_INSTANCE_ID", "ZAPI_INSTANCE_TOKEN", "ZAPI_CLIENT_TOKEN"];
  return req.filter((k) => !ENV[k] || String(ENV[k]).trim() === "");
}

const openai = new OpenAI({ apiKey: ENV.OPENAI_API_KEY });

// -------------------- Session (RAM) --------------------
const sessions = {}; // key: phone
function getSession(phone) {
  if (!sessions[phone]) {
    sessions[phone] = {
      stage: "inicio",

      // first-contact gate
      askedFirstContact: false,
      firstContactResolved: false,

      // referência / info
      imageDataUrl: null,
      descriptionText: null,
      descriptionConfirmed: false,
      pendingDescChanges: "",
      imageSummary: null,
      sizeLocation: null,
      bodyRegion: null,
      isCoverup: false,

      // ordem / flags
      greeted: false,
      greetVariant: null,
      closingVariant: null,

      sentSummary: false,
      askedDoubts: false,
      doubtsResolved: false,
      sentQuote: false,

      // sinal / agenda
      depositConfirmed: false,
      askedSchedule: false,
      scheduleCaptured: false,
      scheduleConfirmed: false,
      suggestedSlots: null,
      durationMin: null,
      sentDepositRequest: false,
      waitingSchedule: false,
      manualHandoff: false,

      // controle
      awaitingBWAnswer: false,
      finished: false,
      lastOwnerNotifyAt: 0,

      // prazo comprovante (4h)
      depositDeadlineAt: 0, // timestamp (ms)
      sentDepositDeadlineInfo: false, // falou das 4h pelo menos 1x (no agendamento)
      waitingReceipt: false, // cliente disse "já já mando"

      // follow-up 30min (pra “vou ver e te aviso” ou sumiço pós-orçamento)
      followupTimer: null,
      followupSent: false,
      lastClientMsgAt: 0,

      // lembrete cuidados após confirmação do agendamento (cliente confirma depois do horário que você manda)
      sentAfterConfirmReminder: false,

      // anti spam/loop
      lastReply: null,
      lastReplyAt: 0,

      // buffer p/ juntar mensagens (imagem + local, etc)
      pending: {
        timer: null,
        textParts: [],
        lastContactName: null,
        imageUrl: null,
        imageMime: "image/jpeg",
        messageType: "",
      },
    };
  }
  return sessions[phone];
}

function resetSession(phone) {
  const s = sessions[phone];
  if (s?.followupTimer) {
    try {
      clearTimeout(s.followupTimer);
    } catch {}
  }
  delete sessions[phone];
}

function antiRepeat(session, reply) {
  const now = Date.now();
  if (session.lastReply === reply && now - session.lastReplyAt < 90_000) return true;
  session.lastReply = reply;
  session.lastReplyAt = now;
  return false;
}

// -------------------- smart delay --------------------
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isSimpleAck(text) {
  const t = String(text || "").toLowerCase().trim();
  return /^(ok|blz|beleza|fechou|show|top|tmj|valeu|isso|sim|não|nao)$/i.test(t);
}

function detectRegionOrSizeHint(text) {
  const t = (text || "").toLowerCase();
  return (
    /(antebra[cç]o|bra[cç]o|ombro|peito|costela|perna|coxa|panturrilha|canela|m[aã]o|pesco[cç]o|nuca|costas|esc[aá]pula|coluna|rosto|cabe[cç]a|tornozelo|punho|dedo)/i.test(
      t
    ) ||
    /(\d+\s*(cm|cent[ií]metro|centimetro|mm|mil[ií]metro|milimetro)|\d+\s*x\s*\d+)/i.test(t)
  );
}

function stageIsDoubts(stage) {
  return stage === "aguardando_duvidas";
}

function computeDelayMs(session, mergedText, hasImage) {
  const t = String(mergedText || "");
  if (hasImage) return 10_000; // referência: sempre 10s
  if (detectRegionOrSizeHint(t)) return 10_000; // info importante: 10s
  if (stageIsDoubts(session.stage)) return 5_000; // dúvidas: 5s
  if (isSimpleAck(t)) return 2_500; // curto e natural
  return 3_500; // padrão humano
}

// -------------------- follow-up 30min --------------------
function clearFollowup(session) {
  if (session.followupTimer) {
    try {
      clearTimeout(session.followupTimer);
    } catch {}
  }
  session.followupTimer = null;
}

function scheduleFollowup30min(phone, session, reason = "geral") {
  if (session.followupSent) return;
  clearFollowup(session);

  session.followupTimer = setTimeout(() => {
    session.followupTimer = null;
    if (session.followupSent) return;

    // só dispara se ainda estiver em etapas “quentes”
    const stageOk =
      session.stage === "pos_orcamento" ||
      session.stage === "aguardando_duvidas" ||
      session.stage === "aguardando_info" ||
      session.stage === "aguardando_referencia";

    if (!stageOk) return;

    const msg =
      "Compreendo perfeitamente, uma tatuagem é uma decisão importante e é ótimo que você queira pensar com calma.\n\n" +
      "Pra eu te ajudar nesse processo, existe algo específico que está te deixando em dúvida?\n" +
      "Talvez sobre o *design*, o *orçamento* ou a *data*.\n\n" +
      "Se tiver alguma preocupação que eu possa esclarecer agora, eu te ajudo por aqui. Meu objetivo é que você se sinta seguro e bem atendido.";

    zapiSendText(phone, msg).catch(() => {});
    session.followupSent = true;

    // avisa dono só pra ciência (sem travar fluxo)
    notifyOwner(
      [
        "⏳ FOLLOW-UP 30MIN (bot)",
        `• Cliente: ${String(phone).replace(/\D/g, "")}`,
        `• Motivo: ${reason}`,
        `• Etapa: ${session.stage}`,
      ].join("\n")
    ).catch(() => {});
  }, 30 * 60 * 1000);
}

// -------------------- Z-API Send --------------------
function zapiBaseUrl() {
  return `https://api.z-api.io/instances/${ENV.ZAPI_INSTANCE_ID}/token/${ENV.ZAPI_INSTANCE_TOKEN}`;
}

async function zapiSendText(phone, message) {
  const url = `${zapiBaseUrl()}/send-text`;

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "client-token": ENV.ZAPI_CLIENT_TOKEN,
    },
    body: JSON.stringify({
      phone: String(phone).replace(/\D/g, ""),
      message: String(message || ""),
    }),
  });

  const body = await resp.text().catch(() => "");
  if (!resp.ok) throw new Error(`[ZAPI SEND FAILED] ${resp.status} ${body}`);
  return body;
}

// -------------------- OWNER notify --------------------
async function notifyOwner(text) {
  if (!ENV.OWNER_PHONE) return;
  try {
    await zapiSendText(ENV.OWNER_PHONE, text);
  } catch (e) {
    console.log("[OWNER NOTIFY FAIL]", e?.message || e);
  }
}

// -------------------- INBOUND normalize --------------------
function parseZapiInbound(body) {
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

  const message =
    body?.message ||
    body?.text?.message ||
    body?.text ||
    body?.Body ||
    body?.data?.message ||
    body?.data?.text ||
    "";

  const imageUrl =
    body?.image?.imageUrl ||
    body?.image?.url ||
    body?.imageUrl ||
    body?.message?.image?.url ||
    body?.media?.url ||
    body?.data?.image?.imageUrl ||
    body?.data?.imageUrl ||
    body?.data?.mediaUrl ||
    null;

  const imageMime =
    body?.image?.mimeType ||
    body?.image?.mimetype ||
    body?.mimeType ||
    body?.data?.mimeType ||
    "image/jpeg";

  const fromMe = Boolean(body?.fromMe || body?.data?.fromMe);

  const messageType =
    body?.messageType ||
    body?.type ||
    body?.data?.messageType ||
    body?.data?.type ||
    "";

  const contactName =
    body?.senderName ||
    body?.pushName ||
    body?.contact?.name ||
    body?.data?.senderName ||
    body?.data?.pushName ||
    body?.data?.contact?.name ||
    null;

  return {
    phone: phone ? String(phone) : null,
    message: String(message || "").trim(),
    imageUrl: imageUrl ? String(imageUrl) : null,
    imageMime: String(imageMime || "image/jpeg"),
    fromMe,
    messageType: String(messageType || ""),
    contactName: contactName ? String(contactName).trim() : null,
    raw: body,
  };
}

// -------------------- fetchImage --------------------
async function fetchImageAsDataUrl(url, mimeHint = "image/jpeg") {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 15000);

  try {
    const resp = await fetch(url, {
      method: "GET",
      headers: {
        "client-token": ENV.ZAPI_CLIENT_TOKEN,
        Accept: "image/*,*/*;q=0.8",
        "User-Agent": "Mozilla/5.0",
      },
      signal: controller.signal,
    });

    if (!resp.ok) {
      const tx = await resp.text().catch(() => "");
      throw new Error(`Image download failed: ${resp.status} ${tx}`);
    }

    const ct = (resp.headers.get("content-type") || "").split(";")[0].trim();
    const mime = ct || mimeHint || "image/jpeg";

    const arr = await resp.arrayBuffer();
    if (arr.byteLength > 8 * 1024 * 1024) throw new Error("Image too large");

    const b64 = Buffer.from(arr).toString("base64");
    return `data:${mime};base64,${b64}`;
  } finally {
    clearTimeout(t);
  }
}

// -------------------- utils --------------------
function pickOne(arr) {
  if (!Array.isArray(arr) || !arr.length) return null;
  return arr[Math.floor(Math.random() * arr.length)];
}

function safeName(name) {
  const n = String(name || "").trim();
  if (!n) return "";
  if (n.length > 24) return n.slice(0, 24);
  if (/undefined|null|unknown/i.test(n)) return "";
  return n;
}

// -------------------- GREETINGS / CLOSINGS --------------------
const GREETINGS = [
  (name) =>
    `Olá${name ? `, ${name}` : ""}! Oi, aqui é o DW Tattooer, especialista em tatuagens realistas em preto e cinza e whip shading.\n\n` +
    `Pra eu te atender do jeito certo, me diz uma coisa rapidinho:\n` +
    `Você já tem um *orçamento em andamento* comigo e quer continuar, ou quer *começar um orçamento novo do zero*?`,
  (name) =>
    `Oi${name ? `, ${name}` : ""}! Aqui é o DW Tattooer — realismo preto e cinza e whip shading.\n\n` +
    `Só pra eu te direcionar certinho:\n` +
    `Você já tem um *orçamento em andamento* comigo (pra continuar), ou é um *orçamento novo do zero*?`,
];

const CLOSINGS = [
  () =>
    `Fechado.\n\n` +
    `• Obrigado pela confiança.\n` +
    `• Qualquer dúvida, é só me chamar.\n` +
    `• Se precisar remarcar, só peço 48h de antecedência.\n\n` +
    `A gente se vê na sessão.`,
  () =>
    `Show!\n\n` +
    `• Valeu por fechar comigo.\n` +
    `• Qualquer dúvida até o dia, me chama.\n` +
    `• Remarcação: 48h de antecedência.\n\n` +
    `Até a sessão.`,
];

function chooseGreetingOnce(session, contactName) {
  if (!session.greetVariant) session.greetVariant = pickOne(GREETINGS) || GREETINGS[0];
  const nm = safeName(contactName);
  return session.greetVariant(nm);
}

function chooseClosingOnce(session) {
  if (!session.closingVariant) session.closingVariant = pickOne(CLOSINGS) || CLOSINGS[0];
  return session.closingVariant();
}

// -------------------- Business rules --------------------
function detectCoverup(text) {
  const t = (text || "").toLowerCase();
  return /cobertura|cover\s?up|tapar|tampar|por cima|cover/i.test(t);
}

function extractSizeLocation(text) {
  const t = (text || "").trim();
  if (!t) return null;
  if (!/\d/.test(t)) return null;
  return t;
}

function extractBodyRegion(text) {
  const t = (text || "").toLowerCase();

  const regions = [
    "mão",
    "mao",
    "dedo",
    "punho",
    "antebraço",
    "antebraco",
    "braço",
    "braco",
    "ombro",
    "peito",
    "costela",
    "pescoço",
    "pescoco",
    "nuca",
    "pé",
    "pe",
    "tornozelo",
    "panturrilha",
    "canela",
    "coxa",
    "joelho",
    "virilha",
    "costas",
    "escápula",
    "escapula",
    "coluna",
    "rosto",
    "cabeça",
    "cabeca",
  ];

  for (const r of regions) {
    if (t.includes(r)) {
      if (r === "mao") return "mão";
      if (r === "pescoco") return "pescoço";
      if (r === "pe") return "pé";
      if (r === "antebraco") return "antebraço";
      if (r === "braco") return "braço";
      if (r === "escapula") return "escápula";
      if (r === "cabeca") return "cabeça";
      return r;
    }
  }
  return null;
}

function askedPix(text) {
  const t = (text || "").toLowerCase();
  return /qual\s*o\s*pix|chave\s*pix|me\s*passa\s*o\s*pix|pix\?/i.test(t);
}

function askedAddress(text) {
  const t = (text || "").toLowerCase();
  return /onde\s*fica|endereço|endereco|localização|localizacao|como\s*chego|qual\s*o\s*endereço|qual\s*o\s*endereco/i.test(t);
}

function detectThanks(text) {
  const t = (text || "").toLowerCase();
  return /obrigad|valeu|tmj|agradeço|fechou|show|top|blz|beleza/i.test(t);
}

// confirma agendamento (cliente confirmou depois do horário que você mandou manualmente)
function detectAppointmentConfirm(text) {
  const t = (text || "").toLowerCase();
  return /confirm|confirmado|combinado|perfeito|fechado|ok|beleza|show|top|tá\s*confirmado|ta\s*confirmado/i.test(t);
}

// Black & Grey only
function detectColorIntentByText(text) {
  const t = (text || "").toLowerCase();
  return /colorid|color|cores|vermelh|azul|amarel|verde|roxo|rosa|laranj|aquarel|new\s*school/i.test(t);
}

function detectColorIntentBySummary(summary) {
  const s = (summary || "").toLowerCase();
  return /colorid|cores|color|tinta\s*colorida/i.test(s);
}

function detectBWAccept(text) {
  const t = (text || "").toLowerCase();
  if (/\b(sim|aceito|pode|fechado|bora|ok|topo|manda|vamo)\b/i.test(t)) return "yes";
  if (
    /\b(n[aã]o|nao|prefiro\s*color|quero\s*color|n[aã]o\s*quero\s*preto|nao\s*quero\s*preto)\b/i.test(t)
  )
    return "no";
  return "";
}

// agenda
function detectCommercialPref(text) {
  const t = (text || "").toLowerCase();
  if (/(p[oó]s|pos)[ -]?comercial|noite|ap[oó]s\s*o\s*trabalho|depois\s*do\s*trabalho/i.test(t)) return "pos";
  if (/comercial|manh[aã]|tarde|hor[aá]rio\s*comercial/i.test(t)) return "comercial";
  return "";
}

function detectNoSpecificDate(text) {
  const t = (text || "").toLowerCase();
  return /pr[oó]xim[ao]\s*(hor[aá]rio|data)\s*(livre|dispon[ií]vel)|qualquer\s*data|pr[oó]xima\s*data|pode\s*marcar\s*no\s*pr[oó]ximo|o\s*que\s*voc[eê]\s*tiver/i.test(
    t
  );
}

function detectHasSpecificDate(text) {
  const t = (text || "").toLowerCase();
  return /(\d{1,2}\/\d{1,2})|(\d{1,2}\-\d{1,2})|dia\s*\d{1,2}|(segunda|ter[cç]a|quarta|quinta|sexta|s[aá]bado|domingo)/i.test(
    t
  );
}

// comprovante confirmado só com FOTO (imageUrl) após agendamento
function detectDepositTextOnly(text) {
  const t = (text || "").toLowerCase();
  return /comprovante|pix\s*feito|pix\s*realizado|paguei|pago|transferi|transferência|transferencia|sinal|enviei\s*o\s*pix|mandei\s*o\s*pix|caiu\s*o\s*pix|confirmad/i.test(
    t
  );
}

function detectWillSendReceipt(text) {
  const t = (text || "").toLowerCase();
  return (
    /(ja\s*ja|já\s*já|logo|daqui\s*a\s*pouco|vou\s*mandar|já\s*vou\s*mandar|vou\s*enviar|ja\s*envio|já\s*envio|assim\s*que\s*eu\s*fizer|assim\s*que\s*eu\s*conseguir|to\s*fazendo|tô\s*fazendo)/i.test(
      t
    ) &&
    /(comprovante|pix|sinal|transfer|pagamento)/i.test(t)
  );
}

function detectReceiptContext(session, message) {
  // evita o bot tentar analisar comprovante como "referência"
  const t = (message || "").toLowerCase();
  if (session.scheduleConfirmed || session.stage === "aguardando_comprovante") return true;
  if (session.waitingReceipt) return true;
  if (session.depositDeadlineAt && session.depositDeadlineAt > 0) return true;
  if (/comprovante|pix|sinal|pagamento|transfer/i.test(t)) return true;
  return false;
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function fmtDateBR(date) {
  const d = new Date(date);
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yy = d.getFullYear();
  return `${dd}/${mm}/${yy}`;
}

function dayOfWeek(date) {
  return new Date(date).getDay(); // 0 dom ... 6 sab
}

function pickPreferredDaysQueue() {
  // Ter(2), Qui(4), Sex(5), Sab(6) -> 4 opções
  return [2, 4, 5, 6];
}

function pickTimeWindows() {
  // manhã / tarde / noite (ajuste conforme necessário)
  return [
    { label: "Manhã", timeHM: "09:30" },
    { label: "Tarde", timeHM: "14:30" },
    { label: "Noite", timeHM: "19:30" },
  ];
}

// Espera existir integração Google Calendar (free/busy). Se já existir, adapte para usar a sua.
async function calendarFreeBusy({ timeMinISO, timeMaxISO }) {
  if (typeof getCalendarBusyRanges === "function") {
    return await getCalendarBusyRanges({ timeMinISO, timeMaxISO });
  }
  console.warn("[calendarFreeBusy] Integração não configurada; retornando agenda livre.");
  return [];
}

function overlapsBusy(slotStartISO, slotEndISO, busyRanges) {
  const s = new Date(slotStartISO).getTime();
  const e = new Date(slotEndISO).getTime();
  for (const b of busyRanges || []) {
    const bs = new Date(b.startISO || b.start).getTime();
    const be = new Date(b.endISO || b.end).getTime();
    if (Math.max(s, bs) < Math.min(e, be)) return true;
  }
  return false;
}

async function buildNextAvailableSuggestionsDW({ durationMin = 180 }) {
  const preferredDays = pickPreferredDaysQueue(); // [Ter,Qui,Sex,Sab]
  const windows = pickTimeWindows(); // 3 janelas
  const now = new Date();
  const horizonDays = 21; // procura nas próximas 3 semanas

  const timeMinISO = startOfDay(now).toISOString();
  const timeMaxISO = addDays(startOfDay(now), horizonDays).toISOString();
  const busyRanges = await calendarFreeBusy({ timeMinISO, timeMaxISO });

  const suggestions = [];

  for (let i = 1; i <= horizonDays && suggestions.length < 4; i += 1) {
    const d = addDays(now, i);
    const dow = dayOfWeek(d);
    if (!preferredDays.includes(dow)) continue;

    for (const w of windows) {
      const slotStart = new Date(d);
      const [hh, mm] = w.timeHM.split(":").map(Number);
      slotStart.setHours(hh, mm, 0, 0);

      const slotEnd = new Date(slotStart);
      slotEnd.setMinutes(slotEnd.getMinutes() + durationMin);

      if (slotStart.getTime() < now.getTime()) continue;

      const slotStartISO = slotStart.toISOString();
      const slotEndISO = slotEnd.toISOString();

      if (!overlapsBusy(slotStartISO, slotEndISO, busyRanges)) {
        suggestions.push({
          dateBR: fmtDateBR(slotStart),
          dateISO: slotStartISO.slice(0, 10),
          timeHM: w.timeHM,
          label: `${w.label} (${w.timeHM})`,
          startISO: slotStartISO,
          endISO: slotEndISO,
          dow,
        });
        break;
      }
    }
  }

  return suggestions;
}

function buildCalendarTitle(session, phone) {
  const name = session?.pending?.lastContactName || "Cliente";
  return `Tattoo - ${name} (${String(phone).replace(/\D/g, "")})`;
}

async function upsertCalendarHoldOrEvent({ session, phone, dateISO, timeHM, durationMin, title }) {
  if (typeof createCalendarHold === "function") {
    return await createCalendarHold({ session, phone, dateISO, timeHM, durationMin, title });
  }
  if (typeof createCalendarEvent === "function") {
    return await createCalendarEvent({ session, phone, dateISO, timeHM, durationMin, title });
  }

  console.warn("[calendar] Integração não configurada; armazenando hold local.");
  session.calendarHold = { dateISO, timeHM, durationMin, title };
  return { ok: true, fallback: true };
}

function parseChoice1to4(text) {
  const t = (text || "").trim();
  if (/^[1-4]$/.test(t)) return Number(t);
  const m = t.match(/\b([1-4])\b/);
  return m ? Number(m[1]) : null;
}

// desconto / “tem como melhorar?” pós-orçamento
function detectDiscountAsk(text) {
  const t = (text || "").toLowerCase();
  return /desconto|melhorar\s*o\s*valor|abaixar|faz\s*por\s*menos|negociar|fecha\s*por|tem\s*como\s*fazer\s*por|d[aá]\s*uma\s*for[cç]a|d[aá]\s*pra\s*ajustar/i.test(
    t
  );
}

// fechamento grande (não perguntar tamanho aproximado)
function detectLargeProject(text) {
  const t = (text || "").toLowerCase();
  return /fechamento|fechar\s*o\s*bra[cç]o|bra[cç]o\s*fechado|fechar\s*as\s*costas|costas\s*fechada|costas\s*inteira|costas\s*fechamento|manga\s*fechada|sleeve/i.test(
    t
  );
}

// -------------------- PRIMEIRO CONTATO (gate) --------------------
function detectFirstContactAnswer(text) {
  const t = (text || "").toLowerCase().trim();

  // EM ANDAMENTO (continuar orçamento)
  if (/^n[aã]o$|^nao$/.test(t)) return "ongoing";
  if (/andamento|or[cç]amento\s*em\s*andamento|continuar|dar\s*continuidade|já\s*tenho|ja\s*tenho|já\s*fiz|ja\s*fiz/i.test(t))
    return "ongoing";

  // ORÇAMENTO NOVO (do zero)
  if (/^sim$/.test(t)) return "first";
  if (/primeir[ao]|1a\s*vez|primeira\s*vez|novo\s*or[cç]amento|do\s*zero|come[cç]ando|comecando|novo/i.test(t))
    return "first";

  return "";
}

// -------------------- DÚVIDAS / INTENTS --------------------
function askedPain(text) {
  const t = String(text || "").toLowerCase();
  return /do[ií]|d[oó]i\s*muito|vai\s*doer|dor|aguenta|sens[ií]vel|anest[eé]s|anestesia/i.test(t);
}

function askedTime(text) {
  const t = String(text || "").toLowerCase();
  return /tempo|demora|quantas\s*sess|qnt\s*sess|dura[cç][aã]o|dura|termina\s*em\s*1|uma\s*sess[aã]o|duas\s*sess/i.test(t);
}

function askedPrice(text) {
  const t = String(text || "").toLowerCase();
  return /quanto\s*custa|valor|pre[cç]o|or[cç]amento|investimento|fica\s*quanto/i.test(t);
}

function askedHesitation(text) {
  const t = String(text || "").toLowerCase();
  return /vou\s*ver|te\s*aviso|preciso\s*pensar|depois\s*eu\s*falo|talvez|to\s*na\s*d[uú]vida|vou\s*avaliar|vou\s*falar\s*com\s*algu[eé]m|vejo\s*e\s*te\s*falo/i.test(
    t
  );
}

function answeredNoDoubts(text) {
  const t = String(text || "").toLowerCase();
  return /\b(ok|tudo\s*certo|tranquilo|fechado|sem\s*d[uú]vidas|blz|beleza|deboa|de boa|pode\s*mandar)\b/i.test(t);
}

// ✅ NOVO modelo (dor) — do jeito que você pediu
function msgDorResposta() {
  return (
    "Entendo perfeitamente sua preocupação com a dor, é uma dúvida muito comum.\n" +
    "A sensação varia bastante de pessoa pra pessoa e também da área do corpo.\n\n" +
    "A maioria dos meus clientes descreve como um desconforto suportável — mais uma ardência ou arranhão intenso do que uma dor excruciante.\n" +
    "Eu trabalho num ritmo que minimiza isso ao máximo e fazemos pausas sempre que precisar.\n\n" +
    "Se você for mais sensível, eu te passo dicas simples de preparo (alimentação, hidratação e descanso) que ajudam bastante.\n\n" +
    "Se quiser, me diz a região que você pretende fazer que eu te falo como costuma ser nela."
  );
}

// ✅ NOVO modelo (tempo) — sem perguntar “tamanho” quando for fechamento
function msgTempoResposta(message) {
  const isBig = detectLargeProject(message || "");
  if (isBig) {
    return (
      "O tempo de execução varia bastante, mas em *fechamento* (braço/costas) a gente sempre organiza por etapas.\n\n" +
      "Normalmente dividimos em algumas sessões com intervalo pra cicatrização, porque isso garante um resultado perfeito e menos estresse pra você.\n" +
      "Meu foco é sempre manter qualidade, conforto e uma cicatrização redonda.\n\n" +
      "Se for *braço fechado* ou *costas inteira*, me diz qual dos dois e se já tem referência que eu te passo uma noção bem realista de sessões."
    );
  }

  return (
    "O tempo de execução varia bastante, dependendo diretamente do tamanho e do detalhamento da sua tatuagem.\n\n" +
    "Projetos menores podem fechar em uma sessão; já peças com mais detalhes, sombreamento e transições podem pedir duas ou mais sessões.\n" +
    "Meu foco é sempre garantir qualidade e o seu conforto.\n\n" +
    "Me diz onde no corpo você quer fazer e, se souber, um tamanho aproximado — assim eu te dou uma estimativa mais precisa."
  );
}

function msgPrecoAntesDoValor(message) {
  const isBig = detectLargeProject(message || "");
  if (isBig) {
    return (
      "Consigo te passar um valor bem fiel assim que eu tiver:\n\n" +
      "• referência em imagem (se tiver)\n" +
      "• se é *braço fechado* ou *costas inteira*\n\n" +
      "Me manda isso que eu já te retorno bem certinho."
    );
  }

  return (
    "Consigo te passar um valor bem fiel assim que eu tiver:\n\n" +
    "• referência em imagem (se tiver)\n" +
    "• onde no corpo + tamanho aproximado\n\n" +
    "Me manda isso que eu já te retorno."
  );
}

function msgHesitacaoResposta() {
  return (
    "Tranquilo.\n\n" +
    "Pra eu te ajudar de verdade: o que tá pesando mais agora — *design*, *orçamento* ou *data*?\n" +
    "Se tiver uma preferência de data, me fala também que eu tento facilitar o melhor caminho."
  );
}

// -------------------- Regras de preço --------------------
function calcPriceFromHours(hours) {
  const h = Math.max(1, Math.round(Number(hours) || 1));
  return 150 + Math.max(0, h - 1) * 120;
}

function sessionsFromHours(hours) {
  const h = Math.max(1, Number(hours) || 1);
  return Math.ceil(h / 7);
}

// -------------------- OpenAI prompts --------------------
const BASE_SYSTEM = (ENV.SYSTEM_PROMPT || `
Você é o DW Tattooer, tatuador profissional atendendo no WhatsApp (tom humano, direto e profissional).
Regras:
- Nunca diga que é IA.
- Não assine mensagem.
- Não use termos estranhos tipo "acabamento bem limpo". Fale como tatuador de verdade.
- Não fale de horas nem preço/hora pro cliente (isso é interno).
- Antes de falar preço: explique o valor do trabalho de forma simples (complexidade, sombras, transições, encaixe, cicatrização).
- Você trabalha com realismo em preto e cinza + whip shading.
- Você não faz sessões acima de 7 horas; se passar disso, divide em 2+ sessões (sem falar horas).
- Pagamento: Pix, débito, crédito até 12x.
- Inclui 1 retoque se necessário em 40–50 dias.
- Parcelamento mensal existe: se o cliente não conseguir pagar de uma vez, pode dividir em sessões mensais.
- Cobertura: peça foto da tattoo atual, e diga que vai analisar antes de confirmar.
- Criação: você faz criações exclusivas baseadas na referência e adapta ao corpo do cliente.
- Depois de fechar (depósito e agenda), continue respondendo dúvidas básicas do procedimento (dor, cuidados, tempo, local, preparo), sem tomar decisões de agenda.
- Se a pergunta for fora do procedimento (agenda complexa, assuntos pessoais, mudanças grandes de projeto/valor), responda que vai analisar e retornar em breve.
`).trim();

async function describeImageForClient(imageDataUrl) {
  const resp = await openai.chat.completions.create({
    model: "gpt-4o",
    temperature: 0.35,
    messages: [
      { role: "system", content: BASE_SYSTEM },
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              "Analise a referência e gere uma explicação curta, direta e profissional do que o projeto exige (sombras, transições, volume, contraste, encaixe). NÃO fale de preço, NÃO fale de horas. 5 a 8 linhas no máximo.",
          },
          { type: "image_url", image_url: { url: imageDataUrl } },
        ],
      },
    ],
  });

  return resp.choices?.[0]?.message?.content?.trim() || "";
}

async function buildWorkDescription(imageDataUrl, bodyRegion, sizeLocation) {
  try {
    const resp = await openai.chat.completions.create({
      model: "gpt-4o",
      temperature: 0.35,
      messages: [
        { role: "system", content: BASE_SYSTEM },
        {
          role: "user",
          content: [
            {
              type: "text",
              text:
                "Crie uma descrição objetiva do projeto de tatuagem com base na referência. " +
                "Inclua região do corpo e tamanho informado, em tom profissional e direto. " +
                "Não fale de preço nem horas. 4 a 6 linhas no máximo.",
            },
            {
              type: "text",
              text: `Região: ${bodyRegion || "não informado"} | Tamanho: ${sizeLocation || "não informado"}`,
            },
            { type: "image_url", image_url: { url: imageDataUrl } },
          ],
        },
      ],
    });

    const content = resp.choices?.[0]?.message?.content?.trim();
    if (content) return content;
    return [
      "Descrição do projeto:",
      bodyRegion ? `• Região: ${bodyRegion}` : null,
      sizeLocation ? `• Tamanho: ${sizeLocation}` : null,
      "• Estilo: realismo black & grey, com sombras e transições suaves.",
    ]
      .filter(Boolean)
      .join("\n");
  } catch (e) {
    console.error("[DESC BUILD ERROR]", e?.message || e);
    return [
      "Descrição do projeto:",
      bodyRegion ? `• Região: ${bodyRegion}` : null,
      sizeLocation ? `• Tamanho: ${sizeLocation}` : null,
      "• Estilo: realismo black & grey, com sombras e transições suaves.",
    ]
      .filter(Boolean)
      .join("\n");
  }
}

async function estimateHoursInternal(imageDataUrl, sizeLocationOrRegion, isCoverup) {
  const resp = await openai.chat.completions.create({
    model: "gpt-4o",
    temperature: 0.15,
    messages: [
      {
        role: "system",
        content:
          "Você é um tatuador experiente. Estime SOMENTE um número de horas (inteiro) para execução, considerando complexidade e as informações (tamanho/local OU apenas região). Responda APENAS com um número. Sem texto.",
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `Info do cliente: ${sizeLocationOrRegion || "não informado"}.
Cobertura: ${isCoverup ? "sim" : "não"}.
Estime horas inteiras.`,
          },
          { type: "image_url", image_url: { url: imageDataUrl } },
        ],
      },
    ],
  });

  const raw = (resp.choices?.[0]?.message?.content || "").trim();
  const n = parseInt(raw.replace(/[^\d]/g, ""), 10);
  if (!Number.isFinite(n) || n <= 0) return 4;
  return Math.min(30, n);
}

// “máxima inteligência nas dúvidas”: responde a dúvida com GPT (curto e tatuador real) e volta pro fluxo
async function answerClientDoubtSmart(question, session) {
  const context = [
    session.bodyRegion ? `Região: ${session.bodyRegion}` : null,
    session.sizeLocation ? `Tamanho/descrição: ${session.sizeLocation}` : null,
    session.isCoverup ? "É cobertura: sim" : "É cobertura: não",
  ]
    .filter(Boolean)
    .join(" | ");

  const resp = await openai.chat.completions.create({
    model: "gpt-4o",
    temperature: 0.45,
    messages: [
      { role: "system", content: BASE_SYSTEM },
      {
        role: "user",
        content:
          `Cliente perguntou: "${String(question || "").slice(0, 700)}"\n` +
          `Contexto do atendimento: ${context || "não informado"}\n\n` +
          "Responda como o DW Tattooer, de forma humana, objetiva e profissional. " +
          "No máximo 6 linhas. Termine perguntando se ficou claro e se podemos seguir (ele responde OK).",
      },
    ],
  });

  return resp.choices?.[0]?.message?.content?.trim() || "";
}

// -------------------- Replies --------------------
function msgCriacao() {
  return (
    "Sim — eu faço *criações exclusivas*.\n" +
    "A referência serve como base, e eu adapto a composição pro teu corpo (encaixe, proporção e leitura), mantendo meu estilo."
  );
}

function msgCoberturaPedirFoto() {
  return (
    "Sobre *cobertura*: me manda uma foto bem nítida da tattoo atual (de perto e um pouco mais longe).\n\n" +
    "Aí eu analiso e te falo com sinceridade se dá pra fazer ou se vale outro caminho."
  );
}

function msgPedirLocalOuTamanhoMaisHumano(message) {
  const isBig = detectLargeProject(message || "");

  if (isBig) {
    return (
      "Fechado — agora vamos deixar isso bem redondo.\n\n" +
      "Me manda só mais duas coisas pra eu te passar um orçamento certinho:\n" +
      "• *a referência em imagem* (se tiver)\n" +
      "• se é *braço fechado* ou *costas inteira*\n\n" +
      "Se tiver alguma alteração além da referência, pode falar também."
    );
  }

  return (
    "Fechado — agora vamos deixar isso bem redondo.\n\n" +
    "Me manda só mais duas coisas pra eu te passar um orçamento certinho:\n" +
    "• *onde no corpo* você quer fazer\n" +
    "• *tamanho aproximado* (se não souber em cm, descreve na mão mesmo)\n\n" +
    "Se tiver alguma alteração além da referência, pode falar também."
  );
}

function msgSoBlackGrey() {
  return (
    "Só pra alinhar rapidinho:\n\n" +
    "• Eu trabalho com *black & grey* (preto e cinza).\n" +
    "• Não faço tatuagem totalmente colorida.\n\n" +
    "Se você curtir em preto e cinza, eu sigo e deixo bem forte."
  );
}

function msgFinalizaPorNaoAceitarBW() {
  return (
    "Entendi.\n\n" +
    "Como eu trabalho exclusivamente com *black & grey*, não vou conseguir te atender no colorido do jeito que você quer.\n\n" +
    "Obrigado por me chamar — se decidir fazer em preto e cinza no futuro, só me chamar."
  );
}

function msgEndereco() {
  return (
    "Claro.\n\n" +
    "• Endereço: *Av. Mauá, 1308* — próximo à rodoviária."
  );
}

function depositDeadlineLine() {
  return (
    "• Depois do agendamento, você tem até *4 horas* pra enviar a foto do comprovante.\n" +
    "Se não enviar nesse prazo, o agendamento é *cancelado* e o horário volta pra agenda."
  );
}

function msgFicoNoAguardoComprovante() {
  return (
    "Fechado.\n\n" +
    "• Fico no aguardo da *foto do comprovante* aqui no Whats.\n" +
    "• Qualquer dúvida, é só me chamar."
  );
}

function msgAguardandoComprovante() {
  const pixLine = ENV.PIX_KEY ? `• Chave Pix: ${ENV.PIX_KEY}\n` : "";
  return (
    "Certo.\n\n" +
    "• Pra eu confirmar a reserva do horário, eu preciso da *foto do comprovante* aqui no Whats.\n" +
    pixLine +
    "Assim que chegar, fica tudo confirmado."
  );
}

function msgPixDireto() {
  const pixLine = ENV.PIX_KEY ? ENV.PIX_KEY : "SEU_PIX_AQUI";
  return (
    "Perfeito! Para garantir o seu horário, o sinal é:\n" +
    "R$ 50,00\n\n" +
    "Chave Pix:\n" +
    `${pixLine}\n\n` +
    "A partir dessa mensagem, você tem 4 horas para realizar o pagamento e enviar o comprovante.\n" +
    "Caso o pagamento não seja enviado dentro desse período, o horário não será reservado."
  );
}

function msgPerguntaAgenda() {
  return (
    "Comprovante recebido.\n\n" +
    "Pra eu agendar do melhor jeito:\n" +
    "• você prefere horário comercial ou pós-comercial?\n" +
    "• tem alguma data específica livre?"
  );
}

function msgOpcoesAgendamentoComDatasDW(suggestions) {
  const lines = [];
  lines.push("Fechado ✅ Vamos pro *agendamento*.");
  lines.push("Escolhe uma opção (responde 1, 2, 3 ou 4):");
  lines.push("");
  (suggestions || []).slice(0, 4).forEach((s, idx) => {
    lines.push(`${idx + 1}) *${s.dateBR}* — ${s.label}`);
  });
  lines.push("");
  lines.push("Se você tiver *dia e horário específico*, pode mandar também (ex: 29/01 às 16:00).");
  return lines.join("\n");
}

function msgAgendamentoConfirmado(resumo) {
  return (
    "Agendamento confirmado ✅\n\n" +
    "Resumo:\n" +
    `${resumo}\n\n` +
    "Se precisar ajustar algo, me chama."
  );
}

function msgPedirSinalPixDepoisAgendar() {
  const pixLine = ENV.PIX_KEY ? ENV.PIX_KEY : "SEU_PIX_AQUI";
  return (
    "Perfeito! Para garantir o seu horário, o sinal é:\n" +
    "R$ 50,00\n\n" +
    "Chave Pix:\n" +
    `${pixLine}\n\n` +
    "A partir dessa mensagem, você tem 4 horas para realizar o pagamento e enviar o comprovante.\n" +
    "Caso o pagamento não seja enviado dentro desse período, o horário não será reservado."
  );
}

function msgVouVerificarAgendaSemData() {
  return (
    "Fechado.\n\n" +
    "Vou conferir minha agenda e já te retorno com as próximas opções."
  );
}

function msgVouVerificarAgendaComData() {
  return (
    "Perfeito.\n\n" +
    "Vou verificar na agenda e já te retorno confirmando opções de data e horário."
  );
}

function msgCuidadosPreSessao() {
  return (
    "Antes da sessão:\n\n" +
    "• Beba bastante água.\n" +
    "• Evite álcool no dia anterior.\n" +
    "• Se alimente bem antes de vir.\n" +
    "• Se puder, usar *creme hidratante* na região nos dias anteriores ajuda bastante a pele (pigmento e durabilidade agradecem)."
  );
}

function msgChecagemDuvidas() {
  return (
    "Antes de eu te passar o investimento:\n\n" +
    "Ficou alguma dúvida sobre o atendimento?\n" +
    "Se estiver tudo certo, me responde *OK* que eu já te mando o valor e as formas de pagamento."
  );
}

function msgOrcamentoCompleto(valor, sessoes) {
  return (
    `Pelo tamanho e complexidade do que você me enviou, o investimento fica em *R$ ${valor}*.\n\n` +
    `• Eu organizo em *${sessoes} sessão(ões)* pra ficar bem executado e cicatrizar redondo.\n\n` +
    "Se o investimento estiver dentro do que você esperava, tenho horários disponíveis para essa semana.\n" +
    "Aqui estão algumas opções:\n" +
    "• Pela manhã: 09h — Terça ou Quinta\n" +
    "• À tarde: 14h — Terça, Quinta ou Sexta\n" +
    "• À noite: 19h — Terça ou Sexta\n" +
    "Se algum desses horários ficar bom para você, me avisa.\n" +
    "Caso prefira um dia ou horário específico, me diz que analiso minha agenda e vejo como encaixar você."
  );
}

async function sendQuoteFlow(phone, session, message) {
  if (!session.imageDataUrl || (!session.sizeLocation && !session.bodyRegion)) {
    const reply = msgPedirLocalOuTamanhoMaisHumano(message);
    if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
    session.stage = "aguardando_info";
    return false;
  }

  try {
    const info = session.sizeLocation || session.bodyRegion || "não informado";
    const hours = await estimateHoursInternal(session.imageDataUrl, info, session.isCoverup);

    const valor = calcPriceFromHours(hours);
    const sessoes = sessionsFromHours(hours);

    const quote = msgOrcamentoCompleto(valor, sessoes);
    if (!antiRepeat(session, quote)) await zapiSendText(phone, quote);

    session.sentQuote = true;
    session.stage = "pos_orcamento";
    session.waitingReceipt = false;

    // follow-up 30min pós-orçamento (se sumir)
    scheduleFollowup30min(phone, session, "pós orçamento");
    return true;
  } catch (e) {
    console.error("[QUOTE ERROR]", e?.message || e);

    // se der erro na estimativa, manda handoff manual (sem travar)
    await handoffToManual(phone, session, "erro ao estimar orçamento", message);
    return false;
  }
}

// -------------------- HANDOFF manual --------------------
async function handoffToManual(phone, session, motivo, mensagemCliente) {
  const now = Date.now();
  if (!session.lastOwnerNotifyAt) session.lastOwnerNotifyAt = 0;

  if (now - session.lastOwnerNotifyAt > 30_000) {
    session.lastOwnerNotifyAt = now;
    await notifyOwner(
      [
        "🧠 HANDOFF MANUAL (bot)",
        `• Motivo: ${motivo}`,
        `• Cliente: ${String(phone).replace(/\D/g, "")}`,
        `• Etapa: ${session.stage || "?"}`,
        `• Mensagem: ${(mensagemCliente || "").slice(0, 400)}`,
      ].join("\n")
    );
  }

  session.manualHandoff = true;
  session.stage = "manual_pendente";

  const reply =
    "Entendi.\n\n" +
    "• Vou analisar direitinho e já te retorno.";
  if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
}

// -------------------- Buffer / Merge inbound --------------------
function enqueueInbound(session, inbound) {
  const p = session.pending;
  if (inbound.contactName) p.lastContactName = inbound.contactName;

  // guarda partes de texto
  const msg = String(inbound.message || "").trim();
  if (msg) p.textParts.push(msg);

  // guarda imagem (se veio)
  if (inbound.imageUrl) {
    p.imageUrl = inbound.imageUrl;
    p.imageMime = inbound.imageMime || "image/jpeg";
  }

  p.messageType = inbound.messageType || p.messageType || "";

  // reseta timer e agenda processamento com delay inteligente
  if (p.timer) clearTimeout(p.timer);

  const mergedTextPreview = p.textParts.join(" \n");
  const delay = computeDelayMs(session, mergedTextPreview, Boolean(p.imageUrl));

  p.timer = setTimeout(() => {
    p.timer = null;
    const mergedText = p.textParts.join("\n").trim();
    const merged = {
      phone: inbound.phone,
      message: mergedText,
      imageUrl: p.imageUrl,
      imageMime: p.imageMime,
      contactName: p.lastContactName,
      messageType: p.messageType,
    };

    // limpa buffer antes de processar (pra não duplicar)
    p.textParts = [];
    p.imageUrl = null;
    p.imageMime = "image/jpeg";
    p.messageType = "";

    // processa (async)
    processMergedInbound(merged.phone, merged).catch((e) => {
      console.error("[PROCESS MERGED ERROR]", e?.message || e);
    });
  }, delay);
}

// -------------------- Core processor --------------------
async function processMergedInbound(phone, merged) {
  const session = getSession(phone);

  const message = String(merged.message || "").trim();
  const lower = message.toLowerCase();
  const imageUrl = merged.imageUrl || null;
  const imageMime = merged.imageMime || "image/jpeg";
  const contactName = merged.contactName || null;

  // marca última msg do cliente
  session.lastClientMsgAt = Date.now();

  console.log("[MERGED IN]", {
    phone,
    stage: session.stage,
    hasImageUrl: !!imageUrl,
    messagePreview: (message || "").slice(0, 160),
  });

  // ✅ se já entrou em handoff manual
  if (session.manualHandoff) {
    // se cliente confirmar, manda cuidados + fechamento (sem duplicar)
    if ((session.stage === "pos_agenda_manual" || session.stage === "manual_pendente") && detectAppointmentConfirm(message)) {
      if (!session.sentAfterConfirmReminder) {
        const reply = [msgCuidadosPreSessao(), "", "Qualquer dúvida até o dia, é só me chamar."].join("\n\n");
        if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
        session.sentAfterConfirmReminder = true;
        return;
      }
    }

    if ((session.stage === "pos_agenda_manual" || session.stage === "manual_pendente") && detectThanks(message)) {
      const reply = chooseClosingOnce(session);
      if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
      session.finished = true;
      session.stage = "finalizado";
    }
    return;
  }

  // ✅ comando reset
  if (/^reset$|^reiniciar$|^reinicia$|^começar\s*novamente$|^comecar\s*novamente$/i.test(lower)) {
    resetSession(phone);
    const s2 = getSession(phone);
    const reply =
      "Atendimento reiniciado.\n\n" +
      "Me manda a referência em imagem e me diz onde no corpo + tamanho aproximado.";
    if (!antiRepeat(s2, reply)) await zapiSendText(phone, reply);
    return;
  }

  // ✅ endereço
  if (askedAddress(message)) {
    const reply = msgEndereco();
    if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
    return;
  }

  // ✅ pix
  if (askedPix(message)) {
    if (session.scheduleConfirmed) {
      const reply = msgPixDireto();
      if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
      return;
    }

    const reply =
      "Pra liberar a chave Pix eu preciso confirmar o horário primeiro.\n\n" +
      "Se quiser, já te mando opções de datas disponíveis agora.";
    if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
    return;
  }

  // intents (dor/tempo/preço/hesitação)
  const pain = askedPain(message);
  const timeAsk = askedTime(message);
  const priceAsk = askedPrice(message);
  const hes = askedHesitation(message);

  if (pain && !session.finished) {
    const reply = msgDorResposta();
    if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
    return;
  }

  if (timeAsk && !session.finished) {
    const reply = msgTempoResposta(message);
    if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
    return;
  }

  if (hes && !session.finished) {
    const reply = msgHesitacaoResposta();
    if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);

    // agenda follow-up 30min em hesitação
    scheduleFollowup30min(phone, session, "hesitação");
    return;
  }

  if (priceAsk && !session.finished) {
    if (!session.imageDataUrl || (!session.bodyRegion && !session.sizeLocation)) {
      const reply = msgPrecoAntesDoValor(message);
      if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);

      // agenda follow-up 30min se ficou travado pedindo info
      scheduleFollowup30min(phone, session, "pediu preço sem info");
      return;
    }
  }

  // intents gerais
  if (detectCoverup(message)) session.isCoverup = true;
  const askedCreation = /cria|criação|desenho|autor|exclusiv/i.test(lower);

  const maybeRegion = extractBodyRegion(message);
  if (!session.bodyRegion && maybeRegion) session.bodyRegion = maybeRegion;

  const maybeSizeLoc = extractSizeLocation(message);
  if (!session.sizeLocation && maybeSizeLoc) session.sizeLocation = maybeSizeLoc;

  // se recebeu info nova, limpa follow-up (não precisa mais)
  if (maybeRegion || maybeSizeLoc || imageUrl) {
    clearFollowup(session);
    session.followupSent = false;
  }

  if (!session.finished && detectColorIntentByText(message)) {
    session.awaitingBWAnswer = true;
    const reply = msgSoBlackGrey();
    if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
    return;
  }

  if (askedCreation) {
    const reply = msgCriacao();
    if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
    // não returna, deixa seguir fluxo
  }

  // ✅ aceitar/recusar preto e cinza
  if (session.awaitingBWAnswer) {
    const bw = detectBWAccept(message);
    if (bw === "no") {
      session.finished = true;
      session.stage = "finalizado";
      const reply = msgFinalizaPorNaoAceitarBW();
      if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
      return;
    }
    if (bw === "yes") session.awaitingBWAnswer = false;
  }

  // -------------------- PRAZO 12H (cancelamento) --------------------
  if (session.depositDeadlineAt && !session.depositConfirmed) {
    const now = Date.now();
    if (now > session.depositDeadlineAt) {
      const reply =
        "Certo.\n\n" +
        "Como o comprovante não chegou dentro do prazo, eu cancelei a reserva e o horário voltou pra agenda.\n" +
        "Se você ainda quiser fazer, me chama aqui que a gente retoma e vê novos horários.";
      if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);

      await notifyOwner(
        [
          "⏰ PRAZO EXPIRADO (bot)",
          `• Cliente: ${String(phone).replace(/\D/g, "")}`,
          "• Ação: reserva cancelada (12h sem comprovante)",
        ].join("\n")
      );

      resetSession(phone);
      return;
    }
  }

  // -------------------- FLUXO (gate primeiro contato) --------------------
  if (session.stage === "inicio") {
    const reply = chooseGreetingOnce(session, contactName);
    if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);

    session.greeted = true;
    session.askedFirstContact = true;
    session.stage = "aguardando_primeiro_contato";
    return;
  }

  if (session.stage === "aguardando_primeiro_contato") {
    const ans = detectFirstContactAnswer(message);

    // já tem orçamento em andamento -> avisa dono e para
    if (ans === "ongoing") {
      await notifyOwner(
        [
          "⚠️ CLIENTE DISSE QUE JÁ TEM ORÇAMENTO EM ANDAMENTO (quer continuar)",
          `• Cliente: ${String(phone).replace(/\D/g, "")}`,
          `• Mensagem: ${(message || "").slice(0, 400)}`,
          "• Ação: você assume a conversa (bot parou).",
        ].join("\n")
      );

      session.manualHandoff = true;
      session.stage = "manual_pendente";
      return; // não responde mais nada
    }

    // orçamento novo -> segue
    if (ans === "first") {
      session.firstContactResolved = true;
      session.stage = "aguardando_referencia";

      const reply =
        "Show! Então vamos montar um orçamento novo bem certinho.\n\n" +
        "Pra eu te passar um valor bem fiel, me manda:\n" +
        "• *a referência em imagem* (se tiver)\n" +
        "• *onde no corpo* você quer fazer + *tamanho aproximado*\n\n" +
        "Se você tiver alguma ideia de ajuste além da referência, pode falar também.";
      if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);

      // follow-up se sumir
      scheduleFollowup30min(phone, session, "gate resolvido, aguardando referência");
      return;
    }

    const retry =
      "Só pra eu te direcionar certinho:\n" +
      "Você quer *continuar um orçamento em andamento* comigo, ou quer *começar um orçamento novo do zero*?";
    if (!antiRepeat(session, retry)) await zapiSendText(phone, retry);
    return;
  }

  // ✅ coverup sem imagem
  if (session.isCoverup && !session.imageDataUrl && !imageUrl) {
    const reply = msgCoberturaPedirFoto();
    if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
    session.stage = "aguardando_referencia";

    scheduleFollowup30min(phone, session, "coverup pediu foto");
    return;
  }

  // ✅ aguardando referência e não tem imagem
  if (session.stage === "aguardando_referencia" && !session.imageDataUrl && !imageUrl) {
    const reply =
      "Perfeito.\n\n" +
      "Quando puder, me manda:\n" +
      "• *referência em imagem* (print/foto)\n" +
      "• *onde no corpo* + *tamanho aproximado*";
    if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);

    scheduleFollowup30min(phone, session, "aguardando referência sem imagem");
    return;
  }

  // ✅ comprovante por texto sem foto (depois do orçamento)
  const depositTextOnly = detectDepositTextOnly(message);
  const isAfterSchedule = session.scheduleConfirmed || session.stage === "aguardando_comprovante";

  if (!session.depositConfirmed && depositTextOnly && !imageUrl && isAfterSchedule) {
    // “já já mando”
    if (detectWillSendReceipt(message)) {
      session.waitingReceipt = true;
      const reply = msgFicoNoAguardoComprovante();
      if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
      return;
    }

    const reply = msgAguardandoComprovante();
    if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
    return;
  }

  // ✅ FOTO do comprovante
  const isReceiptImage = Boolean(imageUrl) && detectReceiptContext(session, message);
  if (!session.depositConfirmed && isReceiptImage && isAfterSchedule) {
    session.depositConfirmed = true;
    session.stage = "agendamento_confirmado";

    await notifyOwner(
      [
        "💸 COMPROVANTE RECEBIDO (bot)",
        `• Cliente: ${String(phone).replace(/\D/g, "")}`,
        "• Agendamento já confirmado no calendário",
      ].join("\n")
    );

    const reply = "Comprovante recebido ✅ Qualquer dúvida até o dia, é só me chamar.";
    if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
    return;
  }

  // ✅ imagem referência chegou -> salva + analisa
  if (imageUrl && !isReceiptImage) {
    try {
      const dataUrl = await fetchImageAsDataUrl(imageUrl, imageMime);
      session.imageDataUrl = dataUrl;
      session.descriptionText = null;
      session.descriptionConfirmed = false;
      session.pendingDescChanges = "";

      session.imageSummary = await describeImageForClient(dataUrl);

      if (detectColorIntentBySummary(session.imageSummary)) {
        session.awaitingBWAnswer = true;
        const reply = msgSoBlackGrey();
        if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
        return;
      }

      // reset flags
      session.sentSummary = false;
      session.askedDoubts = false;
      session.doubtsResolved = false;
      session.sentQuote = false;

      if (session.stage === "aguardando_confirmacao_descricao" || session.stage === "aguardando_ajustes_descricao") {
        session.stage = "aguardando_ajustes_descricao";
        await zapiSendText(
          phone,
          "Recebi mais uma referência. Deseja ajustar algo com base nela ou posso seguir para o orçamento?"
        );
        return;
      }

      session.stage = "aguardando_info";

      if (!session.bodyRegion && !session.sizeLocation) {
        const reply = msgPedirLocalOuTamanhoMaisHumano(message);
        if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);

        scheduleFollowup30min(phone, session, "recebeu ref, pedindo info");
        return;
      }
    } catch (e) {
      console.error("[IMG] failed:", e?.message || e);
      session.stage = "aguardando_info";
      if (!session.bodyRegion && !session.sizeLocation) {
        const reply = msgPedirLocalOuTamanhoMaisHumano(message);
        if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);

        scheduleFollowup30min(phone, session, "falhou download ref, pedindo info");
        return;
      }
    }
  }

  // ✅ se tem imagem e está aguardando info -> manda resumo / dúvidas
  if (session.imageDataUrl && session.stage === "aguardando_info") {
    if (!session.bodyRegion && !session.sizeLocation) {
      const reply = msgPedirLocalOuTamanhoMaisHumano(message);
      if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);

      scheduleFollowup30min(phone, session, "aguardando info (sem região/tamanho)");
      return;
    }

    if (session.bodyRegion && session.sizeLocation) {
      const desc = await buildWorkDescription(session.imageDataUrl, session.bodyRegion, session.sizeLocation);
      session.descriptionText = desc;
      session.descriptionConfirmed = false;
      session.pendingDescChanges = "";
      session.stage = "aguardando_confirmacao_descricao";

      await zapiSendText(
        phone,
        desc +
          "\n\nAntes de eu te passar valores, confirma pra mim: está exatamente como você imaginou?\n" +
          "Se quiser adicionar/remover algo, ou mandar outra referência, pode falar.\n" +
          "Se estiver tudo certo, responda 'tá certo' e eu sigo para o orçamento."
      );

      return;
    }

    if (!session.sentSummary) {
      if (!session.imageSummary) {
        const reply =
          "Recebi a referência.\n\n" +
          "Só me confirma:\n" +
          "• onde no corpo\n" +
          "• tamanho aproximado\n" +
          "e se é igual à referência ou quer alguma alteração.";
        if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
        session.sentSummary = true;
      } else {
        const intro =
          "Recebi a referência.\n\n" +
          "Pra esse projeto ficar bem executado, ele exige:\n\n" +
          session.imageSummary;
        if (!antiRepeat(session, intro)) await zapiSendText(phone, intro);
        session.sentSummary = true;
      }
    }

    // ✅ após enviar o resumo, faz a checagem de dúvidas (1x) e muda de etapa
    if (!session.askedDoubts) {
      const reply = msgChecagemDuvidas();
      if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
      session.askedDoubts = true;
      session.stage = "aguardando_duvidas";

      // se sumir nessa etapa, follow-up 30min
      scheduleFollowup30min(phone, session, "checagem de dúvidas");
      return;
    }
  }

  if (session.stage === "aguardando_confirmacao_descricao") {
    const lowerMsg = message.toLowerCase();
    const confirms = [
      "sim",
      "certo",
      "certinho",
      "tá certo",
      "ta certo",
      "tudo certo",
      "ok",
      "pode ser",
      "isso",
      "perfeito",
      "beleza",
      "tranquilo",
      "fechado",
      "isso mesmo",
      "tá tranquilo",
      "ta tranquilo",
    ];
    const wantsChange = ["nao", "não", "mudar", "alterar", "trocar", "adicionar", "remover", "ajustar"];

    if (confirms.some((w) => lowerMsg.includes(w))) {
      session.descriptionConfirmed = true;
      session.stage = "aguardando_resposta_orcamento";
      await zapiSendText(phone, "Perfeito! Vou calcular o investimento para você.");
      await sendQuoteFlow(phone, session, message);
      return;
    }

    if (wantsChange.some((w) => lowerMsg.includes(w))) {
      session.stage = "aguardando_ajustes_descricao";
      await zapiSendText(
        phone,
        "Perfeito. Me diga o que deseja adicionar/remover. Se quiser mandar outra referência também posso integrar."
      );
      return;
    }

    await zapiSendText(phone, "Show! Está tudo certo com a descrição ou deseja ajustar algo?");
    return;
  }

  if (session.stage === "aguardando_ajustes_descricao") {
    const lowerMsg = message.toLowerCase();
    const finish = [
      "sim",
      "certo",
      "certinho",
      "tá certo",
      "ta certo",
      "tudo certo",
      "ok",
      "pode ser",
      "isso",
      "perfeito",
      "beleza",
      "tranquilo",
      "fechado",
      "isso mesmo",
      "tá tranquilo",
      "ta tranquilo",
      "pode seguir",
      "segue",
    ];

    if (finish.some((w) => lowerMsg.includes(w))) {
      if (session.pendingDescChanges.trim()) {
        session.descriptionText = [
          session.descriptionText,
          "",
          "Ajustes solicitados:",
          session.pendingDescChanges.trim(),
        ]
          .filter(Boolean)
          .join("\n");
        session.pendingDescChanges = "";
      }
      session.stage = "aguardando_confirmacao_descricao";
      await zapiSendText(phone, `${session.descriptionText}\n\nConfirma que é isso mesmo?`);
      return;
    }

    session.pendingDescChanges += `\n${message}`;
    await zapiSendText(phone, "Fechado, já anotei. Quer ajustar mais algo ou posso seguir para o orçamento?");
    return;
  }

  // -------------------- ETAPA: DÚVIDAS --------------------
  if (session.stage === "aguardando_duvidas") {
    // se o cliente disse que não tem dúvidas / OK -> gera orçamento
    if (!session.descriptionConfirmed) {
      const prematurely = ["ok", "aceito", "fechado", "bora", "quero"];
      if (prematurely.some((w) => lower.includes(w))) {
        if (!session.descriptionText && session.imageDataUrl && session.bodyRegion && session.sizeLocation) {
          const desc = await buildWorkDescription(session.imageDataUrl, session.bodyRegion, session.sizeLocation);
          session.descriptionText = desc;
        }

        if (session.descriptionText) {
          session.stage = "aguardando_confirmacao_descricao";
          await zapiSendText(
            phone,
            session.descriptionText +
              "\n\nAntes de eu te passar valores, confirma pra mim: está exatamente como você imaginou?"
          );
          return;
        }

        await zapiSendText(phone, "Antes de prosseguir, preciso que você confirme a descrição do projeto.");
        return;
      }
    }

    if (answeredNoDoubts(message) || /^ok$/i.test(lower)) {
      session.doubtsResolved = true;

      await sendQuoteFlow(phone, session, message);
      return;
    }

    // se ele mandou uma dúvida de verdade, responde com GPT e mantém na etapa
    const reply = await answerClientDoubtSmart(message, session);
    if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
    return;
  }

  // -------------------- ETAPA: PÓS-ORÇAMENTO --------------------
  if (session.stage === "pos_orcamento") {
    // pedido de desconto -> resposta padrão (sem negociar valor diretamente)
    if (detectDiscountAsk(message)) {
      const reply =
        "Entendo.\n\n" +
        "O valor é baseado na complexidade e no tempo de execução pra eu te entregar um resultado perfeito e uma cicatrização redonda.\n\n" +
        "O que eu consigo fazer pra facilitar é:\n" +
        "• parcelar no cartão em até 12x\n" +
        "• ou dividir em *sessões mensais* (você vai pagando por etapa)\n\n" +
        "Se você me disser qual dessas formas te ajuda mais, eu te guio no melhor caminho.";
      if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);

      // follow-up 30min se sumir
      scheduleFollowup30min(phone, session, "pedido de desconto");
      return;
    }

    /* STAGE: CONVIDAR_AGENDAMENTO_START */
    if (detectHasSpecificDate(message) || detectNoSpecificDate(message) || /marcar|agenda|hor[aá]rio|data/i.test(lower)) {
      const durationMin = session.durationMin || 180;
      const suggestions = await buildNextAvailableSuggestionsDW({ durationMin });

      if (!suggestions.length) {
        const reply = msgVouVerificarAgendaSemData();
        if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
        await notifyOwner(
          [
            "📅 SEM OPÇÕES DISPONÍVEIS (bot)",
            `• Cliente: ${String(phone).replace(/\D/g, "")}`,
            "• Ação: verificar agenda manualmente",
          ].join("\n")
        );
        session.manualHandoff = true;
        session.stage = "manual_pendente";
        return;
      }

      session.suggestedSlots = suggestions;
      session.waitingSchedule = true;
      session.stage = "aguardando_escolha_agendamento";

      const reply = msgOpcoesAgendamentoComDatasDW(suggestions);
      if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
      return;
    }
    /* STAGE: CONVIDAR_AGENDAMENTO_END */

    // se cliente agradecer depois do orçamento, responde curto (não finaliza)
    if (detectThanks(message)) {
      const reply =
        "Tamo junto.\n\n" +
        "Se quiser seguir, me fala que eu já te mando opções de datas e horários. Qualquer dúvida, me chama.";
      if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
      return;
    }
  }

  /* STAGE: AGUARDANDO_ESCOLHA_AGENDAMENTO_START */
  if (session.stage === "aguardando_escolha_agendamento") {
    const txt = (message?.text || message?.body || message || "").trim();

    // 3.1) Se cliente mandou dia/horário específico, mantém fluxo existente se existir
    if (typeof isSpecificDayTime === "function" && isSpecificDayTime(txt)) {
      session.stage = "validar_agendamento_especifico";
      session.pendingScheduleText = txt;
      const reply = "Entendi ✅ Vou conferir na agenda e já te confirmo esse dia e horário.";
      if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
      if (typeof handleSpecificScheduleRequest === "function") {
        await handleSpecificScheduleRequest({ session, phone, text: txt });
      }
      return;
    }

    // 3.2) Escolha 1-4
    const choice = parseChoice1to4(txt);
    if (!choice || !session.suggestedSlots || !session.suggestedSlots[choice - 1]) {
      const retry = "Me diz só *1, 2, 3 ou 4* ✅ (ou manda um dia/horário específico).";
      if (!antiRepeat(session, retry)) await zapiSendText(phone, retry);
      return;
    }

    const slot = session.suggestedSlots[choice - 1];
    const durationMin = session.durationMin || 180;

    const calRes = await upsertCalendarHoldOrEvent({
      session,
      phone,
      dateISO: slot.dateISO,
      timeHM: slot.timeHM,
      durationMin,
      title: buildCalendarTitle(session, phone),
    });

    if (!calRes?.ok) {
      const suggestions = await buildNextAvailableSuggestionsDW({ durationMin });
      session.suggestedSlots = suggestions;
      const reply =
        "Esse horário acabou de ficar indisponível. Te mando outras opções livres ✅\n\n" +
        msgOpcoesAgendamentoComDatasDW(suggestions);
      if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
      return;
    }

    session.scheduleConfirmed = true;
    session.waitingSchedule = false;
    session.stage = "agendamento_confirmado";

    const resumo = `• ${slot.dateBR} às ${slot.timeHM}`;
    const msgOk = msgAgendamentoConfirmado(resumo);
    if (!antiRepeat(session, msgOk)) await zapiSendText(phone, msgOk);

    const msgPix = msgPedirSinalPixDepoisAgendar();
    if (!antiRepeat(session, msgPix) && !session.sentDepositRequest) {
      await zapiSendText(phone, msgPix);
      session.sentDepositRequest = true;
    }

    session.depositDeadlineAt = Date.now() + 4 * 60 * 60 * 1000;
    session.sentDepositDeadlineInfo = true;
    session.waitingReceipt = true;
    session.stage = "aguardando_comprovante";
    return;
  }
  /* STAGE: AGUARDANDO_ESCOLHA_AGENDAMENTO_END */

  // -------------------- ETAPA: AGENDA (após comprovante) --------------------
  if (session.stage === "agenda") {
    // captura preferências simples e passa pro dono (manual)
    const pref = detectCommercialPref(message);
    const hasDate = detectHasSpecificDate(message);

    // se ele respondeu algo relacionado à agenda, repassa pro dono
    if (pref || hasDate || /manh[aã]|tarde|noite|pos|p[oó]s|comercial|segunda|ter[cç]a|quarta|quinta|sexta|s[aá]bado|domingo|\d{1,2}\/\d{1,2}/i.test(message)) {
      await notifyOwner(
        [
          "📅 PEDIDO DE AGENDA (bot)",
          `• Cliente: ${String(phone).replace(/\D/g, "")}`,
          `• Preferência: ${pref || "não informado"}`,
          `• Mensagem: ${(message || "").slice(0, 400)}`,
        ].join("\n")
      );

      session.manualHandoff = true;
      session.stage = "pos_agenda_manual";

      const reply =
        "Perfeito.\n\n" +
        "Vou confirmar na agenda e já te retorno com as opções certinhas de data e horário.";
      if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
      return;
    }

    // se não entendeu, pede de novo de forma simples
    const reply = msgPerguntaAgenda();
    if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
    return;
  }

  // -------------------- FALLBACK --------------------
  // se chegou aqui, tenta guiar conforme o que falta
  if (!session.imageDataUrl && session.stage !== "inicio" && session.stage !== "aguardando_primeiro_contato") {
    const reply =
      "Pra eu te atender certinho, me manda uma *referência em imagem* e me diz *onde no corpo + tamanho aproximado*.";
    if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);

    scheduleFollowup30min(phone, session, "fallback pedindo referência");
    return;
  }

  // fallback geral
  const reply =
    "Entendi.\n\n" +
    "Me manda só a referência em imagem (se ainda não mandou) + onde no corpo e tamanho aproximado, que eu já sigo daqui.";
  if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
}

// -------------------- Express routes --------------------
app.get("/", (req, res) => {
  res.status(200).send("OK");
});

app.get("/health", (req, res) => {
  const miss = missingEnvs();
  res.status(miss.length ? 500 : 200).json({
    ok: miss.length === 0,
    missing: miss,
    hasOwner: Boolean(ENV.OWNER_PHONE),
    hasPix: Boolean(ENV.PIX_KEY),
  });
});

// Webhook Z-API
app.post("/", async (req, res) => {
  try {
    const inbound = parseZapiInbound(req.body || {});

    // responde 200 rápido
    res.status(200).json({ ok: true });

    if (!inbound.phone) return;

    // ignora mensagens enviadas por você
    if (inbound.fromMe) return;

    const session = getSession(inbound.phone);

    // bufferiza para juntar (ex: imagem + texto + região)
    enqueueInbound(session, inbound);
  } catch (e) {
    console.error("[WEBHOOK ERROR]", e?.message || e);
    // sempre 200 para não gerar re-tentativas em loop
    try {
      res.status(200).json({ ok: true });
    } catch {}
  }
});

// -------------------- Start --------------------
app.listen(Number(ENV.PORT || 10000), () => {
  const miss = missingEnvs();
  console.log("🚀 Server on port", ENV.PORT);
  if (miss.length) console.log("⚠️ Missing ENV:", miss.join(", "));
}); 
