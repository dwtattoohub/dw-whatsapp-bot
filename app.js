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
 * - Nunca pedir Pix/sinal antes de: (a) orçamento entregue e (b) horário pré-reservado.
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
      firstContactReprompted: false,

      // referência / info
      imageDataUrl: null,
      descriptionText: null,
      descriptionConfirmed: false,
      pendingDescChanges: "",
      adjustNotes: "",
      imageSummary: null,
      refChangeReprompted: false,
      sizeLocation: null,
      sizeCm: null,
      bodyRegion: null,
      bodyPart: null,
      isCoverup: false,
      referenceImageUrl: null,
      hasReferenceImage: false,

      // ordem / flags
      greeted: false,
      greetVariant: null,
      closingVariant: null,

      sentSummary: false,
      askedDoubts: false,
      doubtsResolved: false,
      sentQuote: false,
      confirmationAskedOnce: false,

      // sinal / agenda
      depositConfirmed: false,
      askedSchedule: false,
      scheduleCaptured: false,
      scheduleConfirmed: false,
      suggestedSlots: null,
      pendingSlot: null,
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
      lastQuoteSizeCm: null,
      lastQuotePrice: null,

      // buffer p/ juntar mensagens (imagem + local, etc)
      pending: {
        timer: null,
        textParts: [],
        lastContactName: null,
        imageUrl: null,
        imageMime: "image/jpeg",
        messageType: "",
        payload: null,
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

function normalizeText(input) {
  return String(input || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function norm(s = "") {
  return String(s)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hasAny(t, arr) {
  return arr.some((k) => t.includes(k));
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const GREETING_PHRASES = [
  "oi",
  "ola",
  "olá",
  "oie",
  "oiee",
  "eai",
  "e aí",
  "iai",
  "iae",
  "salve",
  "opa",
  "opaa",
  "bom dia",
  "boa tarde",
  "boa noite",
  "tudo bem",
  "td bem",
  "tudo certo",
  "tudo bom",
  "beleza",
  "blz",
  "tranquilo",
  "tranq",
  "suave",
  "de boa",
  "deboas",
  "fala",
  "fala ai",
  "fala aí",
  "fala mano",
  "fala meu mano",
  "fala irmão",
  "fala irmao",
  "fala bro",
  "fala chefe",
  "bom",
  "boa",
  "noite",
  "dia",
  "tarde",
];

const BUDGET_INTENT_PHRASES = [
  "quero orcamento",
  "quero fazer um orcamento",
  "quero fazer orcamento",
  "quero um orcamento",
  "orcamento",
  "orçamento",
  "valor",
  "preco",
  "preço",
  "quanto fica",
  "quanto custa",
  "quanto sai",
  "qual valor",
  "qual o valor",
  "me passa o valor",
  "me passa o preco",
  "me passa o preço",
  "investimento",
];

const SCHEDULE_INTENT_PHRASES = [
  "agendar",
  "agendamento",
  "horario",
  "horário",
  "marcar",
  "marcacao",
  "marcação",
  "agenda",
  "data",
  "hora",
  "disponibilidade",
];

const CONFIRM_OK_PHRASES = [
  "sim",
  "s",
  "ss",
  "uhum",
  "aham",
  "ok",
  "okay",
  "okey",
  "certo",
  "certinho",
  "tudo certo",
  "tudo certinho",
  "ta certo",
  "tá certo",
  "ta certinho",
  "tá certinho",
  "ta ok",
  "tá ok",
  "ta bom",
  "tá bom",
  "tá ótimo",
  "ta otimo",
  "perfeito",
  "perfeita",
  "top",
  "show",
  "fechado",
  "fechou",
  "blz",
  "beleza",
  "tranquilo",
  "suave",
  "de boa",
  "deboas",
  "pode",
  "pode ser",
  "pode seguir",
  "pode continuar",
  "segue",
  "segue ai",
  "segue aí",
  "pode ir",
  "vai",
  "manda",
  "manda ver",
  "pode mandar",
  "segue o baile",
  "segue o jogo",
  "toca",
  "toca ficha",
  "bora",
  "bora seguir",
  "do jeito que ta",
  "do jeito que tá",
  "do jeito que esta",
  "do jeito que está",
  "assim mesmo",
  "desse jeito mesmo",
  "pode deixar assim",
  "deixa assim",
  "mantem assim",
  "mantém assim",
  "nao muda nada",
  "não muda nada",
  "nao quero mudar nada",
  "não quero mudar nada",
  "nao precisa mudar",
  "não precisa mudar",
  "sem alteracoes",
  "sem alterações",
  "sem mudancas",
  "sem mudanças",
  "sem ajuste",
  "sem ajustes",
  "nao quero adicionar nada",
  "não quero adicionar nada",
  "nao quero remover nada",
  "não quero remover nada",
  "ta perfeito",
  "tá perfeito",
  "ta perfeita",
  "tá perfeita",
  "ta lindo",
  "tá lindo",
  "ta linda",
  "tá linda",
  "pode seguir pro orcamento",
  "pode seguir pro orçamento",
  "pode seguir com o orcamento",
  "pode seguir com o orçamento",
  "pode seguir",
  "pode continuar",
  "pode dar sequência",
  "pode dar sequencia",
  "segue pro valor",
  "segue pro valor ai",
];

const WANTS_CHANGE_PHRASES = [
  "quero mudar",
  "quero alterar",
  "quero ajustar",
  "quero trocar",
  "quero adicionar",
  "quero colocar",
  "quero incluir",
  "quero remover",
  "quero tirar",
  "quero mudar um detalhe",
  "quero mudar alguns detalhes",
  "pode mudar",
  "pode alterar",
  "pode ajustar",
  "pode trocar",
  "pode tirar",
  "pode remover",
  "pode adicionar",
  "pode colocar",
  "vamos mudar",
  "vamos alterar",
  "vamos ajustar",
  "vamos trocar",
  "vamos adicionar",
  "vamos remover",
  "vamos tirar",
  "da pra mudar",
  "dá pra mudar",
  "da pra ajustar",
  "dá pra ajustar",
  "tem como mudar",
  "tem como ajustar",
  "nao ta certo",
  "não tá certo",
  "nao esta certo",
  "não está certo",
  "nao gostei",
  "não gostei",
  "ficou ruim",
  "quero diferente",
  "quero outro",
  "quero mais",
  "quero menos",
  "muda",
  "altera",
  "ajusta",
  "troca",
  "remove",
  "tira",
  "coloca",
  "inclui",
  "adiciona",
];

const GREETINGS = [
  "oi",
  "ola",
  "oie",
  "opa",
  "salve",
  "e ai",
  "eai",
  "bom dia",
  "boa tarde",
  "boa noite",
  "tudo bem",
  "td bem",
  "beleza",
  "blz",
  "tranquilo",
  "suave",
].map((value) => norm(value));

const NEW_BUDGET_INTENT = [
  "orcamento",
  "orçamento",
  "quero orcamento",
  "quero fazer um orcamento",
  "queria um orcamento",
  "preciso de um orcamento",
  "quanto fica",
  "quanto custa",
  "qual o valor",
  "valor",
  "preco",
  "preço",
  "investimento",
  "me passa o valor",
  "me passa valores",
  "me passa o preco",
  "me passa o preço",
  "quero tatuar",
  "quero fazer tattoo",
  "quero fazer uma tattoo",
  "quero fazer tatuagem",
  "tatuagem",
  "tattoo",
].map((value) => norm(value));

const CONTINUE_INTENT = [
  "orcamento em andamento",
  "orçamento em andamento",
  "ja tenho orcamento",
  "já tenho orçamento",
  "continuar",
  "dar continuidade",
  "retomar",
  "voltar",
  "onde paramos",
  "a gente ja conversou",
  "a gente já conversou",
  "sobre aquele orcamento",
  "sobre aquele orçamento",
  "da ultima vez",
  "da última vez",
].map((value) => norm(value));

function textHasAnyPhrase(text, phrases, options = {}) {
  const t = normalizeText(text);
  if (!t) return false;

  for (const rawPhrase of phrases) {
    const phrase = normalizeText(rawPhrase);
    if (!phrase) continue;

    if (options.exactOnly?.includes(phrase)) {
      if (t === phrase) return true;
      continue;
    }

    const escaped = escapeRegExp(phrase);
    const regex = new RegExp(`\\b${escaped}\\b`, "i");
    if (regex.test(t)) return true;
  }

  return false;
}

function hasGreeting(text) {
  return textHasAnyPhrase(text, GREETING_PHRASES);
}

function hasBudgetIntent(text) {
  return textHasAnyPhrase(text, BUDGET_INTENT_PHRASES);
}

function hasScheduleIntent(text) {
  return textHasAnyPhrase(text, SCHEDULE_INTENT_PHRASES);
}

function isConfirmOk(text) {
  return textHasAnyPhrase(text, CONFIRM_OK_PHRASES, { exactOnly: ["s", "ss"] });
}

function wantsChange(text) {
  return textHasAnyPhrase(text, WANTS_CHANGE_PHRASES);
}

function wantsNewBudget(rawText) {
  const t = norm(rawText);
  if (hasAny(t, CONTINUE_INTENT)) return false;
  return hasAny(t, NEW_BUDGET_INTENT);
}

function wantsContinueBudget(rawText) {
  const t = norm(rawText);
  return hasAny(t, CONTINUE_INTENT);
}

function isGenericGreeting(rawText) {
  const t = norm(rawText);
  const wordCount = t ? t.split(" ").length : 0;
  const hasGreet = hasAny(t, GREETINGS);
  return hasGreet && !wantsNewBudget(rawText) && !wantsContinueBudget(rawText) && wordCount <= 6;
}

function isNeutralOrQuestion(text) {
  return !isConfirmOk(text) && !wantsChange(text);
}

function getButtonReplyId(incomingPayload) {
  return (
    incomingPayload?.buttonId ||
    incomingPayload?.buttonReply?.id ||
    incomingPayload?.interactive?.button_reply?.id ||
    incomingPayload?.message?.buttonsResponseMessage?.selectedButtonId ||
    incomingPayload?.selectedId ||
    null
  );
}

function getIncomingText(incomingPayload) {
  return (
    incomingPayload?.text ||
    incomingPayload?.body ||
    incomingPayload?.message?.text ||
    incomingPayload?.message?.conversation ||
    null
  );
}

function detectRegionOrSizeHint(text) {
  const t = text || "";
  return Boolean(parseBodyPart(t) || parseSizeCm(t)) ||
    /(\d+\s*x\s*\d+)/i.test(t);
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

async function sendButtons(phone, text, buttons) {
  const url = `${zapiBaseUrl()}/send-button`;

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "client-token": ENV.ZAPI_CLIENT_TOKEN,
    },
    body: JSON.stringify({
      phone: String(phone).replace(/\D/g, ""),
      message: String(text || ""),
      buttonList: {
        buttons: (buttons || []).map((btn) => ({
          id: String(btn.id),
          label: String(btn.title),
        })),
      },
    }),
  });

  const body = await resp.text().catch(() => "");
  if (!resp.ok) throw new Error(`[ZAPI BUTTON FAILED] ${resp.status} ${body}`);
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
const GREETING_MESSAGES = [
  (name) =>
    `Olá${name ? `, ${name}` : ""}! Aqui é o DW Tattooer — especialista em realismo preto e cinza e whip shading.`,
  (name) =>
    `Olá${name ? `, ${name}` : ""}! Aqui é o DW Tattooer — especialista em realismo preto e cinza e whip shading. Como posso te ajudar?`,
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
  if (!session.greetVariant) session.greetVariant = pickOne(GREETING_MESSAGES) || GREETING_MESSAGES[0];
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

function parseSizeCm(text) {
  const t = normalizeText(text);

  let m = t.match(/(\d{1,2})\s*(cm|centimetros|centimetro)\b/);
  if (m) {
    const n = parseInt(m[1], 10);
    if (n >= 1 && n <= 60) return n;
  }

  const hasContext = /\b(tamanho|aprox|aproximado|mais ou menos|uns|cerca|medida)\b/.test(t);
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
  const t = normalizeText(text);
  const parts = [
    { match: /antebraco/, label: "antebraço" },
    { match: /\bbraco\b/, label: "braço" },
    { match: /\bombro\b/, label: "ombro" },
    { match: /\bcostas\b/, label: "costas" },
    { match: /\bpeito\b/, label: "peito" },
    { match: /\bperna\b/, label: "perna" },
    { match: /\bpanturrilha\b/, label: "panturrilha" },
    { match: /\bcanela\b/, label: "canela" },
    { match: /\bcoxa\b/, label: "coxa" },
    { match: /\bjoelho\b/, label: "joelho" },
    { match: /\bvirilha\b/, label: "virilha" },
    { match: /\bcostela\b/, label: "costela" },
    { match: /\bpescoco\b/, label: "pescoço" },
    { match: /\bmao\b/, label: "mão" },
    { match: /\bpunho\b/, label: "punho" },
    { match: /\bdedo\b/, label: "dedo" },
    { match: /\bpe\b/, label: "pé" },
    { match: /\btornozelo\b/, label: "tornozelo" },
    { match: /\bnuca\b/, label: "nuca" },
    { match: /\bescapula\b/, label: "escápula" },
    { match: /\bcoluna\b/, label: "coluna" },
    { match: /\brosto\b/, label: "rosto" },
    { match: /\bcabeca\b/, label: "cabeça" },
  ];

  for (const part of parts) {
    if (part.match.test(t)) return part.label;
  }
  return null;
}

function extractSizeLocation(text) {
  const size = parseSizeCm(text);
  if (size !== null) return `${size} cm`;
  const t = (text || "").trim();
  if (!t || !/\d/.test(t)) return null;
  return t;
}

function extractBodyRegion(text) {
  return parseBodyPart(text);
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
  const formatter = new Intl.DateTimeFormat("pt-BR", {
    timeZone: GCAL_TZ,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
  return formatter.format(new Date(date));
}

function dayOfWeek(date) {
  return new Date(date).getDay(); // 0 dom ... 6 sab
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

function dayOfWeekName(date) {
  const formatter = new Intl.DateTimeFormat("pt-BR", {
    timeZone: GCAL_TZ,
    weekday: "long",
  });
  const name = formatter.format(new Date(date));
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function buildSuggestionFromDate(slotStart, timeHM) {
  return {
    dateBR: fmtDateBR(slotStart),
    dateISO: slotStart.toISOString().slice(0, 10),
    timeHM,
    label: `${dayOfWeekName(slotStart)}, ${fmtDateBR(slotStart)} – ${timeHM}`,
    startISO: slotStart.toISOString(),
  };
}

async function buildNextAvailableSuggestionsDW({ durationMin = 180 }) {
  const now = new Date();
  const horizonDays = 60;

  const timeMinISO = startOfDay(now).toISOString();
  const timeMaxISO = addDays(startOfDay(now), horizonDays).toISOString();
  const busyRanges = GCAL_ENABLED ? await calendarFreeBusy({ timeMinISO, timeMaxISO }) : [];

  const usedDates = new Set();
  const suggestions = [];

  const findWeekdaySlot = (timeHM) => {
    for (let i = 1; i <= horizonDays; i += 1) {
      const d = addDays(now, i);
      const dow = dayOfWeek(d);
      if (dow === 0 || dow === 6) continue;

      const slotStart = new Date(d);
      const [hh, mm] = timeHM.split(":").map(Number);
      slotStart.setHours(hh, mm, 0, 0);

      if (slotStart.getTime() < now.getTime()) continue;

      const dateISO = slotStart.toISOString().slice(0, 10);
      if (usedDates.has(dateISO)) continue;

      const slotEnd = new Date(slotStart);
      slotEnd.setMinutes(slotEnd.getMinutes() + durationMin);

      if (!overlapsBusy(slotStart.toISOString(), slotEnd.toISOString(), busyRanges)) {
        usedDates.add(dateISO);
        return buildSuggestionFromDate(slotStart, timeHM);
      }
    }
    return null;
  };

  const findWeekendSlot = () => {
    for (let i = 1; i <= horizonDays; i += 1) {
      const d = addDays(now, i);
      const dow = dayOfWeek(d);
      let timeHM = "";
      if (dow === 6) timeHM = "10:00";
      if (dow === 0) timeHM = "14:00";
      if (!timeHM) continue;

      const slotStart = new Date(d);
      const [hh, mm] = timeHM.split(":").map(Number);
      slotStart.setHours(hh, mm, 0, 0);

      if (slotStart.getTime() < now.getTime()) continue;

      const dateISO = slotStart.toISOString().slice(0, 10);
      if (usedDates.has(dateISO)) continue;

      const slotEnd = new Date(slotStart);
      slotEnd.setMinutes(slotEnd.getMinutes() + durationMin);

      if (!overlapsBusy(slotStart.toISOString(), slotEnd.toISOString(), busyRanges)) {
        usedDates.add(dateISO);
        return buildSuggestionFromDate(slotStart, timeHM);
      }
    }
    return null;
  };

  const option1 = findWeekdaySlot("14:00");
  if (option1) suggestions.push(option1);

  const option2 = findWeekdaySlot("19:00");
  if (option2) suggestions.push(option2);

  const option3 = findWeekendSlot();
  if (option3) suggestions.push(option3);

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

function parseChoice1to3(text) {
  const t = (text || "").trim();
  if (/^[1-3]$/.test(t)) return Number(t);
  const m = t.match(/\b([1-3])\b/);
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

function roundToNearest10(n) {
  return Math.round(n / 10) * 10;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function computeQuote({ sizeCm, bodyPart, analysis }) {
  if (!sizeCm) {
    return { ok: false, reason: "missing_size" };
  }

  const base = 220;
  const perCm = 28;
  let price = base + sizeCm * perCm;

  const regionMultMap = {
    "antebraço": 1.0,
    "braço": 1.0,
    "ombro": 1.05,
    "perna": 1.05,
    "coxa": 1.08,
    "panturrilha": 1.08,
    "peito": 1.15,
    "costela": 1.18,
    "costas": 1.22,
    "pescoço": 1.12,
    "mão": 1.12,
  };
  const regionMult = regionMultMap[bodyPart] || 1.06;
  price *= regionMult;

  let complexityMult = 1.0;
  if (analysis) {
    const d = analysis.detailLevel || "medio";
    const bg = analysis.hasBackground === true;

    if (d === "baixo") complexityMult *= 0.98;
    if (d === "medio") complexityMult *= 1.06;
    if (d === "alto") complexityMult *= 1.14;
    if (d === "incerto") complexityMult *= 1.02;

    if (bg) complexityMult *= 1.08;

    const shade = analysis.shadingComplexity || "medio";
    if (shade === "alto") complexityMult *= 1.08;
    if (shade === "incerto") complexityMult *= 1.01;
  } else {
    complexityMult *= 1.03;
  }
  price *= complexityMult;

  price = roundToNearest10(price);
  price = clamp(price, 350, 2500);

  let sessions = 1;
  if (sizeCm <= 12) sessions = 1;
  else if (sizeCm <= 18) sessions = 1;
  else sessions = 2;

  if (
    sessions === 1 &&
    sizeCm >= 14 &&
    analysis &&
    analysis.detailLevel === "alto" &&
    analysis.shadingComplexity === "alto"
  ) {
    sessions = 2;
  }

  return {
    ok: true,
    price,
    sessions,
    breakdown: { base, perCm, regionMult, complexityMult },
  };
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

function buildHeuristicAnalysis({ sizeCm, bodyPart, notes }) {
  const t = normalizeText(notes);
  const detailHigh = /\b(realismo|retrato|muito detalhado|detalhado|micro|hiperreal|textura|mandala)\b/.test(t);
  const detailLow = /\b(minimal|simples|linha|tra(c|ç)o leve)\b/.test(t);
  const hasBackground = /\b(fundo|background|paisagem|cenario|preenchido)\b/.test(t);
  const shadeHigh = /\b(muita sombra|sombra pesada|preto solido|contraste alto)\b/.test(t);
  const shadeMedium = /\b(sombra|esfumado|degrade|transicao|whip)\b/.test(t);
  const lineDense = /\b(linework|linhas finas|tra(c|ç)o fino|ornamento)\b/.test(t);

  let detailLevel = "medio";
  if (detailHigh) detailLevel = "alto";
  if (detailLow) detailLevel = "baixo";

  let shadingComplexity = "medio";
  if (shadeHigh) shadingComplexity = "alto";
  if (!shadeHigh && !shadeMedium) shadingComplexity = "baixo";

  let lineworkDensity = "medio";
  if (lineDense) lineworkDensity = "alto";
  if (detailLow && !lineDense) lineworkDensity = "baixo";

  const elementsCount = /\b(duas|dois|tres|tr[eê]s|quatro|varios|v[áa]rios|muitos|multiplos)\b/.test(t) ? 2 : 1;
  const sizeLine = sizeCm ? `${sizeCm} cm` : "tamanho a confirmar";
  const placeLine = bodyPart || "local a confirmar";

  const notesHuman =
    `Pelo texto, parece um projeto com ${detailLevel} nível de detalhe` +
    (hasBackground ? " e algum fundo/ornamento" : "") +
    `. Tamanho ${sizeLine} no ${placeLine}.`;

  return {
    detailLevel,
    hasBackground,
    lineworkDensity,
    shadingComplexity,
    elementsCount,
    notesHuman,
  };
}

function normalizeAnalysisPayload(payload, fallback) {
  const safe = { ...fallback, ...payload };
  const allowed = ["baixo", "medio", "alto", "incerto"];
  if (!allowed.includes(safe.detailLevel)) safe.detailLevel = fallback.detailLevel;
  if (!allowed.includes(safe.lineworkDensity)) safe.lineworkDensity = fallback.lineworkDensity;
  if (!allowed.includes(safe.shadingComplexity)) safe.shadingComplexity = fallback.shadingComplexity;
  safe.hasBackground = Boolean(safe.hasBackground);
  const count = parseInt(safe.elementsCount, 10);
  safe.elementsCount = Number.isFinite(count) ? count : fallback.elementsCount;
  safe.notesHuman = String(safe.notesHuman || fallback.notesHuman || "").trim();
  return safe;
}

async function buildArtAnalysis({ sizeCm, bodyPart, notes, imageUrl }) {
  const fallback = buildHeuristicAnalysis({ sizeCm, bodyPart, notes });
  if (!ENV.OPENAI_API_KEY || !imageUrl) {
    return fallback;
  }

  try {
    const resp = await openai.chat.completions.create({
      model: "gpt-4o",
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "Você é um tatuador experiente analisando referências. " +
            "Descreva somente o que está claramente visível. " +
            "Não invente elementos. Se algo não estiver claro, use 'incerto'. " +
            "Responda apenas com JSON válido.",
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text:
                "Analise a referência e devolva apenas este JSON curto:\n" +
                "{\n" +
                '  "detailLevel": "baixo|medio|alto|incerto",\n' +
                '  "hasBackground": true|false,\n' +
                '  "lineworkDensity": "baixo|medio|alto|incerto",\n' +
                '  "shadingComplexity": "baixo|medio|alto|incerto",\n' +
                '  "elementsCount": number,\n' +
                '  "notesHuman": "1-2 frases humanas resumindo sem inventar"\n' +
                "}\n" +
                "Se não tiver certeza, use 'incerto' nos níveis e descreva a dúvida nas notesHuman.",
            },
            { type: "image_url", image_url: { url: imageUrl } },
          ],
        },
      ],
    });

    const raw = resp.choices?.[0]?.message?.content?.trim();
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return normalizeAnalysisPayload(parsed, fallback);
  } catch (e) {
    console.error("[ART ANALYSIS ERROR]", e?.message || e);
    return fallback;
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
  return "• A partir dessa mensagem, você tem 4 horas pra realizar o pagamento e enviar o comprovante.";
}

function msgFicoNoAguardoComprovante() {
  return "Perfeito, fico no aguardo do comprovante ✅";
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
    "Perfeito! Pra garantir o seu horário, o sinal é:\n" +
    "R$ 50,00\n\n" +
    "Chave Pix:\n" +
    `${pixLine}\n\n` +
    "Assim que fizer o Pix, me manda o comprovante aqui pra eu confirmar o agendamento ✅\n\n" +
    depositDeadlineLine()
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
  lines.push("Tenho estes horários disponíveis:");
  (suggestions || []).slice(0, 3).forEach((s, idx) => {
    lines.push(`${idx + 1}) ${s.label}`);
  });
  lines.push("Se algum desses horários ficar bom pra você, me fala 1, 2 ou 3.");
  lines.push("Se quiser um dia/horário específico, pode mandar também (ex: 15/01/2026 16:00).");
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

function msgAgendamentoPreReserva(resumo) {
  return (
    "Fechado ✅ Separei esse horário pra você.\n" +
    "Pra garantir, agora é só fazer o sinal e me mandar o comprovante.\n\n" +
    "Resumo:\n" +
    `${resumo}`
  );
}

function msgPedirSinalPixDepoisAgendar() {
  return (
    "Show! Para finalizar seu agendamento e garantir seu horário, o sinal é de R$ 50,00.\n" +
    "Esse valor é totalmente abatido no total da tattoo no dia.\n\n" +
    "Chave Pix:\n" +
    "dwtattooshop@gmail.com\n\n" +
    "Assim que fizer o Pix, só me enviar o comprovante aqui.\n" +
    "O prazo para envio é de 4 horas — após isso, o agendamento é cancelado automaticamente pra manter tudo organizado na agenda.\n\n" +
    "Qualquer coisa, estou aqui."
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

async function isSlotAvailable({ date, timeHM, durationMin }) {
  const slotStart = new Date(date);
  const [hh, mm] = timeHM.split(":").map(Number);
  slotStart.setHours(hh, mm, 0, 0);
  const slotEnd = new Date(slotStart);
  slotEnd.setMinutes(slotEnd.getMinutes() + durationMin);

  const timeMinISO = startOfDay(slotStart).toISOString();
  const timeMaxISO = addDays(startOfDay(slotStart), 1).toISOString();
  const busyRanges = GCAL_ENABLED ? await calendarFreeBusy({ timeMinISO, timeMaxISO }) : [];
  return !overlapsBusy(slotStart.toISOString(), slotEnd.toISOString(), busyRanges);
}

async function confirmScheduleSelection({ session, phone, slot }) {
  session.pendingSlot = slot;
  session.scheduleConfirmed = false;
  session.waitingSchedule = false;

  const resumo = `• ${slot.dateBR} às ${slot.timeHM}`;
  const msgOk = msgAgendamentoPreReserva(resumo);
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
  return true;
}

function msgCuidadosFinal() {
  return (
    "Vou te mandar algumas orientações pra você seguir antes da nossa sessão:\n\n" +
    "• Beba bastante água no dia anterior.\n" +
    "• Evite álcool nas 24h antes da sessão.\n" +
    "• Passe creme hidratante na região (quanto antes começar, melhor).\n" +
    "• Coma antes da sessão, não venha de estômago vazio.\n" +
    "• Use roupa confortável.\n\n" +
    "Reagendamento:\n" +
    "• Se precisar remarcar, só avisar com até 24h de antecedência.\n" +
    "• Depois disso não consigo ajustar porque o horário já fica separado pra você e eu não consigo reagendar.\n\n" +
    "Qualquer coisa até o dia, é só chamar. Tamo junto!"
  );
}

async function confirmCalendarEventAfterReceipt({ session, phone, slot }) {
  if (!GCAL_ENABLED || !slot) return { ok: true, skipped: true };
  const durationMin = session.durationMin || 180;
  if (typeof createCalendarEvent === "function") {
    return await createCalendarEvent({
      session,
      phone,
      dateISO: slot.dateISO,
      timeHM: slot.timeHM,
      durationMin,
      title: buildCalendarTitle(session, phone),
    });
  }
  return await upsertCalendarHoldOrEvent({
    session,
    phone,
    dateISO: slot.dateISO,
    timeHM: slot.timeHM,
    durationMin,
    title: buildCalendarTitle(session, phone),
  });
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

function parseSpecificDateTime(text) {
  const normalized = normalizeText(text);
  const timeMatch = normalized.match(/(\d{1,2})\s*:\s*(\d{2})|\b(\d{1,2})\s*h\b/);
  if (!timeMatch) return null;

  const hour = timeMatch[1] ? Number(timeMatch[1]) : Number(timeMatch[3]);
  const minute = timeMatch[2] ? Number(timeMatch[2]) : 0;
  if (Number.isNaN(hour) || Number.isNaN(minute)) return null;
  if (hour > 23 || minute > 59) return null;

  const dateMatch = normalized.match(/(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?/);
  const dowMap = {
    domingo: 0,
    segunda: 1,
    "segunda-feira": 1,
    terca: 2,
    "terca-feira": 2,
    quarta: 3,
    "quarta-feira": 3,
    quinta: 4,
    "quinta-feira": 4,
    sexta: 5,
    "sexta-feira": 5,
    sabado: 6,
    "sabado-feira": 6,
  };

  const now = new Date();

  if (dateMatch) {
    const day = Number(dateMatch[1]);
    const month = Number(dateMatch[2]) - 1;
    const yearRaw = dateMatch[3];
    let year = yearRaw ? Number(yearRaw) : now.getFullYear();
    if (year < 100) year += 2000;

    let candidate = new Date(year, month, day, hour, minute, 0, 0);
    if (candidate.getTime() < now.getTime() && !yearRaw) {
      candidate = new Date(year + 1, month, day, hour, minute, 0, 0);
    }
    return { date: candidate, timeHM: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}` };
  }

  for (const [label, dow] of Object.entries(dowMap)) {
    if (!normalized.includes(label)) continue;
    const candidate = new Date(now);
    const currentDow = candidate.getDay();
    let diff = (dow - currentDow + 7) % 7;
    if (diff === 0 && (candidate.getHours() > hour || (candidate.getHours() === hour && candidate.getMinutes() >= minute))) {
      diff = 7;
    }
    candidate.setDate(candidate.getDate() + diff);
    candidate.setHours(hour, minute, 0, 0);
    return { date: candidate, timeHM: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}` };
  }

  return null;
}

function msgChecagemDuvidas() {
  return (
    "Antes de eu te passar o investimento:\n\n" +
    "Ficou alguma dúvida sobre o atendimento?\n" +
    "Se estiver tudo certo, me responde *OK* que eu já te mando o valor e as formas de pagamento."
  );
}

function msgConfirmacaoDescricao() {
  return "Só me confirma se você quer adicionar ou remover alguma coisa nessa arte da referência. Se estiver tudo certinho, eu já sigo pro orçamento.";
}

function msgOrcamentoNovo() {
  return (
    "Show! Então vamos montar um orçamento novo bem certinho.\n\n" +
    "Pra eu te passar um valor bem fiel, me manda:\n" +
    "• *a referência em imagem* (se tiver)\n" +
    "• *onde no corpo* você quer fazer + *tamanho aproximado*\n\n" +
    "Se você tiver alguma ideia de ajuste além da referência, pode falar também."
  );
}

function msgOrcamentoCompleto(valor, sessions) {
  const hasOneSession = Number(sessions) <= 1;
  const sessionLine = hasOneSession
    ? "Esse trabalho a gente faz em 1 única sessão, pra ficar bem executado e cicatrizar bem."
    : "Se for um trabalho maior e passar de ~7h, a gente divide em 2 sessões pra manter o nível e cicatrização redonda.";
  return (
    `Pelo tamanho e complexidade do que você me enviou, o investimento fica em *R$ ${valor}*.\n\n` +
    "Formas de pagamento:\n" +
    "• Pix\n" +
    "• Débito\n" +
    "• Crédito em até 12x (+ acréscimo da máquina)\n\n" +
    sessionLine
  );
}

async function sendQuoteFlow(phone, session, message) {
  if (!session.sizeCm) {
    const reply =
      "Me diz só o tamanho aproximado em cm (ex: 10cm, 15cm, 18cm) pra eu fechar o orçamento certinho.";
    if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
    session.stage = "aguardando_info";
    return false;
  }

  try {
    const notes = [session.descriptionText, session.adjustNotes, message].filter(Boolean).join(" ");
    const imageForAnalysis = session.referenceImageUrl || session.imageDataUrl;
    const analysis = await buildArtAnalysis({
      sizeCm: session.sizeCm,
      bodyPart: session.bodyPart || session.bodyRegion,
      notes,
      imageUrl: session.hasReferenceImage ? imageForAnalysis : null,
    });

    const quoteResult = computeQuote({
      sizeCm: session.sizeCm,
      bodyPart: session.bodyPart || session.bodyRegion,
      analysis,
    });

    if (!quoteResult.ok) {
      const reply =
        "Me diz só o tamanho aproximado em cm (ex: 10cm, 15cm, 18cm) pra eu fechar o orçamento certinho.";
      if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
      session.stage = "aguardando_info";
      return false;
    }

    let finalPrice = quoteResult.price;
    if (
      session.lastQuoteSizeCm &&
      session.lastQuotePrice &&
      session.sizeCm !== session.lastQuoteSizeCm &&
      finalPrice === session.lastQuotePrice
    ) {
      finalPrice += 50;
    }

    if (process.env.NODE_ENV !== "production") {
      console.log(
        `[QUOTE] sizeCm=${session.sizeCm} bodyPart=${session.bodyPart || session.bodyRegion || "n/a"} price=${finalPrice} ` +
          `breakdown=${JSON.stringify(quoteResult.breakdown)}`
      );
    }

    const analysisLines = [
      "Fechado. Pra eu te passar um valor bem fiel, eu considerei:",
      `• Tamanho: ${session.sizeCm} cm`,
      `• Local: ${session.bodyPart || session.bodyRegion || "a confirmar"}`,
      analysis?.notesHuman ? `• Detalhes: ${analysis.notesHuman}` : null,
      "Isso influencia direto no tempo de sessão e na quantidade de sombra/detalhe pra ficar bem executado e cicatrizar redondo.",
    ]
      .filter(Boolean)
      .join("\n");
    if (!antiRepeat(session, analysisLines)) await zapiSendText(phone, analysisLines);

    const quote = msgOrcamentoCompleto(finalPrice, quoteResult.sessions);
    if (!antiRepeat(session, quote)) await zapiSendText(phone, quote);

    const durationMin = session.durationMin || 180;
    const suggestions = await buildNextAvailableSuggestionsDW({ durationMin });

    if (suggestions.length < 3) {
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
    } else {
      session.suggestedSlots = suggestions;
      session.waitingSchedule = true;
      session.stage = "aguardando_escolha_agendamento";

      const reply = msgOpcoesAgendamentoComDatasDW(suggestions);
      if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
    }

    session.sentQuote = true;
    session.waitingReceipt = false;
    session.lastQuoteSizeCm = session.sizeCm;
    session.lastQuotePrice = finalPrice;

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
  if (inbound.raw) p.payload = inbound.raw;

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
      payload: p.payload,
    };

    // limpa buffer antes de processar (pra não duplicar)
    p.textParts = [];
    p.imageUrl = null;
    p.imageMime = "image/jpeg";
    p.messageType = "";
    p.payload = null;

    // processa (async)
    processMergedInbound(merged.phone, merged).catch((e) => {
      console.error("[PROCESS MERGED ERROR]", e?.message || e);
    });
  }, delay);
}

// -------------------- Core processor --------------------
async function processMergedInbound(phone, merged) {
  const session = getSession(phone);

  const payload = merged.payload || null;
  const incomingText = getIncomingText(payload);
  const message = String(incomingText ?? merged.message ?? "").trim();
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
    if (session.scheduleConfirmed || session.stage === "aguardando_comprovante" || session.pendingSlot) {
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

  const maybeRegion = parseBodyPart(message);
  if (maybeRegion) {
    session.bodyPart = maybeRegion;
    session.bodyRegion = maybeRegion;
  }

  const maybeSizeCm = parseSizeCm(message);
  if (maybeSizeCm !== null) {
    session.sizeCm = maybeSizeCm;
    session.sizeLocation = `${maybeSizeCm} cm`;
  }

  const maybeSizeLoc = extractSizeLocation(message);
  if (maybeSizeLoc) session.sizeLocation = maybeSizeLoc;

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

  // -------------------- PRIMEIRO CONTATO (saudação + intents) --------------------
  const isFreshStart = !session.stage || session.stage === "start" || session.stage === "inicio";
  if (isFreshStart) {
    if (wantsNewBudget(message)) {
      session.firstContactResolved = true;
      session.stage = "aguardando_referencia";
      const budgetReply = msgOrcamentoNovo();
      if (!antiRepeat(session, budgetReply)) await zapiSendText(phone, budgetReply);
      scheduleFollowup30min(phone, session, "gate resolvido, aguardando referência");
      return;
    }

    if (wantsContinueBudget(message)) {
      await handoffToManual(phone, session, "cliente com orçamento em andamento", message);
      return;
    }

    const normalized = norm(message);
    const isAmbiguous = !normalized || (!wantsNewBudget(message) && !wantsContinueBudget(message) && normalized.split(" ").length <= 2);
    if (isGenericGreeting(message) || isAmbiguous) {
      session.stage = "primeiro_contato_choice";
      session.firstContactReprompted = false;
      const pollText = "Só pra eu te direcionar certinho 👇\nÉ seu primeiro contato comigo?";
      const buttons = [
        { id: "pc_yes_new", title: "Sim — orçamento novo" },
        { id: "pc_no_running", title: "Não — já tenho orçamento" },
      ];
      await sendButtons(phone, pollText, buttons);
      return;
    }
  }

  // -------------------- FLUXO (gate primeiro contato) --------------------
  if (session.stage === "primeiro_contato_choice" || session.stage === "aguardando_primeiro_contato") {
    const btn = getButtonReplyId(payload);
    const t = norm(message);
    const wantsNew =
      btn === "pc_yes_new" ||
      hasAny(t, ["1", "sim", "primeira vez", "primeiro contato", "do zero", "novo"].map((value) => norm(value)));
    const wantsContinue =
      btn === "pc_no_running" ||
      hasAny(t, ["2", "nao", "não", "em andamento", "continuar", "ja tenho"].map((value) => norm(value)));

    if (wantsNew) {
      session.firstContactResolved = true;
      session.stage = "aguardando_referencia";
      const reply = msgOrcamentoNovo();
      if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
      scheduleFollowup30min(phone, session, "gate resolvido, aguardando referência");
      return;
    }

    if (wantsContinue) {
      await handoffToManual(phone, session, "cliente com orçamento em andamento", message);
      return;
    }

    if (!session.firstContactReprompted) {
      session.firstContactReprompted = true;
      const retry = "Me responde clicando em uma opção aí embaixo 🙂";
      const buttons = [
        { id: "pc_yes_new", title: "Sim — orçamento novo" },
        { id: "pc_no_running", title: "Não — já tenho orçamento" },
      ];
      if (!antiRepeat(session, retry)) await zapiSendText(phone, retry);
      await sendButtons(phone, "Só pra eu te direcionar certinho 👇\nÉ seu primeiro contato comigo?", buttons);
      return;
    }

    session.firstContactResolved = true;
    session.stage = "aguardando_referencia";
    const reply = msgOrcamentoNovo();
    if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
    scheduleFollowup30min(phone, session, "fallback gate, seguindo orçamento novo");
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
    const slot = session.pendingSlot || session.calendarHold;
    const slotLabel = slot ? `${slot.dateBR || slot.dateISO} ${slot.timeHM}` : "não informado";

    await notifyOwner(
      [
        "💸 COMPROVANTE RECEBIDO (bot)",
        `• Cliente: ${String(phone).replace(/\D/g, "")}`,
        `• Slot escolhido: ${slotLabel}`,
        "• Mensagem: Comprovante recebido. Confirmar no Google Agenda.",
      ].join("\n")
    );

    await confirmCalendarEventAfterReceipt({ session, phone, slot });

    session.scheduleConfirmed = true;
    session.stage = "agendamento_confirmado";
    session.pendingSlot = null;

    if (slot) {
      const resumo = `• ${slot.dateBR || slot.dateISO} às ${slot.timeHM}`;
      const confirmMsg = msgAgendamentoConfirmado(resumo);
      if (!antiRepeat(session, confirmMsg)) await zapiSendText(phone, confirmMsg);
    } else {
      if (!antiRepeat(session, "Agendamento confirmado ✅")) await zapiSendText(phone, "Agendamento confirmado ✅");
    }

    const cuidados = msgCuidadosFinal();
    if (!antiRepeat(session, cuidados)) await zapiSendText(phone, cuidados);
    return;
  }

  // ✅ imagem referência chegou -> salva + analisa
  if (imageUrl && !isReceiptImage) {
    try {
      session.referenceImageUrl = imageUrl;
      session.hasReferenceImage = true;
      const dataUrl = await fetchImageAsDataUrl(imageUrl, imageMime);
      session.imageDataUrl = dataUrl;
      session.descriptionText = null;
      session.descriptionConfirmed = false;
      session.pendingDescChanges = "";
      session.adjustNotes = "";
      session.confirmationAskedOnce = false;

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

      if (
        session.stage === "ref_change_choice" ||
        session.stage === "coletar_ajustes_referencia" ||
        session.stage === "aguardando_confirmacao_descricao" ||
        session.stage === "aguardando_ajustes_descricao"
      ) {
        session.stage = "coletar_ajustes_referencia";
        await zapiSendText(
          phone,
          "Recebi mais uma referência. Me diz o que você quer incorporar dela (ou o que quer remover) e já sigo pro orçamento."
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
      session.adjustNotes = "";
      session.confirmationAskedOnce = false;
      session.stage = "ref_change_choice";
      session.refChangeReprompted = false;

      await zapiSendText(
        phone,
        desc +
          "\n\n" +
          msgConfirmacaoDescricao()
      );
      await sendButtons(phone, "Você quer alterar algo nessa referência?", [
        { id: "ref_change_yes", title: "Sim — quero alterar" },
        { id: "ref_change_no", title: "Não — tá tudo certo" },
      ]);

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

  if (session.stage === "ref_change_choice" || session.stage === "aguardando_confirmacao_descricao") {
    const btn = getButtonReplyId(payload);
    const t = norm(message);
    const NO_NO_CHANGE = [
      "nao",
      "não",
      "n",
      "negativo",
      "deixa assim",
      "assim mesmo",
      "do jeito que ta",
      "do jeito que está",
      "ta bom",
      "tá bom",
      "ok",
      "certo",
      "certinho",
      "tudo certo",
      "tudo ok",
      "perfeito assim",
      "pode seguir",
      "segue",
      "pode ir",
      "manda bala",
      "fechado",
      "fechou",
      "beleza",
      "tranquilo",
      "suave",
      "nao quero mudar",
      "não quero mudar",
      "nao quero alterar",
      "não quero alterar",
      "nao quero remover",
      "não quero remover",
      "nao quero adicionar",
      "não quero adicionar",
      "sem ajustes",
      "sem mudanca",
      "sem mudança",
    ].map((value) => norm(value));

    const YES_WANTS_CHANGE = [
      "sim",
      "s",
      "quero",
      "quero sim",
      "pode",
      "pode sim",
      "mudar",
      "alterar",
      "trocar",
      "ajustar",
      "corrigir",
      "refazer",
      "rever",
      "adicionar",
      "colocar",
      "incluir",
      "remover",
      "tirar",
      "apagar",
      "sem isso",
    ].map((value) => norm(value));

    const choseNo = btn === "ref_change_no" || hasAny(t, NO_NO_CHANGE);
    const choseYes = btn === "ref_change_yes" || hasAny(t, YES_WANTS_CHANGE);

    if (choseNo) {
      session.adjustNotes = "";
      session.stage = "aguardando_resposta_orcamento";
      await zapiSendText(phone, "Perfeito! Vou calcular o investimento para você.");
      await sendQuoteFlow(phone, session, message);
      return;
    }

    if (choseYes) {
      session.stage = "coletar_ajustes_referencia";
      await zapiSendText(
        phone,
        "Fechou. Me diz certinho o que você quer alterar, adicionar ou remover nessa referência."
      );
      return;
    }

    if (!session.refChangeReprompted) {
      session.refChangeReprompted = true;
      await zapiSendText(phone, "Só pra eu não errar: você quer alterar algo? Clica em Sim ou Não 🙂");
      await sendButtons(phone, "Você quer alterar algo nessa referência?", [
        { id: "ref_change_yes", title: "Sim — quero alterar" },
        { id: "ref_change_no", title: "Não — tá tudo certo" },
      ]);
      return;
    }

    session.adjustNotes = "";
    session.stage = "aguardando_resposta_orcamento";
    await zapiSendText(phone, "Perfeito! Vou calcular o investimento para você.");
    await sendQuoteFlow(phone, session, message);
    return;
  }

  if (session.stage === "coletar_ajustes_referencia" || session.stage === "aguardando_ajustes_descricao") {
    if (message) {
      session.adjustNotes = session.adjustNotes ? `${session.adjustNotes}\n${message}` : message;
      await zapiSendText(phone, "Anotado ✅ Vou considerar esses ajustes e já sigo pro orçamento.");
      session.stage = "aguardando_resposta_orcamento";
      await sendQuoteFlow(phone, session, message);
    }
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
          session.stage = "ref_change_choice";
          session.refChangeReprompted = false;
          await zapiSendText(
            phone,
            session.descriptionText +
              "\n\n" +
              msgConfirmacaoDescricao()
          );
          await sendButtons(phone, "Você quer alterar algo nessa referência?", [
            { id: "ref_change_yes", title: "Sim — quero alterar" },
            { id: "ref_change_no", title: "Não — tá tudo certo" },
          ]);
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
      const specificRequest = parseSpecificDateTime(message);
      if (specificRequest) {
        const slot = {
          dateBR: fmtDateBR(specificRequest.date),
          dateISO: specificRequest.date.toISOString().slice(0, 10),
          timeHM: specificRequest.timeHM,
        };
        const isFree = await isSlotAvailable({
          date: specificRequest.date,
          timeHM: specificRequest.timeHM,
          durationMin,
        });

        if (isFree) {
          const ok = await confirmScheduleSelection({ session, phone, slot });
          if (!ok) {
            const fallback = msgVouVerificarAgendaComData();
            if (!antiRepeat(session, fallback)) await zapiSendText(phone, fallback);
            await notifyOwner(
              [
                "📅 HORÁRIO ESPECÍFICO INDISPONÍVEL (bot)",
                `• Cliente: ${String(phone).replace(/\D/g, "")}`,
                `• Pedido: ${message.slice(0, 200)}`,
                "• Ação: verificar agenda manualmente",
              ].join("\n")
            );
            session.manualHandoff = true;
            session.stage = "manual_pendente";
          }
          return;
        }
      }

      const suggestions = await buildNextAvailableSuggestionsDW({ durationMin });

      if (suggestions.length < 3) {
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

    // 3.1) Se cliente mandou dia/horário específico
    const specificRequest = parseSpecificDateTime(txt);
    if (specificRequest) {
      const durationMin = session.durationMin || 180;
      const slot = {
        dateBR: fmtDateBR(specificRequest.date),
        dateISO: specificRequest.date.toISOString().slice(0, 10),
        timeHM: specificRequest.timeHM,
      };
      const isFree = await isSlotAvailable({
        date: specificRequest.date,
        timeHM: specificRequest.timeHM,
        durationMin,
      });

      if (isFree) {
        const ok = await confirmScheduleSelection({ session, phone, slot });
        if (!ok) {
          const retry = msgVouVerificarAgendaComData();
          if (!antiRepeat(session, retry)) await zapiSendText(phone, retry);
          await notifyOwner(
            [
              "📅 HORÁRIO ESPECÍFICO INDISPONÍVEL (bot)",
              `• Cliente: ${String(phone).replace(/\D/g, "")}`,
              `• Pedido: ${txt.slice(0, 200)}`,
              "• Ação: verificar agenda manualmente",
            ].join("\n")
          );
          session.manualHandoff = true;
          session.stage = "manual_pendente";
        }
        return;
      }

      const suggestions = await buildNextAvailableSuggestionsDW({ durationMin });
      if (suggestions.length < 3) {
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

    // 3.2) Escolha 1-3
    const choice = parseChoice1to3(txt);
    if (!choice || !session.suggestedSlots || !session.suggestedSlots[choice - 1]) {
      const retry = "Me diz só *1, 2 ou 3* ✅ (ou manda um dia/horário específico).";
      if (!antiRepeat(session, retry)) await zapiSendText(phone, retry);
      return;
    }

    const slot = session.suggestedSlots[choice - 1];
    const ok = await confirmScheduleSelection({ session, phone, slot });
    if (!ok) {
      const durationMin = session.durationMin || 180;
      const suggestions = await buildNextAvailableSuggestionsDW({ durationMin });
      if (suggestions.length < 3) {
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
      const reply =
        "Esse horário acabou de ficar indisponível. Te mando outras opções livres ✅\n\n" +
        msgOpcoesAgendamentoComDatasDW(suggestions);
      if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
      return;
    }
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
  if (
    !session.imageDataUrl &&
    session.stage !== "inicio" &&
    session.stage !== "aguardando_primeiro_contato" &&
    session.stage !== "primeiro_contato_choice" &&
    session.stage !== "ref_change_choice" &&
    session.stage !== "coletar_ajustes_referencia"
  ) {
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
