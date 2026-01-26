// ============================================================
// DW WhatsApp Bot — Jeezy Edition (RESET LIMPO + FUNÇÕES CHAVE)
// - Sem POLL/ENQUETE
// - Com BOTÕES (send buttons/list) via Z-API + fallback texto
// - Fluxo: Saudação -> Primeiro contato (buttons) -> Coleta ref -> local/tamanho
//        -> Análise imagem + descrição -> Pergunta alteração (buttons)
//        -> Orçamento -> Agenda -> Sinal -> Comprovante -> Confirma -> Cuidados
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
  ZAPI_BUTTONS_PATH: process.env.ZAPI_BUTTONS_PATH || "/send-buttons",
  ZAPI_LIST_PATH: process.env.ZAPI_LIST_PATH || "/send-list",

  OWNER_PHONE: process.env.OWNER_PHONE || process.env.TELEFONE_DO_PROPRIETÁRIO || "",
  PIX_KEY: process.env.PIX_KEY || "",

  // OpenAI
  OPENAI_API_KEY: process.env.OPENAI_API_KEY || "",

  // Google Calendar (opcional)
  GCAL_ENABLED:
    String(process.env.GCAL_ENABLED || process.env.GCAL_ATIVADO || "").toLowerCase() === "true" ||
    String(process.env.GCAL_ENABLED || process.env.GCAL_ATIVADO || "").toLowerCase() === "verdadeiro",
  GCAL_TZ: process.env.GCAL_TZ || "America/Sao_Paulo",
};

function missingEnvs() {
  const miss = [];
  if (!ENV.ZAPI_INSTANCE_ID) miss.push("ZAPI_INSTANCE_ID/ID_INSTÂNCIA_ZAPI");
  if (!ENV.ZAPI_INSTANCE_TOKEN) miss.push("ZAPI_INSTANCE_TOKEN");
  if (!ENV.ZAPI_CLIENT_TOKEN) miss.push("ZAPI_CLIENT_TOKEN");
  // OpenAI é opcional: sem ela o bot não analisa imagem com IA, mas continua respondendo.
  return miss;
}

// -------------------- OpenAI --------------------
const openai = ENV.OPENAI_API_KEY ? new OpenAI({ apiKey: ENV.OPENAI_API_KEY }) : null;

const BASE_SYSTEM =
  "Você é o DW Tattooer, tatuador profissional atendendo no WhatsApp (tom humano, direto e profissional). " +
  "Regras: Nunca diga que é IA. Não assine. Não fale de preço/hora. " +
  "Você trabalha com realismo preto e cinza (black & grey) + whip shading. " +
  "Antes de falar preço: explique rapidamente a complexidade (sombras, transições, volume, encaixe). " +
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

async function sendButtonsZapi(phone, text, buttons) {
  const buttonPayload = {
    phone,
    message: text,
    buttons: buttons.map((button) => ({ id: button.id, title: button.title })),
  };

  const listPayload = {
    phone,
    message: text,
    title: "Selecione uma opção",
    buttonText: "Escolher",
    sections: [
      {
        title: "Opções",
        rows: buttons.map((button) => ({
          id: button.id,
          title: button.title,
          description: "",
        })),
      },
    ],
  };

  const attempts = [
    { path: ENV.ZAPI_BUTTONS_PATH, payload: buttonPayload, label: "buttons" },
    { path: "/send-button-list", payload: listPayload, label: "button-list" },
    { path: ENV.ZAPI_LIST_PATH, payload: listPayload, label: "list" },
  ];

  for (const attempt of attempts) {
    try {
      const resp = await zapiFetch(attempt.path, attempt.payload);
      const respString = typeof resp === "string" ? resp : JSON.stringify(resp || {});
      if (/NOT_FOUND|error/i.test(respString)) {
        throw new Error(`ZAPI response indicates error: ${respString.slice(0, 240)}`);
      }
      const respPreview = respString.slice(0, 240);
      console.log("[ZAPI BUTTONS] success on", attempt.path, { phone, label: attempt.label, respPreview });
      return true;
    } catch (err) {
      console.error("[ZAPI BUTTONS] fail on", attempt.path, err?.message || err);
    }
  }

  return false;
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

  const bId =
    body?.buttonId ||
    body?.callback?.buttonId ||
    body?.data?.buttonId ||
    body?.message?.button?.id ||
    body?.message?.interactive?.button_reply?.id ||
    body?.message?.button_reply?.id ||
    body?.message?.buttonsResponseMessage?.selectedButtonId ||
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

  if (bId) {
    inbound.buttonId = String(bId);
    inbound.buttonTitle = bTitle ? String(bTitle) : "";
    inbound.messageType = "button";
    inbound.message = inbound.buttonTitle || inbound.buttonId;
  }

  if (!inbound.messageType) {
    inbound.messageType = inbound.imageUrl ? "image" : "text";
  }

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

function calcPriceFromSize(sizeCm, bodyPart, complexity = "medio") {
  // Base do seu JS (simplificado e estável)
  const base = 220;
  const perCm = 28;

  let price = base + sizeCm * perCm;

  const regionMultMap = {
    antebraço: 1.0,
    braço: 1.0,
    ombro: 1.05,
    perna: 1.05,
    coxa: 1.08,
    panturrilha: 1.08,
    peito: 1.15,
    costela: 1.18,
    costas: 1.22,
    pescoço: 1.12,
    mão: 1.12,
  };
  price *= regionMultMap[bodyPart] || 1.06;

  const compMap = { baixo: 0.98, medio: 1.06, alto: 1.14 };
  price *= compMap[complexity] || 1.06;

  // arredonda e limita
  price = Math.round(price / 10) * 10;
  price = Math.max(350, Math.min(2500, price));
  return price;
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
    "Perfeito. Me confirma só:\n\n" +
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

function msgBeforeQuoteSummary(sizeCm, bodyPart, imageSummary) {
  const lines = [];
  lines.push("Fechado. Pra eu te passar um valor bem fiel, eu considerei:");
  if (sizeCm) lines.push(`• Tamanho: ${sizeCm} cm`);
  if (bodyPart) lines.push(`• Local: ${bodyPart}`);
  if (imageSummary) lines.push(`• Detalhes: ${imageSummary}`);
  lines.push("Isso influencia direto no nível de sombra/detalhe e na execução pra cicatrizar bem.");
  return lines.join("\n");
}

function msgQuote(finalPrice) {
  return (
    `Pelo tamanho e complexidade do que você me enviou, o investimento fica em *R$ ${finalPrice}*.\n\n` +
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
async function describeImageShort(imageUrl) {
  if (!openai) return "";
  const resp = await openai.chat.completions.create({
    model: "gpt-4o",
    temperature: 0.25,
    messages: [
      { role: "system", content: BASE_SYSTEM },
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              "Analise a referência e gere 1-2 frases objetivas sobre complexidade (sombras, transições, volume, contraste). " +
              "Não fale de preço, não fale de horas.",
          },
          { type: "image_url", image_url: { url: imageUrl } },
        ],
      },
    ],
  });
  return resp.choices?.[0]?.message?.content?.trim() || "";
}

// -------------------- Sessions (in-memory) --------------------
const sessions = new Map();

function newSession() {
  return {
    stage: "start",
    greeted: false,
    greetedAt: null,
    flowMode: null,
    lastFirstContactButtonsAt: null,
    firstContactButtonsResent: false,

    // data
    name: "",
    bodyPart: "",
    sizeCm: null,
    referenceImageUrl: "",
    imageSummary: "",
    changeNotes: "",
    wantsChange: null,

    // quote
    lastPrice: null,

    // flags
    awaitingBWAnswer: false,
    awaitingFirstContact: false,
    awaitingChangeConfirm: false,
    awaitingScheduleConfirm: false,
    awaitingDeposit: false,
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
    { id: "first_new_budget", title: "Orçamento novo (do zero)" },
    { id: "first_continue_budget", title: "Continuar orçamento em andamento" },
  ];
  const sent = await sendButtonsZapi(phone, text, buttons);
  if (!sent) {
    await zapiSendText(
      phone,
      `${text}\n1) Orçamento novo (do zero)\n2) Continuar orçamento em andamento\nResponde 1 ou 2.`
    );
  }
  session.stage = "await_first_contact_buttons";
  session.awaitingFirstContact = true;
  session.greeted = true;
  session.greetedAt = Date.now();
  session.lastFirstContactButtonsAt = Date.now();
}

async function askChangeButtons(phone, session) {
  const text = msgAskChangeQuestion();
  const buttons = [
    { id: "CHG_YES", title: "Sim" },
    { id: "CHG_NO", title: "Não" },
  ];
  const sent = await sendButtonsZapi(phone, text, buttons);
  if (!sent) {
    await zapiSendText(phone, `${text}\n1) Sim\n2) Não\nResponde 1 ou 2.`);
  }
  session.awaitingChangeConfirm = true;
  session.stage = "await_change_confirm";
}

async function askScheduleButtons(phone, session) {
  const text = msgAskSchedule();
  const buttons = [
    { id: "SCHED_YES", title: "Sim" },
    { id: "SCHED_NO", title: "Não" },
  ];
  const sent = await sendButtonsZapi(phone, text, buttons);
  if (!sent) {
    await zapiSendText(phone, `${text}\n1) Sim\n2) Não\nResponde 1 ou 2.`);
  }
  session.awaitingScheduleConfirm = true;
  session.stage = "await_schedule_confirm";
}

function parseChoice12(text) {
  const t = norm(text);
  if (t === "1" || /\b1\b/.test(t)) return 1;
  if (t === "2" || /\b2\b/.test(t)) return 2;
  if (/\bsim\b/.test(t)) return 1;
  if (/\bnao\b|\bnão\b/.test(t)) return 2;
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

  console.log("[MERGED IN]", {
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
    return;
  }

  // address/pix quick intents
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
    // se aceitou black&grey
    if (/\b(sim|aceito|pode|fechado|ok|bora)\b/.test(lower)) {
      session.awaitingBWAnswer = false;
    } else if (/\b(nao|não|quero colorido|prefiro colorido)\b/.test(lower)) {
      const reply =
        "Entendi.\n\nComo eu trabalho exclusivamente com *black & grey*, não vou conseguir te atender no colorido do jeito que você quer.\n\nSe decidir fazer em preto e cinza, é só me chamar.";
      if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
      session.stage = "finalizado";
      return;
    } else {
      // ainda aguardando resposta clara
      const reply = "Só confirma pra mim: você topa fazer em *preto e cinza*? (Sim/Não)";
      if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
      return;
    }
  }

  const isFreshStart = session.stage === "start" || session.stage === "inicio";
  const greetCooldownMs = 10 * 60 * 1000;
  const inGreetCooldown =
    session.greeted && session.greetedAt && Date.now() - session.greetedAt < greetCooldownMs;

  if (isFreshStart) {
    if (inGreetCooldown) {
      const reply = "Me responde 1 ou 2 pra eu te direcionar certinho.";
      if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
      return;
    }
    await sendFirstContactButtons(phone, session, session.name || "");
    return;
  }

  // 2) awaiting first contact
  if (session.stage === "await_first_contact_buttons") {
    let choice = null;

    if (buttonId === "first_new_budget") choice = 1;
    if (buttonId === "first_continue_budget") choice = 2;

    if (!choice) choice = parseChoice12(message);
    if (!choice) {
      if (/(orcamento|orçamento|fazer um orçamento|novo)/.test(lower)) choice = 1;
      if (/(andamento|continuar|ja tenho|já tenho)/.test(lower)) choice = 2;
    }

    if (choice === 1) {
      session.flowMode = "NEW_BUDGET";
      session.awaitingFirstContact = false;
      session.stage = "collect_reference";
      const reply = msgAskNewBudgetBasics();
      if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
      return;
    }

    if (choice === 2) {
      session.flowMode = "IN_PROGRESS";
      session.awaitingFirstContact = false;
      session.stage = "manual_continue";
      await handoffToManual(phone, session, "cliente com orçamento em andamento", message);
      return;
    }

    if (!buttonId && !inGreetCooldown) {
      const cooldownMs = 15000;
      const canResend =
        !session.firstContactButtonsResent &&
        (!session.lastFirstContactButtonsAt || Date.now() - session.lastFirstContactButtonsAt > cooldownMs);
      if (canResend) {
        session.firstContactButtonsResent = true;
        await sendFirstContactButtons(phone, session, session.name || "");
        return;
      }
    }
    const retry =
      "Só pra eu te direcionar certinho: é orçamento novo (1) ou em andamento (2)?";
    if (!antiRepeat(session, retry)) await zapiSendText(phone, retry);
    return;
  }

  // 3) collect reference (need image)
  if (session.stage === "collect_reference") {
    if (!hasImage) {
      const reply = "Quando puder, me manda a *referência em imagem* (print/foto).";
      if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
      return;
    }

    session.referenceImageUrl = inbound.imageUrl;
    session.stage = "collect_body_size";

    // IA: resumo curto
    const sum = await describeImageShort(inbound.imageUrl);
    session.imageSummary = sum;

    if (sum) {
      const msg = "Recebi a referência.\n\nPra esse projeto ficar bem executado, ele exige:\n\n" + sum;
      if (!antiRepeat(session, msg)) await zapiSendText(phone, msg);
    } else {
      const msg = "Recebi a referência ✅";
      if (!antiRepeat(session, msg)) await zapiSendText(phone, msg);
    }

    const ask = msgAskBodyAndSize();
    if (!antiRepeat(session, ask)) await zapiSendText(phone, ask);
    return;
  }

  // 4) collect body + size
  if (session.stage === "collect_body_size") {
    const maybeBody = parseBodyPart(message);
    const maybeSize = parseSizeCm(message);

    if (maybeBody) session.bodyPart = maybeBody;
    if (maybeSize) session.sizeCm = maybeSize;

    // se mandou imagem de novo, atualiza referência
    if (hasImage) {
      session.referenceImageUrl = inbound.imageUrl;
      const sum = await describeImageShort(inbound.imageUrl);
      session.imageSummary = sum;
    }

    if (!session.bodyPart || !session.sizeCm) {
      const reply = msgAskBodyAndSize();
      if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
      return;
    }

    // pronto -> perguntar alteração (buttons)
    session.stage = "await_change_confirm";
    const before = msgBeforeQuoteSummary(session.sizeCm, session.bodyPart, session.imageSummary);
    if (!antiRepeat(session, before)) await zapiSendText(phone, before);
    await askChangeButtons(phone, session);
    return;
  }

  // 5) change confirm
  if (session.stage === "await_change_confirm") {
    let choice = null;
    if (buttonId === "CHG_YES") choice = 1;
    if (buttonId === "CHG_NO") choice = 2;
    if (!choice) choice = parseChoice12(message);

    if (choice === 1) {
      session.stage = "collect_change_notes";
      const reply = msgAskChangeDetails();
      if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
      return;
    }

    if (choice === 2) {
      session.changeNotes = "";
      session.stage = "send_quote";
      // cai para orçamento
    } else {
      const retry = "Só confirma: quer alterar algo? (1=Sim / 2=Não)";
      if (!antiRepeat(session, retry)) await zapiSendText(phone, retry);
      return;
    }
  }

  // 6) collect change notes
  if (session.stage === "collect_change_notes") {
    if (hasImage) {
      // referência adicional
      session.referenceImageUrl = inbound.imageUrl;
    }
    if (message) {
      session.changeNotes = (session.changeNotes ? session.changeNotes + "\n" : "") + message;
    }
    const ack = "Anotado ✅ Vou considerar esses ajustes e já sigo pro orçamento.";
    if (!antiRepeat(session, ack)) await zapiSendText(phone, ack);
    session.stage = "send_quote";
    // cai para orçamento
  }

  // 7) quote
  if (session.stage === "send_quote") {
    const complexity = session.imageSummary && session.imageSummary.length > 0 ? "medio" : "medio";
    const price = calcPriceFromSize(session.sizeCm, session.bodyPart, complexity);
    session.lastPrice = price;

    const quote = msgQuote(price);
    if (!antiRepeat(session, quote)) await zapiSendText(phone, quote);

    await askScheduleButtons(phone, session);
    return;
  }

  // 8) schedule confirm
  if (session.stage === "await_schedule_confirm") {
    let choice = null;
    if (buttonId === "SCHED_YES") choice = 1;
    if (buttonId === "SCHED_NO") choice = 2;
    if (!choice) choice = parseChoice12(message);

    if (choice === 1) {
      // Aqui você já tinha a lógica avançada no seu JS antigo. Mantemos simples e fazemos handoff
      const reply = "Fechado ✅ Me manda sua preferência de dia/horário (ex: 15/01 16:00) que eu verifico e te confirmo.";
      if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
      session.stage = "manual_schedule";
      await notifyOwner(`📅 Cliente quer agendar: ${phone} | peça: ${session.bodyPart} ${session.sizeCm}cm | R$ ${session.lastPrice}`);
      return;
    }

    if (choice === 2) {
      const reply = "Tranquilo. Quando quiser seguir, é só me chamar aqui que eu te mando as opções de agenda.";
      if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
      session.stage = "pos_orcamento";
      return;
    }

    const retry = "Só confirma: quer que eu mande opções de datas? (1=Sim / 2=Não)";
    if (!antiRepeat(session, retry)) await zapiSendText(phone, retry);
    return;
  }

  // 9) manual schedule -> pix
  if (session.stage === "manual_schedule") {
    // Quando você confirmar manualmente o slot, você manda "confirmado" e o bot manda pix.
    if (/\b(confirmado|fechado|ok|beleza)\b/.test(lower)) {
      const pix = msgPixSinal();
      if (!antiRepeat(session, pix)) await zapiSendText(phone, pix);
      session.stage = "await_receipt";
      return;
    }

    // se o cliente pedir pix direto aqui
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

  // 10) receipt
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

// ✅ Webhook principal (use "/" como no seu código antigo)
app.post("/", async (req, res) => {
  // responde 200 IMEDIATO pra Z-API não re-tentar e não travar
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
