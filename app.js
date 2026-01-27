// ============================================================
// DW WhatsApp Bot — Jeezy Edition (Z-API + DW Premium Invisível)
// ATUALIZAÇÕES (PRONTO):
// 1) PRIMEIRO CONTATO: 2 opções -> "Orçamento novo" e "Falar comigo" (sem parecer bot)
// 2) NOTIFICAÇÃO PRO SEU PESSOAL: quando cliente pedir "falar com você" (em botão ou texto)
// 3) PERSISTÊNCIA JSON: sessões + idempotência (não perde ao reiniciar / evita duplicadas)
// 4) IDPOTÊNCIA REAL: ignora reenvio do mesmo webhook (messageId)
// 5) ANCORAGEM DW no orçamento (antes do preço), mantendo sua lógica de horas
// ============================================================

import express from "express";
import crypto from "crypto";
import OpenAI from "openai";
import fs from "fs/promises";
import path from "path";

const app = express();
app.use(express.json({ limit: "25mb" }));

// -------------------- ENV --------------------
const ENV = {
  PORT: Number(process.env.PORT || 10000),

  // Z-API
  ZAPI_INSTANCE_ID: process.env.ZAPI_INSTANCE_ID || process.env.ID_INSTÂNCIA_ZAPI,
  ZAPI_INSTANCE_TOKEN: process.env.ZAPI_INSTANCE_TOKEN || process.env.ZAPI_INSTANCE_TOKEN,
  ZAPI_CLIENT_TOKEN: process.env.ZAPI_CLIENT_TOKEN || process.env.ZAPI_CLIENT_TOKEN,

  OWNER_PHONE: process.env.OWNER_PHONE || process.env.TELEFONE_DO_PROPRIETÁRIO || "",
  PIX_KEY: process.env.PIX_KEY || "",

  // OpenAI
  OPENAI_API_KEY: process.env.OPENAI_API_KEY || "",

  // Google Calendar (opcional)
  GCAL_ENABLED:
    String(process.env.GCAL_ENABLED || process.env.GCAL_ATIVADO || "").toLowerCase() === "true" ||
    String(process.env.GCAL_ENABLED || process.env.GCAL_ATIVADO || "").toLowerCase() === "verdadeiro",
  GCAL_TZ: process.env.GCAL_TZ || "America/Sao_Paulo",

  // Preço por hora
  HOUR_FIRST: Number(process.env.HOUR_FIRST || 130),
  HOUR_NEXT: Number(process.env.HOUR_NEXT || 120),

  // Persistência (JSON)
  STORE_PATH: process.env.STORE_PATH || "./dw_store.json",
  IDEMPOTENCY_TTL_HOURS: Number(process.env.IDEMPOTENCY_TTL_HOURS || 48),
};

function missingEnvs() {
  const miss = [];
  if (!ENV.ZAPI_INSTANCE_ID) miss.push("ZAPI_INSTANCE_ID/ID_INSTÂNCIA_ZAPI");
  if (!ENV.ZAPI_INSTANCE_TOKEN) miss.push("ZAPI_INSTANCE_TOKEN");
  if (!ENV.ZAPI_CLIENT_TOKEN) miss.push("ZAPI_CLIENT_TOKEN");
  return miss;
}

// -------------------- OpenAI --------------------
const openai = ENV.OPENAI_API_KEY ? new OpenAI({ apiKey: ENV.OPENAI_API_KEY }) : null;

const BASE_SYSTEM =
  "Você é o DW Tattooer, tatuador profissional atendendo no WhatsApp (tom humano, direto e profissional). " +
  "Regras: Nunca diga que é IA. Não assine. Não fale de preço/hora sem ser solicitado. " +
  "Você trabalha com realismo preto e cinza (black & grey) + whip shading. " +
  "Se o cliente quiser colorido, diga que você trabalha apenas black & grey.";

// -------------------- JSON Store (sessions + processed) --------------------
const STORE = {
  sessions: {}, // phone -> session
  processed: {}, // msgId -> { at, phone }
};

function nowMs() {
  return Date.now();
}

async function loadStore() {
  try {
    const raw = await fs.readFile(ENV.STORE_PATH, "utf-8");
    const data = JSON.parse(raw);
    if (data && typeof data === "object") {
      STORE.sessions = data.sessions || {};
      STORE.processed = data.processed || {};
    }
  } catch {
    // first run
  }
}

let saveTimer = null;
function scheduleSaveStore() {
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    try {
      const dir = path.dirname(ENV.STORE_PATH);
      if (dir && dir !== ".") await fs.mkdir(dir, { recursive: true }).catch(() => {});
      await fs.writeFile(
        ENV.STORE_PATH,
        JSON.stringify({ sessions: STORE.sessions, processed: STORE.processed }, null, 2),
        "utf-8"
      );
    } catch (e) {
      console.error("[STORE SAVE ERROR]", e?.message || e);
    }
  }, 350);
}

function cleanupProcessed() {
  const ttl = ENV.IDEMPOTENCY_TTL_HOURS * 60 * 60 * 1000;
  const cut = nowMs() - ttl;
  for (const [id, v] of Object.entries(STORE.processed)) {
    if (!v?.at || v.at < cut) delete STORE.processed[id];
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

// -------------------- Z-API helpers --------------------
async function zapiFetch(path, payload) {
  const url = `https://api.z-api.io/instances/${ENV.ZAPI_INSTANCE_ID}/token/${ENV.ZAPI_INSTANCE_TOKEN}${path}`;
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

async function zapiSendText(phone, message) {
  return zapiFetch("/send-text", { phone, message });
}

async function humanDelay() {
  await new Promise((resolve) => setTimeout(resolve, 1200 + Math.random() * 800));
}

async function sendText(phone, message) {
  await humanDelay();
  return zapiSendText(phone, message);
}

async function sendButtons(phone, text, buttons, label = "menu") {
  await humanDelay();

  try {
    const resp = await zapiFetch("/send-button-list", {
      phone,
      message: text,
      buttonList: {
        title: label,
        buttons: buttons.map((b) => ({ id: b.id, label: b.title })),
      },
    });
    console.log("[SEND BUTTON LIST OK]", resp);
    return true;
  } catch (err) {
    console.log("[SEND BUTTON LIST FAIL]", err?.message || err);
  }

  try {
    const resp = await zapiFetch("/send-buttons", {
      phone,
      message: text,
      buttons: buttons.map((b) => ({ id: b.id, title: b.title })),
    });
    console.log("[SEND BUTTONS OK]", resp);
    return true;
  } catch (err) {
    console.log("[SEND BUTTONS FAIL]", err?.message || err);
  }

  await zapiSendText(
    phone,
    `${text}\n1) ${buttons[0]?.title || ""}\n2) ${buttons[1]?.title || ""}\nResponda 1 ou 2.`
  );
  return false;
}

async function notifyOwner(text) {
  if (!ENV.OWNER_PHONE) return;
  try {
    await zapiSendText(ENV.OWNER_PHONE, text);
  } catch {}
}

// -------------------- Normalização inbound --------------------
function getIncomingText(payload) {
  if (!payload) return "";
  if (typeof payload === "string") return payload;
  if (typeof payload === "object") {
    if (payload.buttonId) return payload.buttonTitle || payload.buttonId;
    const t = payload.text || payload?.message?.text || payload.msg || "";
    return typeof t === "string" ? t : JSON.stringify(t);
  }
  return String(payload || "");
}

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

  const rawMessage =
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

  const contactName =
    body?.senderName ||
    body?.pushName ||
    body?.contact?.name ||
    body?.data?.senderName ||
    body?.data?.pushName ||
    body?.data?.contact?.name ||
    "";

  // messageId (idempotência)
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

  // CAPTURA DO ID/TEXTO DO BOTÃO
  const bId =
    body?.buttonId ||
    body?.callback?.buttonId ||
    body?.data?.buttonId ||
    body?.message?.button?.id ||
    body?.message?.interactive?.button_reply?.id ||
    body?.message?.interactive?.list_reply?.id ||
    body?.message?.button_reply?.id ||
    body?.message?.buttonsResponseMessage?.selectedButtonId ||
    body?.message?.listResponseMessage?.singleSelectReply?.selectedRowId ||
    body?.listReply?.id ||
    body?.data?.listReply?.id ||
    null;

  const bTitle =
    body?.buttonTitle ||
    body?.callback?.buttonTitle ||
    body?.data?.buttonTitle ||
    body?.message?.button?.title ||
    body?.message?.interactive?.button_reply?.title ||
    body?.message?.interactive?.list_reply?.title ||
    body?.message?.button_reply?.title ||
    body?.message?.buttonsResponseMessage?.selectedDisplayText ||
    body?.message?.listResponseMessage?.title ||
    body?.listReply?.title ||
    null;

  const inbound = {
    phone: phone ? String(phone) : null,
    message: getIncomingText(rawMessage).trim(),
    imageUrl: imageUrl ? String(imageUrl) : null,
    imageMime: String(imageMime || "image/jpeg"),
    fromMe,
    contactName: String(contactName || "").trim(),
    messageId: messageId ? String(messageId) : null,

    buttonId: null,
    buttonTitle: null,
    messageType: "",
    raw: body,
  };

  if (bId || bTitle) {
    inbound.buttonId = bId ? String(bId) : null;
    inbound.buttonTitle = bTitle ? String(bTitle) : "";
    inbound.messageType = "button";
    inbound.message = inbound.buttonTitle || inbound.buttonId || inbound.message;
  }

  if (!inbound.messageType) inbound.messageType = inbound.imageUrl ? "image" : "text";
  return inbound;
}

// -------------------- Util --------------------
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
  if (n.length > 24) return n.slice(0, 24);
  if (/undefined|null|unknown/i.test(n)) return "";
  return n;
}

function detectColorIntent(text) {
  const t = norm(text);
  return /colorid|color|cores|vermelh|azul|amarel|verde|roxo|rosa|laranj|aquarel|new school/.test(t);
}

function askedPain(text) {
  const t = norm(text);
  return /doi|dor|vai doer|anestes|sensivel|aguenta/.test(t);
}

function askedAddress(text) {
  const t = norm(text);
  return /onde fica|endereco|localizacao|como chego|qual o endereco/.test(t);
}

function askedPix(text) {
  const t = norm(text);
  return /pix|chave pix|qual o pix|me passa o pix/.test(t);
}

// Rota 2: falar direto com o DW (texto)
function askedTalkToDw(text) {
  const t = norm(text);
  return /falar com voce|falar com vc|falar contigo|falar direto|quero falar com voce|quero falar com vc|me chama|me chame|pode me chamar|me responde voce|e voce mesmo|prefiro falar com voce|quero falar com o dw|falar com o dw/.test(
    t
  );
}

function parseSizeCm(text) {
  const t = norm(text);
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
  const t = norm(text);
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
    { match: /\bcostela\b/, label: "costela" },
    { match: /\bpescoco\b/, label: "pescoço" },
    { match: /\bmao\b/, label: "mão" },
    { match: /\bpunho\b/, label: "punho" },
    { match: /\bdedo\b/, label: "dedo" },
    { match: /\bpe\b/, label: "pé" },
    { match: /\btornozelo\b/, label: "tornozelo" },
    { match: /\bnuca\b/, label: "nuca" },
    { match: /\bescapula\b/, label: "escápula" },
  ];
  for (const p of parts) if (p.match.test(t)) return p.label;
  return null;
}

function calcHoursAndPrice(sizeCm, complexityLevel) {
  const s = Number(sizeCm || 0);
  const base = s <= 12 ? 1.2 : s <= 18 ? 2 : s <= 25 ? 3 : 4;

  const multiplier = complexityLevel === "alta" ? 1.5 : complexityLevel === "media" ? 1.2 : 1.0;

  const hours = Math.max(1, base * multiplier);

  const firstHour = ENV.HOUR_FIRST;
  const nextHours = Math.max(0, hours - 1) * ENV.HOUR_NEXT;
  const finalPrice = Math.round(firstHour + nextHours);

  return { hours, finalPrice };
}

function detectComplexityFromSummary(summary) {
  const t = norm(summary);
  if (t.includes("detalh")) return "alta";
  return "media";
}

// -------------------- Mensagens --------------------
function msgAddress() {
  return "Claro.\n\n• Endereço: *Av. Mauá, 1308* — próximo à rodoviária.";
}

function msgDorResposta() {
  return (
    "Entendo perfeitamente sua preocupação com a dor — é uma dúvida bem comum.\n" +
    "A sensação varia de pessoa pra pessoa e também depende da área.\n\n" +
    "A maioria descreve como um desconforto suportável (ardência/arranhão intenso), e eu trabalho num ritmo que minimiza isso, com pausas quando precisar.\n\n" +
    "Se você me disser a região, eu te falo como costuma ser nela."
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

function msgAskNewBudgetBasics() {
  return (
    "Fechou. Pra eu te passar um orçamento bem fiel, me manda:\n\n" +
    "• *referência em imagem* (print/foto)\n" +
    "• *onde no corpo* + *tamanho aproximado em cm*\n"
  );
}

function msgAskBodyAndSize() {
  return (
    "Me confirma só:\n\n" +
    "• onde no corpo\n" +
    "• tamanho aproximado em cm (ex: 10cm, 15cm, 18cm)\n"
  );
}

function msgAskChangeQuestion() {
  return "Você quer alterar algo na referência?";
}

function msgAskChangeDetails() {
  return "Fechou. Me descreve rapidinho o que você quer adicionar/remover/ajustar (pode mandar em tópicos).";
}

function msgAnalysisAndAsk(imageSummary) {
  return (
    "Recebi a referência!\n\n" +
    "Análise técnica:\n" +
    (imageSummary ? `${imageSummary}\n\n` : "") +
    msgAskBodyAndSize()
  );
}

function msgQuoteHours(hours, total) {
  const h = Number(hours || 1);
  return (
    "Eu trabalho com criação autoral e encaixe real no corpo, em *black & grey* com *whip shading*, pra ficar bonito hoje e envelhecer bem.\n\n" +
    `Pelo tamanho e complexidade do trabalho, o investimento fica em *R$ ${Number(total).toFixed(0)}*.\n` +
    `Estimativa profissional: cerca de *${h.toFixed(1)}h* de execução.\n\n` +
    "Formas de pagamento:\n" +
    "• Pix\n" +
    "• Débito\n" +
    "• Crédito em até 12x (+ acréscimo da máquina)\n\n" +
    "Se quiser, eu já te mando opções de datas e horários."
  );
}

function msgAskSchedule() {
  return "Você quer que eu te mande as próximas opções de datas e horários agora?";
}

function msgPixSinal() {
  const pixLine = ENV.PIX_KEY ? ENV.PIX_KEY : "SEU_PIX_AQUI";
  return (
    "Show! Para garantir seu horário, o sinal é de *R$ 50,00* (abatido do total no dia).\n\n" +
    "Chave Pix:\n" +
    `${pixLine}\n\n` +
    "Assim que fizer, me manda a *foto do comprovante* aqui no Whats ✅"
  );
}

// -------------------- Image analysis (OpenAI) --------------------
async function analyzeImageDetails(url) {
  if (!openai) return "";

  const resp = await openai.chat.completions.create({
    model: "gpt-4o",
    temperature: 0.2,
    messages: [
      { role: "system", content: BASE_SYSTEM },
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              "Analise a referência e descreva:\n" +
              "• Complexidade de sombras\n" +
              "• Contraste\n" +
              "• Volume e formas\n" +
              "• Detalhes finos\n" +
              "• Dificuldade técnica\n" +
              "• Áreas que exigem mais tempo\n" +
              "Escreva como tatuador profissional. Não cite preços.",
          },
          { type: "image_url", image_url: { url } },
        ],
      },
    ],
  });

  return resp.choices?.[0]?.message?.content?.trim() || "";
}

// -------------------- Sessions (persistente em JSON) --------------------
function newSession() {
  return {
    stage: "start",
    greeted: false,
    greetedAt: null,
    flowMode: null,
    awaitingFirstContact: false,
    firstContactChoiceAt: null,

    // data
    name: "",
    bodyPart: "",
    sizeCm: null,
    referenceImageUrl: "",
    imageSummary: "",
    changeNotes: "",

    // quote
    estHours: null,
    estTotal: null,

    // flags
    awaitingBWAnswer: false,

    // anti-repeat
    lastSentHash: null,
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

// -------------------- Anti-repeat (simple) --------------------
function hash(s) {
  return crypto.createHash("md5").update(String(s)).digest("hex");
}
function antiRepeat(session, text) {
  const h = hash(text);
  if (session.lastSentHash === h) return true;
  session.lastSentHash = h;
  scheduleSaveStore();
  return false;
}

// -------------------- Buttons helpers --------------------
async function sendFirstContactButtons(phone, session, contactName) {
  const nm = safeName(contactName);
  const greet = nm ? `Oi, ${nm}!` : "Oi!";
  const text = `${greet}\nMe diz como você quer seguir por aqui:`;

  const buttons = [
    { id: "first_new_budget", title: "Orçamento novo" },
    { id: "first_talk_dw", title: "Falar comigo" },
  ];

  await sendButtons(phone, text, buttons, "início");

  session.stage = "await_first_contact_buttons";
  session.greeted = true;
  session.greetedAt = Date.now();
  session.awaitingFirstContact = true;
  session.firstContactChoiceAt = Date.now();
  scheduleSaveStore();
}

async function askChangeButtons(phone, session) {
  const text = msgAskChangeQuestion();
  const buttons = [
    { id: "CHG_YES", title: "Sim" },
    { id: "CHG_NO", title: "Não" },
  ];

  await sendButtons(phone, text, buttons, "alteração");
  session.stage = "await_change_confirm";
  scheduleSaveStore();
}

async function askScheduleButtons(phone, session) {
  const text = msgAskSchedule();
  const buttons = [
    { id: "SCHED_YES", title: "Sim" },
    { id: "SCHED_NO", title: "Não" },
  ];

  await sendButtons(phone, text, buttons, "agenda");
  session.stage = "await_schedule_confirm";
  scheduleSaveStore();
}

// --------- decisões por texto do botão (quando não vem buttonId) ----------
function decideFirstContactFromText(message) {
  const t = norm(message);
  if (t.includes("orcamento novo") || t === "1") return 1;
  if (t.includes("falar comigo") || t.includes("falar com") || t === "2") return 2;
  return null;
}

function decideYesNoFromText(message) {
  const t = norm(message);
  if (t === "1" || /\bsim\b/.test(t)) return 1;
  if (t === "2" || /\bnao\b|\bnão\b/.test(t)) return 2;
  return null;
}

// -------------------- Core flow --------------------
async function handleInbound(phone, inbound) {
  const session = getSession(phone);

  const message = inbound.message || "";
  const lower = norm(message);
  const buttonId = inbound.buttonId || null;
  const hasImage = Boolean(inbound.imageUrl);
  const name = safeName(inbound.contactName);

  if (name && !session.name) {
    session.name = name;
    scheduleSaveStore();
  }

  console.log("[IN]", {
    phone,
    stage: session.stage,
    buttonId,
    hasImageUrl: !!inbound.imageUrl,
    preview: (message || "").slice(0, 120),
  });

  // Rota 2: cliente pede falar direto com você em qualquer momento
  if (askedTalkToDw(message)) {
    const reply = "Claro. Me diz o que você tem em mente e onde no corpo seria, que eu já te respondo.";
    if (!antiRepeat(session, reply)) await sendText(phone, reply);

    await notifyOwner(
      `📩 Cliente pediu pra falar direto com você: ${phone} (${session.name || "-"})\n` +
        `Stage: ${session.stage}\n` +
        `Msg: ${message.slice(0, 200)}`
    );

    session.stage = "talk_dw";
    scheduleSaveStore();
    return;
  }

  // comandos
  if (/^reset$|^reiniciar$|^comecar novamente$|^começar novamente$/.test(lower)) {
    resetSession(phone);
    const s2 = getSession(phone);
    const reply = "Atendimento reiniciado.\n\nMe manda a referência em imagem e me diz onde no corpo + tamanho em cm.";
    if (!antiRepeat(s2, reply)) await sendText(phone, reply);
    await sendFirstContactButtons(phone, s2, s2.name || "");
    return;
  }

  // address/pain quick intents
  if (askedAddress(message)) {
    const reply = msgAddress();
    if (!antiRepeat(session, reply)) await sendText(phone, reply);
    return;
  }
  if (askedPain(message)) {
    const reply = msgDorResposta();
    if (!antiRepeat(session, reply)) await sendText(phone, reply);
    return;
  }

  // color gating
  if (!session.awaitingBWAnswer && detectColorIntent(message)) {
    session.awaitingBWAnswer = true;
    scheduleSaveStore();
    const reply = msgSoBlackGrey();
    if (!antiRepeat(session, reply)) await sendText(phone, reply);
    return;
  }
  if (session.awaitingBWAnswer) {
    if (/\b(sim|aceito|pode|fechado|ok|bora)\b/.test(lower)) {
      session.awaitingBWAnswer = false;
      scheduleSaveStore();
    } else if (/\b(nao|não|quero colorido|prefiro colorido)\b/.test(lower)) {
      const reply =
        "Entendi.\n\nComo eu trabalho exclusivamente com *black & grey*, não vou conseguir te atender no colorido do jeito que você quer.\n\nSe decidir fazer em preto e cinza, é só me chamar.";
      if (!antiRepeat(session, reply)) await sendText(phone, reply);
      session.stage = "finalizado";
      scheduleSaveStore();
      return;
    } else {
      const reply = "Só confirma pra mim: você topa fazer em *preto e cinza*? (Sim/Não)";
      if (!antiRepeat(session, reply)) await sendText(phone, reply);
      return;
    }
  }

  const isFreshStart = !session.stage || session.stage === "start";
  if (isFreshStart) {
    await sendFirstContactButtons(phone, session, session.name || "");
    return;
  }

  // 1) awaiting first contact
  if (session.stage === "await_first_contact_buttons") {
    let choice = null;

    // via buttonId
    if (buttonId === "first_new_budget") choice = 1;
    if (buttonId === "first_talk_dw") choice = 2;

    // via texto do botão / fallback
    if (!choice) choice = decideFirstContactFromText(message);

    // 1) Orçamento novo (automático)
    if (choice === 1) {
      session.flowMode = "NEW_BUDGET";
      session.awaitingFirstContact = false;
      session.firstContactChoiceAt = Date.now();
      session.stage = "collect_reference";
      scheduleSaveStore();

      const reply = msgAskNewBudgetBasics();
      if (!antiRepeat(session, reply)) await sendText(phone, reply);
      return;
    }

    // 2) Falar comigo (alerta no seu pessoal)
    if (choice === 2) {
      session.flowMode = "TALK_DW";
      session.awaitingFirstContact = false;
      session.firstContactChoiceAt = Date.now();
      session.stage = "talk_dw";
      scheduleSaveStore();

      const reply = "Claro. Me diz o que você tem em mente e onde no corpo seria, que eu já te direciono certinho.";
      if (!antiRepeat(session, reply)) await sendText(phone, reply);

      await notifyOwner(`📩 Cliente pediu pra falar direto com você: ${phone} (${session.name || "-"})`);
      return;
    }

    const retry = "Só me confirma: *Orçamento novo* ou *Falar comigo*?";
    if (!antiRepeat(session, retry)) await sendText(phone, retry);
    return;
  }

  // 2) collect reference (need image)
  if (session.stage === "collect_reference") {
    if (!hasImage) {
      const reply = "Quando puder, me manda a *referência em imagem* (print/foto).";
      if (!antiRepeat(session, reply)) await sendText(phone, reply);
      return;
    }

    session.referenceImageUrl = inbound.imageUrl;
    session.stage = "collect_body_size";
    scheduleSaveStore();

    const summary = await analyzeImageDetails(inbound.imageUrl);
    session.imageSummary = summary;
    scheduleSaveStore();

    const msg = msgAnalysisAndAsk(summary);
    if (!antiRepeat(session, msg)) await sendText(phone, msg);
    return;
  }

  // 3) collect body + size
  if (session.stage === "collect_body_size") {
    const maybeBody = parseBodyPart(message);
    const maybeSize = parseSizeCm(message);

    if (maybeBody) session.bodyPart = maybeBody;
    if (maybeSize) session.sizeCm = maybeSize;

    if (hasImage) {
      session.referenceImageUrl = inbound.imageUrl;
      const summary = await analyzeImageDetails(inbound.imageUrl);
      session.imageSummary = summary;
    }
    scheduleSaveStore();

    if (!session.bodyPart || !session.sizeCm) {
      const reply = msgAskBodyAndSize();
      if (!antiRepeat(session, reply)) await sendText(phone, reply);
      return;
    }

    const complexity = detectComplexityFromSummary(session.imageSummary);
    const estimate = calcHoursAndPrice(session.sizeCm, complexity);
    session.estHours = estimate.hours;
    session.estTotal = estimate.finalPrice;

    const before = "Fechado. Vou montar seu orçamento com essas infos.";
    if (!antiRepeat(session, before)) await sendText(phone, before);

    await askChangeButtons(phone, session);
    return;
  }

  // 4) change confirm
  if (session.stage === "await_change_confirm") {
    let choice = null;
    if (buttonId === "CHG_YES") choice = 1;
    if (buttonId === "CHG_NO") choice = 2;
    if (!choice) choice = decideYesNoFromText(message);

    if (choice === 1) {
      session.stage = "collect_change_notes";
      scheduleSaveStore();
      const reply = msgAskChangeDetails();
      if (!antiRepeat(session, reply)) await sendText(phone, reply);
      return;
    }

    if (choice === 2) {
      session.changeNotes = "";
      session.stage = "send_quote";
      scheduleSaveStore();
    } else {
      const retry = "Só confirma: quer alterar algo? (Sim/Não)";
      if (!antiRepeat(session, retry)) await sendText(phone, retry);
      return;
    }
  }

  // 5) collect change notes
  if (session.stage === "collect_change_notes") {
    if (hasImage) {
      session.referenceImageUrl = inbound.imageUrl;
      const summary = await analyzeImageDetails(inbound.imageUrl);
      session.imageSummary = summary;
    }
    if (message) {
      session.changeNotes = (session.changeNotes ? session.changeNotes + "\n" : "") + message;
    }

    const complexity = detectComplexityFromSummary(session.imageSummary);
    const estimate = calcHoursAndPrice(session.sizeCm, complexity);
    session.estHours = estimate.hours;
    session.estTotal = estimate.finalPrice;
    scheduleSaveStore();

    const ack = "Anotado ✅ Vou considerar esses ajustes e já sigo pro orçamento.";
    if (!antiRepeat(session, ack)) await sendText(phone, ack);

    session.stage = "send_quote";
    scheduleSaveStore();
  }

  // 6) quote
  if (session.stage === "send_quote") {
    const quote = msgQuoteHours(session.estHours, session.estTotal);
    if (!antiRepeat(session, quote)) await sendText(phone, quote);

    await askScheduleButtons(phone, session);
    return;
  }

  // 7) schedule confirm
  if (session.stage === "await_schedule_confirm") {
    let choice = null;
    if (buttonId === "SCHED_YES") choice = 1;
    if (buttonId === "SCHED_NO") choice = 2;
    if (!choice) choice = decideYesNoFromText(message);

    if (choice === 1) {
      const reply = "Fechado ✅ Me manda sua preferência de dia/horário (ex: 15/01 16:00) que eu verifico e te confirmo.";
      if (!antiRepeat(session, reply)) await sendText(phone, reply);
      session.stage = "manual_schedule";
      scheduleSaveStore();

      await notifyOwner(
        `📅 Cliente quer agendar: ${phone} | peça: ${session.bodyPart} ${session.sizeCm}cm | ≈ ${session.estHours}h | R$ ${Number(
          session.estTotal
        ).toFixed(0)}`
      );
      return;
    }

    if (choice === 2) {
      const reply = "Tranquilo. Quando quiser seguir, é só me chamar aqui que eu te mando as opções de agenda.";
      if (!antiRepeat(session, reply)) await sendText(phone, reply);
      session.stage = "pos_orcamento";
      scheduleSaveStore();
      return;
    }

    const retry = "Só confirma: quer que eu mande opções de datas? (Sim/Não)";
    if (!antiRepeat(session, retry)) await sendText(phone, retry);
    return;
  }

  // 8) manual schedule -> pix
  if (session.stage === "manual_schedule") {
    if (/\b(confirmado|fechado|ok|beleza)\b/.test(lower)) {
      const pix = msgPixSinal();
      if (!antiRepeat(session, pix)) await sendText(phone, pix);
      session.stage = "await_receipt";
      scheduleSaveStore();
      return;
    }

    if (askedPix(message)) {
      const pix = msgPixSinal();
      if (!antiRepeat(session, pix)) await sendText(phone, pix);
      session.stage = "await_receipt";
      scheduleSaveStore();
      return;
    }

    const reply = "Perfeito. Me manda o dia/horário que você quer e eu confirmo o melhor disponível.";
    if (!antiRepeat(session, reply)) await sendText(phone, reply);
    return;
  }

  // 9) receipt
  if (session.stage === "await_receipt") {
    if (hasImage) {
      const reply =
        "Comprovante recebido ✅\n\n" +
        "Agendamento confirmado. Qualquer dúvida até o dia, é só me chamar.\n\n" +
        "Antes da sessão:\n" +
        "• Beba bastante água.\n" +
        "• Evite álcool no dia anterior.\n" +
        "• Se alimente bem antes de vir.\n" +
        "• Se puder, usar creme hidratante na região nos dias anteriores ajuda bastante.";
      if (!antiRepeat(session, reply)) await sendText(phone, reply);
      session.stage = "finalizado";
      scheduleSaveStore();
      await notifyOwner(`💸 Comprovante recebido: ${phone}`);
      return;
    }

    const reply = "Pra confirmar, preciso da *foto do comprovante* aqui no Whats ✅";
    if (!antiRepeat(session, reply)) await sendText(phone, reply);
    return;
  }

  // fallback
  const fallback =
    "Pra eu te atender certinho, me manda a *referência em imagem* e me diz *onde no corpo + tamanho em cm*.";
  if (!antiRepeat(session, fallback)) await sendText(phone, fallback);
}

// -------------------- Routes --------------------
app.get("/", (req, res) => res.status(200).send("OK"));
app.get("/health", (req, res) => {
  const miss = missingEnvs();
  res.status(miss.length ? 500 : 200).json({
    ok: miss.length === 0,
    missing: miss,
    hasOwner: Boolean(ENV.OWNER_PHONE),
    hasPix: Boolean(ENV.PIX_KEY),
    gcalEnabled: ENV.GCAL_ENABLED,
    storePath: ENV.STORE_PATH,
  });
});

// ✅ Webhook principal
app.post("/", async (req, res) => {
  res.status(200).json({ ok: true });

  try {
    const inbound = parseZapiInbound(req.body || {});
    if (!inbound.phone) return;
    if (inbound.fromMe) return;

    // Idempotência (reenvio do mesmo evento)
    if (inbound.messageId && wasProcessed(inbound.messageId)) return;
    if (inbound.messageId) markProcessed(inbound.messageId, inbound.phone);
    cleanupProcessed();

    await handleInbound(inbound.phone, inbound);
  } catch (e) {
    console.error("[WEBHOOK ERROR]", e?.message || e);
  }
});

// -------------------- Boot --------------------
async function boot() {
  await loadStore();
  cleanupProcessed();
  console.log("✅ Store carregado:", { sessions: Object.keys(STORE.sessions).length });

  app.listen(ENV.PORT, () => {
    const miss = missingEnvs();
    console.log("🚀 DW BOT ONLINE port", ENV.PORT);
    if (miss.length) console.log("⚠️ Missing ENV:", miss.join(", "));
  });
}

boot().catch((e) => {
  console.error("❌ BOOT ERROR", e?.message || e);
  process.exit(1);
});
