// ============================================================
// DW WhatsApp Bot — Jeezy Edition (RESET LIMPO + FUNÇÕES CHAVE)
// FIXES:
// 1) BOTÕES: usa /send-button (botões reais) + fallback texto (sem LIST quebrada)
// 2) CAPTURA DO CLIQUE: aceita buttonId OU texto do botão ("orçamento novo", "já tenho orçamento")
// 3) SEM REPETIÇÃO: ao receber imagem, manda 1 mensagem só (análise + pedir local/tamanho)
// 4) ORÇAMENTO POR HORAS: 1ª hora R$130, demais R$120 (estimativa por tamanho + complexidade)
// ============================================================

import express from "express";
import crypto from "crypto";
import OpenAI from "openai";

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

  // Preço por hora (regra nova)
  HOUR_FIRST: Number(process.env.HOUR_FIRST || 130),
  HOUR_NEXT: Number(process.env.HOUR_NEXT || 120),
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

/**
 * BOTÕES REAIS (compatível) — endpoint /send-button
 * IMPORTANTE: alguns aparelhos NÃO renderizam LIST (setinhas vazias).
 * Botão real funciona bem mais estável.
 */
async function sendButtonsZapi(phone, text, buttons) {
  try {
    const resp = await zapiFetch("/send-button", {
      phone,
      message: text,
      buttons: buttons.map((b) => ({
        id: b.id,
        label: b.title, // <- Z-API costuma usar "label" neste endpoint
      })),
    });

    console.log("[ZAPI BUTTON OK]", { phone, respPreview: JSON.stringify(resp).slice(0, 240) });
    return true;
  } catch (err) {
    console.error("[ZAPI BUTTON FAIL]", err?.message || err);

    // fallback texto
    await zapiSendText(
      phone,
      `${text}\n\n` +
        buttons.map((b, i) => `${i + 1}) ${b.title}`).join("\n") +
        "\n\nResponde o número."
    );
    return false;
  }
}

async function notifyOwner(text) {
  if (!ENV.OWNER_PHONE) return;
  try {
    await zapiSendText(ENV.OWNER_PHONE, text);
  } catch {}
}

async function handoffToManual(phone, session, reason, lastMessage) {
  const reply = msgAskContinueBudget();
  if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
  await notifyOwner(`📌 Handoff manual (${reason}): ${phone} | msg: ${lastMessage || "-"}`);
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

  // CAPTURA DO ID/TEXTO DO BOTÃO (vários formatos possíveis)
  const bId =
    body?.buttonId ||
    body?.callback?.buttonId ||
    body?.data?.buttonId ||
    body?.message?.button?.id ||
    body?.message?.interactive?.button_reply?.id ||
    body?.message?.button_reply?.id ||
    body?.message?.buttonsResponseMessage?.selectedButtonId ||
    body?.data?.listReply?.id ||
    body?.data?.selectedButtonId ||
    body?.messages?.[0]?.button?.payload ||
    null;

  const bTitle =
    body?.buttonTitle ||
    body?.callback?.buttonTitle ||
    body?.data?.buttonTitle ||
    body?.message?.button?.title ||
    body?.message?.interactive?.button_reply?.title ||
    body?.message?.button_reply?.title ||
    body?.message?.buttonsResponseMessage?.selectedDisplayText ||
    body?.data?.listReply?.title ||
    body?.data?.selectedDisplayText ||
    null;

  const inbound = {
    phone: phone ? String(phone) : null,
    message: getIncomingText(rawMessage).trim(),
    imageUrl: imageUrl ? String(imageUrl) : null,
    imageMime: String(imageMime || "image/jpeg"),
    fromMe,
    contactName: String(contactName || "").trim(),
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

// ---- ORÇAMENTO POR HORAS ----
function estimateComplexityTier(imageMeta) {
  // imageMeta: {tier:"baixo|medio|alto"} quando vier da IA
  if (!imageMeta) return "medio";
  const t = norm(imageMeta.tier || "");
  if (t.includes("baixo")) return "baixo";
  if (t.includes("alto")) return "alto";
  return "medio";
}

function estimateHours(sizeCm, tier, bodyPart) {
  const s = Number(sizeCm || 0);

  // base por tamanho
  let hours =
    s <= 6 ? 1.0 :
    s <= 10 ? 1.5 :
    s <= 14 ? 2.5 :
    s <= 18 ? 3.5 :
    s <= 22 ? 4.5 :
    s <= 28 ? 6.0 :
    s <= 35 ? 8.0 :
    10.0;

  // ajuste por complexidade
  const mult = tier === "baixo" ? 0.9 : tier === "alto" ? 1.25 : 1.05;
  hours *= mult;

  // ajuste por área (um pouco)
  const bp = bodyPart || "";
  if (["costela", "pescoço", "mão"].includes(bp)) hours *= 1.12;
  if (["costas", "peito"].includes(bp)) hours *= 1.10;

  // arredonda em 0.5h
  hours = Math.round(hours * 2) / 2;
  hours = Math.max(1, hours);
  return hours;
}

function calcTotalFromHours(hours) {
  const h = Number(hours || 1);
  if (h <= 1) return ENV.HOUR_FIRST;
  const rest = h - 1;
  return ENV.HOUR_FIRST + rest * ENV.HOUR_NEXT;
}

// -------------------- Mensagens --------------------
function msgSaudacaoPrimeiroContato(name) {
  const nm = safeName(name);
  const greet = nm ? `Oi, ${nm}!` : "Oi!";
  return `${greet} Aqui é o DW Tattooer — especialista em realismo preto e cinza e whip shading.\n\nPra eu te direcionar certinho, escolhe uma opção abaixo:`;
}

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
    "Show. Pra eu te passar um orçamento bem fiel, me manda:\n\n" +
    "• *referência em imagem* (print/foto)\n" +
    "• *onde no corpo* + *tamanho aproximado em cm*\n"
  );
}

function msgAskContinueBudget() {
  return (
    "Fechado. Como você já tem um orçamento em andamento, me manda uma mensagem com:\n\n" +
    "• o que já foi combinado\n" +
    "• e a última referência\n\n" +
    "que eu continuo daqui."
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

function msgAnalysisAndAsk(imageSummary, tier) {
  const tierLabel = tier === "alto" ? "ALTA" : tier === "baixo" ? "BAIXA" : "MÉDIA";
  return (
    "Recebi a referência ✅\n\n" +
    "Análise técnica (pra você entender o nível do trampo):\n" +
    (imageSummary ? `• ${imageSummary}\n` : "") +
    `• Complexidade estimada: *${tierLabel}*\n\n` +
    msgAskBodyAndSize()
  );
}

function msgBeforeQuoteHours(sizeCm, bodyPart, tier, hours) {
  const tierLabel = tier === "alto" ? "ALTA" : tier === "baixo" ? "BAIXA" : "MÉDIA";
  return (
    "Fechado. Considerando:\n" +
    `• Local: ${bodyPart}\n` +
    `• Tamanho: ${sizeCm} cm\n` +
    `• Complexidade: ${tierLabel}\n\n` +
    `Estimativa de execução: *${hours}h*`
  );
}

function msgQuoteHours(hours, total) {
  const h = Number(hours || 1);
  const first = ENV.HOUR_FIRST;
  const next = ENV.HOUR_NEXT;

  let breakdown = `• 1ª hora: R$ ${first.toFixed(0)}\n`;
  if (h > 1) breakdown += `• Demais horas: R$ ${next.toFixed(0)} / hora\n`;

  return (
    `Orçamento estimado:\n\n` +
    `${breakdown}\n` +
    `Total estimado: *R$ ${Number(total).toFixed(0)}* (≈ ${h}h)\n\n` +
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
/**
 * Retorna:
 * { summary: "texto curto", tier: "baixo|medio|alto" }
 */
async function describeImageMeta(imageUrl) {
  if (!openai) return { summary: "", tier: "medio" };

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
              "Analise a referência e responda APENAS em JSON válido, sem texto fora do JSON, no formato:\n" +
              '{ "summary": "1 frase objetiva sobre sombras/transições/volume/contraste", "tier": "baixo|medio|alto" }\n' +
              "Não fale de preço, não fale de horas.",
          },
          { type: "image_url", image_url: { url: imageUrl } },
        ],
      },
    ],
  });

  const raw = resp.choices?.[0]?.message?.content?.trim() || "";
  try {
    const json = JSON.parse(raw);
    const summary = String(json.summary || "").trim();
    const tier = String(json.tier || "medio").trim().toLowerCase();
    return {
      summary: summary.length > 0 ? summary : "",
      tier: ["baixo", "medio", "alto"].includes(tier) ? tier : "medio",
    };
  } catch {
    // fallback se não vier JSON perfeito
    return { summary: raw.slice(0, 200), tier: "medio" };
  }
}

// -------------------- Sessions (in-memory) --------------------
const sessions = new Map();

function newSession() {
  return {
    stage: "start",
    greeted: false,
    greetedAt: null,
    flowMode: null,

    // data
    name: "",
    bodyPart: "",
    sizeCm: null,
    referenceImageUrl: "",
    imageMeta: { summary: "", tier: "medio" },
    changeNotes: "",

    // quote
    estHours: null,
    estTotal: null,

    // flags
    awaitingBWAnswer: false,
  };
}

function getSession(phone) {
  if (!sessions.has(phone)) sessions.set(phone, newSession());
  return sessions.get(phone);
}

function resetSession(phone) {
  sessions.set(phone, newSession());
}

// -------------------- Anti-repeat (simple) --------------------
function hash(s) {
  return crypto.createHash("md5").update(String(s)).digest("hex");
}
function antiRepeat(session, text) {
  const h = hash(text);
  if (session.lastSentHash === h) return true;
  session.lastSentHash = h;
  return false;
}

// -------------------- Buttons helpers --------------------
async function sendFirstContactButtons(phone, session, contactName) {
  const text = msgSaudacaoPrimeiroContato(contactName);
  const buttons = [
    { id: "first_new_budget", title: "Orçamento novo" },
    { id: "first_continue_budget", title: "Já tenho orçamento" },
  ];

  await sendButtonsZapi(phone, text, buttons);

  session.stage = "await_first_contact_buttons";
  session.greeted = true;
  session.greetedAt = Date.now();
}

async function askChangeButtons(phone, session) {
  const text = msgAskChangeQuestion();
  const buttons = [
    { id: "CHG_YES", title: "Sim" },
    { id: "CHG_NO", title: "Não" },
  ];

  await sendButtonsZapi(phone, text, buttons);
  session.stage = "await_change_confirm";
}

async function askScheduleButtons(phone, session) {
  const text = msgAskSchedule();
  const buttons = [
    { id: "SCHED_YES", title: "Sim" },
    { id: "SCHED_NO", title: "Não" },
  ];

  await sendButtonsZapi(phone, text, buttons);
  session.stage = "await_schedule_confirm";
}

// --------- decisões por texto do botão (quando não vem buttonId) ----------
function decideFirstContactFromText(message) {
  const t = norm(message);
  if (t.includes("orcamento novo") || t.includes("orçamento novo") || t === "1") return 1;
  if (t.includes("ja tenho") || t.includes("já tenho") || t.includes("em andamento") || t === "2") return 2;
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

  if (name && !session.name) session.name = name;

  console.log("[IN]", {
    phone,
    stage: session.stage,
    buttonId,
    hasImageUrl: !!inbound.imageUrl,
    preview: (message || "").slice(0, 120),
  });

  // comandos
  if (/^reset$|^reiniciar$|^comecar novamente$|^começar novamente$/.test(lower)) {
    resetSession(phone);
    const s2 = getSession(phone);
    const reply = "Atendimento reiniciado.\n\nMe manda a referência em imagem e me diz onde no corpo + tamanho em cm.";
    if (!antiRepeat(s2, reply)) await zapiSendText(phone, reply);
    // após reset, já manda botões de primeiro contato (pra não ficar solto)
    await sendFirstContactButtons(phone, s2, s2.name || "");
    return;
  }

  // address/pain quick intents
  if (askedAddress(message)) {
    const reply = msgAddress();
    if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
    return;
  }
  if (askedPain(message)) {
    const reply = msgDorResposta();
    if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
    return;
  }

  // color gating
  if (!session.awaitingBWAnswer && detectColorIntent(message)) {
    session.awaitingBWAnswer = true;
    const reply = msgSoBlackGrey();
    if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
    return;
  }
  if (session.awaitingBWAnswer) {
    if (/\b(sim|aceito|pode|fechado|ok|bora)\b/.test(lower)) {
      session.awaitingBWAnswer = false;
    } else if (/\b(nao|não|quero colorido|prefiro colorido)\b/.test(lower)) {
      const reply =
        "Entendi.\n\nComo eu trabalho exclusivamente com *black & grey*, não vou conseguir te atender no colorido do jeito que você quer.\n\nSe decidir fazer em preto e cinza, é só me chamar.";
      if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
      session.stage = "finalizado";
      return;
    } else {
      const reply = "Só confirma pra mim: você topa fazer em *preto e cinza*? (Sim/Não)";
      if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
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
    if (buttonId === "first_continue_budget") choice = 2;

    // via texto do botão (quando o Whats manda só texto)
    if (!choice) choice = decideFirstContactFromText(message);

    if (choice === 1) {
      session.flowMode = "NEW_BUDGET";
      session.stage = "collect_reference";
      const reply = msgAskNewBudgetBasics();
      if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
      return;
    }

    if (choice === 2) {
      session.flowMode = "IN_PROGRESS";
      session.stage = "manual_continue";
      await handoffToManual(phone, session, "cliente com orçamento em andamento", message);
      return;
    }

    const retry = "Só pra eu te direcionar certinho: *Orçamento novo* ou *Já tenho orçamento*?";
    if (!antiRepeat(session, retry)) await zapiSendText(phone, retry);
    return;
  }

  // 2) collect reference (need image)
  if (session.stage === "collect_reference") {
    if (!hasImage) {
      const reply = "Quando puder, me manda a *referência em imagem* (print/foto).";
      if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
      return;
    }

    session.referenceImageUrl = inbound.imageUrl;
    session.stage = "collect_body_size";

    // IA: resumo + tier (sem repetir mensagens)
    const meta = await describeImageMeta(inbound.imageUrl);
    session.imageMeta = meta;

    const tier = estimateComplexityTier(meta);
    const msg = msgAnalysisAndAsk(meta.summary, tier);
    if (!antiRepeat(session, msg)) await zapiSendText(phone, msg);
    return;
  }

  // 3) collect body + size
  if (session.stage === "collect_body_size") {
    const maybeBody = parseBodyPart(message);
    const maybeSize = parseSizeCm(message);

    if (maybeBody) session.bodyPart = maybeBody;
    if (maybeSize) session.sizeCm = maybeSize;

    // se mandou imagem de novo, atualiza referência + meta
    if (hasImage) {
      session.referenceImageUrl = inbound.imageUrl;
      const meta = await describeImageMeta(inbound.imageUrl);
      session.imageMeta = meta;
    }

    if (!session.bodyPart || !session.sizeCm) {
      const reply = msgAskBodyAndSize();
      if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
      return;
    }

    // pronto -> pergunta alteração (buttons)
    const tier = estimateComplexityTier(session.imageMeta);
    session.estHours = estimateHours(session.sizeCm, tier, session.bodyPart);
    session.estTotal = calcTotalFromHours(session.estHours);

    const before = msgBeforeQuoteHours(session.sizeCm, session.bodyPart, tier, session.estHours);
    if (!antiRepeat(session, before)) await zapiSendText(phone, before);

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
      const reply = msgAskChangeDetails();
      if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
      return;
    }

    if (choice === 2) {
      session.changeNotes = "";
      session.stage = "send_quote";
    } else {
      const retry = "Só confirma: quer alterar algo? (Sim/Não)";
      if (!antiRepeat(session, retry)) await zapiSendText(phone, retry);
      return;
    }
  }

  // 5) collect change notes
  if (session.stage === "collect_change_notes") {
    if (hasImage) {
      session.referenceImageUrl = inbound.imageUrl;
      const meta = await describeImageMeta(inbound.imageUrl);
      session.imageMeta = meta;
    }
    if (message) {
      session.changeNotes = (session.changeNotes ? session.changeNotes + "\n" : "") + message;
    }

    // re-estima com base na nova referência/complexidade
    const tier = estimateComplexityTier(session.imageMeta);
    session.estHours = estimateHours(session.sizeCm, tier, session.bodyPart);
    session.estTotal = calcTotalFromHours(session.estHours);

    const ack = "Anotado ✅ Vou considerar esses ajustes e já sigo pro orçamento.";
    if (!antiRepeat(session, ack)) await zapiSendText(phone, ack);

    session.stage = "send_quote";
  }

  // 6) quote
  if (session.stage === "send_quote") {
    const quote = msgQuoteHours(session.estHours, session.estTotal);
    if (!antiRepeat(session, quote)) await zapiSendText(phone, quote);

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
      if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
      session.stage = "manual_schedule";
      await notifyOwner(
        `📅 Cliente quer agendar: ${phone} | peça: ${session.bodyPart} ${session.sizeCm}cm | ≈ ${session.estHours}h | R$ ${Number(
          session.estTotal
        ).toFixed(0)}`
      );
      return;
    }

    if (choice === 2) {
      const reply = "Tranquilo. Quando quiser seguir, é só me chamar aqui que eu te mando as opções de agenda.";
      if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
      session.stage = "pos_orcamento";
      return;
    }

    const retry = "Só confirma: quer que eu mande opções de datas? (Sim/Não)";
    if (!antiRepeat(session, retry)) await zapiSendText(phone, retry);
    return;
  }

  // 8) manual schedule -> pix
  if (session.stage === "manual_schedule") {
    if (/\b(confirmado|fechado|ok|beleza)\b/.test(lower)) {
      const pix = msgPixSinal();
      if (!antiRepeat(session, pix)) await zapiSendText(phone, pix);
      session.stage = "await_receipt";
      return;
    }

    if (askedPix(message)) {
      const pix = msgPixSinal();
      if (!antiRepeat(session, pix)) await zapiSendText(phone, pix);
      session.stage = "await_receipt";
      return;
    }

    const reply = "Perfeito. Me manda o dia/horário que você quer e eu confirmo o melhor disponível.";
    if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
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
      if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
      session.stage = "finalizado";
      await notifyOwner(`💸 Comprovante recebido: ${phone}`);
      return;
    }

    const reply = "Pra confirmar, preciso da *foto do comprovante* aqui no Whats ✅";
    if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
    return;
  }

  // fallback
  const fallback =
    "Pra eu te atender certinho, me manda a *referência em imagem* e me diz *onde no corpo + tamanho em cm*.";
  if (!antiRepeat(session, fallback)) await zapiSendText(phone, fallback);
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
  });
});

// ✅ Webhook principal
app.post("/", async (req, res) => {
  // responde 200 IMEDIATO
  res.status(200).json({ ok: true });

  try {
    const inbound = parseZapiInbound(req.body || {});
    if (!inbound.phone) return;
    if (inbound.fromMe) return;

    await handleInbound(inbound.phone, inbound);
  } catch (e) {
    console.error("[WEBHOOK ERROR]", e?.message || e);
  }
});

app.listen(ENV.PORT, () => {
  const miss = missingEnvs();
  console.log("🚀 DW BOT ONLINE port", ENV.PORT);
  if (miss.length) console.log("⚠️ Missing ENV:", miss.join(", "));
});
