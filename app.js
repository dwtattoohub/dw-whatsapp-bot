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

const app = express();
app.use(express.json({ limit: "25mb" }));

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
      manualHandoff: false,

      // controle
      awaitingBWAnswer: false,
      finished: false,
      lastOwnerNotifyAt: 0,

      // prazo comprovante (12h)
      depositDeadlineAt: 0, // timestamp (ms)
      sentDepositDeadlineInfo: false, // falou das 12h pelo menos 1x (no orçamento)
      waitingReceipt: false, // cliente disse "já já mando"

      // anti spam/loop
      lastReply: null,
      lastReplyAt: 0,
    };
  }
  return sessions[phone];
}

function resetSession(phone) {
  delete sessions[phone];
}

function antiRepeat(session, reply) {
  const now = Date.now();
  if (session.lastReply === reply && now - session.lastReplyAt < 90_000) return true;
  session.lastReply = reply;
  session.lastReplyAt = now;
  return false;
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
    `Olá${name ? `, ${name}` : ""}! Aqui é o DW Tatuador, especializado em realismo preto e cinza e whip shading.\n\n` +
    `Fico feliz em receber sua mensagem!\n\n` +
    `Pra eu te atender do jeito certo: você já tem um orçamento/atendimento em andamento comigo ou é o primeiro contato?`,
  (name) =>
    `Oi${name ? `, ${name}` : ""}! Aqui é o DW Tatuador — realismo preto e cinza e whip shading.\n\n` +
    `Pra eu te orientar certinho: você já está com orçamento em andamento comigo ou é a primeira vez por aqui?`,
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
    "mão","mao","dedo","punho","antebraço","antebraco","braço","braco",
    "ombro","peito","costela","pescoço","pescoco","nuca",
    "pé","pe","tornozelo","panturrilha","canela",
    "coxa","joelho","virilha",
    "costas","escápula","escapula","coluna",
    "rosto","cabeça","cabeca",
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
  if (/\b(n[aã]o|nao|prefiro\s*color|quero\s*color|n[aã]o\s*quero\s*preto|nao\s*quero\s*preto)\b/i.test(t)) return "no";
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
  return /pr[oó]xim[ao]\s*(hor[aá]rio|data)\s*(livre|dispon[ií]vel)|qualquer\s*data|pr[oó]xima\s*data|pode\s*marcar\s*no\s*pr[oó]ximo|o\s*que\s*voc[eê]\s*tiver/i.test(t);
}

function detectHasSpecificDate(text) {
  const t = (text || "").toLowerCase();
  return /(\d{1,2}\/\d{1,2})|(\d{1,2}\-\d{1,2})|dia\s*\d{1,2}|(segunda|ter[cç]a|quarta|quinta|sexta|s[aá]bado|domingo)/i.test(t);
}

// comprovante confirmado só com FOTO (imageUrl) após orçamento
function detectDepositTextOnly(text) {
  const t = (text || "").toLowerCase();
  return /comprovante|pix\s*feito|pix\s*realizado|paguei|pago|transferi|transferência|transferencia|sinal|enviei\s*o\s*pix|mandei\s*o\s*pix|caiu\s*o\s*pix|confirmad/i.test(t);
}

function detectWillSendReceipt(text) {
  const t = (text || "").toLowerCase();
  return (
    /(ja\s*ja|já\s*já|logo|daqui\s*a\s*pouco|vou\s*mandar|já\s*vou\s*mandar|vou\s*enviar|ja\s*envio|já\s*envio|assim\s*que\s*eu\s*fizer|assim\s*que\s*eu\s*conseguir|to\s*fazendo|tô\s*fazendo)/i.test(t) &&
    /(comprovante|pix|sinal|transfer|pagamento)/i.test(t)
  );
}

function detectReceiptContext(session, message) {
  // evita o bot tentar analisar comprovante como "referência"
  const t = (message || "").toLowerCase();
  if (session.stage === "pos_orcamento" || session.sentQuote) return true;
  if (session.depositDeadlineAt && session.depositDeadlineAt > 0) return true;
  if (/comprovante|pix|sinal|pagamento|transfer/i.test(t)) return true;
  return false;
}

// -------------------- PRIMEIRO CONTATO (gate) --------------------
function detectFirstContactAnswer(text) {
  const t = (text || "").toLowerCase().trim();

  // EM ANDAMENTO
  if (/^n[aã]o$|^nao$/.test(t)) return "ongoing";
  if (/andamento|já\s*tenho|ja\s*tenho|já\s*falei|ja\s*falei|já\s*conversei|ja\s*conversei|or[cç]amento/i.test(t)) return "ongoing";

  // PRIMEIRO CONTATO
  if (/^sim$/.test(t)) return "first";
  if (/primeir[ao]|1a\s*vez|primeira\s*vez|primeiro\s*contato|do\s*zero|come[cç]ando|comecando/i.test(t)) return "first";

  return "";
}

// -------------------- DÚVIDAS / INTENTS --------------------
function askedPain(text) {
  const t = String(text || "").toLowerCase();
  return /do[ií]|d[oó]i\s*muito|vai\s*doer|dor|aguenta|sens[ií]vel|anest[eé]s|anestesia/i.test(t);
}

function askedTime(text) {
  const t = String(text || "").toLowerCase();
  return /tempo|demora|quantas\s*sess|qnt\s*sess|termina\s*em\s*1|uma\s*sess[aã]o|duas\s*sess/i.test(t);
}

function askedPrice(text) {
  const t = String(text || "").toLowerCase();
  return /quanto\s*custa|valor|pre[cç]o|or[cç]amento|investimento|fica\s*quanto/i.test(t);
}

function askedHesitation(text) {
  const t = String(text || "").toLowerCase();
  return /vou\s*ver|te\s*aviso|preciso\s*pensar|depois\s*eu\s*falo|talvez|to\s*na\s*d[uú]vida|vou\s*avaliar/i.test(t);
}

function answeredNoDoubts(text) {
  const t = String(text || "").toLowerCase();
  return /\b(ok|tudo\s*certo|tranquilo|fechado|sem\s*d[uú]vidas|blz|beleza|deboa|de boa|pode\s*mandar)\b/i.test(t);
}

function msgDorResposta() {
  return (
    "Entendi.\n\n" +
    "• A dor varia bastante de pessoa e região.\n" +
    "• A maioria descreve como uma ardência/arranhão forte.\n" +
    "• Eu vou ajustando ritmo e pausas pra ficar confortável.\n\n" +
    "Me diz qual região do corpo que você pretende fazer."
  );
}

function msgTempoResposta() {
  return (
    "Boa.\n\n" +
    "• O tempo varia pelo tamanho + nível de detalhe (sombras, textura, contraste e acabamento).\n" +
    "• Meu foco é entregar qualidade e cicatrização correta.\n\n" +
    "Me diz local no corpo e tamanho aproximado."
  );
}

function msgPrecoAntesDoValor() {
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
    "• O que tá pegando mais: desenho, valor ou data?\n" +
    "• Se tiver uma data preferencial, me fala pra eu tentar priorizar."
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
Você é um tatuador profissional atendendo no WhatsApp (tom humano e profissional).
Regras:
- Nunca diga que é IA.
- Não assine mensagem.
- Não fale de horas nem preço/hora para o cliente (isso é interno).
- Antes de falar preço: explique o valor do trabalho (complexidade, sombras, transições, acabamento, encaixe).
- Você trabalha com whip shading.
- Você não faz sessões acima de 7 horas; se passar disso, divide em 2+ sessões (sem falar horas).
- Pagamento: Pix, débito, crédito até 12x.
- Inclui 1 retoque se necessário em 40–50 dias.
- Parcelamento mensal existe: se o cliente não conseguir pagar de uma vez, pode dividir em sessões mensais, com ajuste no total.
- Cobertura: peça foto da tattoo atual, e diga que vai analisar antes de confirmar.
- Criação: você faz criações exclusivas baseadas na referência e adapta ao corpo do cliente.
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
              "Analise a referência e gere uma explicação curta, direta e profissional do que o projeto exige (sombras, transições, volume, contraste, acabamento, encaixe). NÃO fale de preço, NÃO fale de horas. 5 a 8 linhas no máximo. Sem enfeitar.",
          },
          { type: "image_url", image_url: { url: imageDataUrl } },
        ],
      },
    ],
  });

  return resp.choices?.[0]?.message?.content?.trim() || "";
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

// -------------------- Replies --------------------
function msgCriacao() {
  return (
    "Sim — eu faço *criações exclusivas*.\n" +
    "A referência serve como base, e eu adapto a composição pro teu corpo (encaixe, proporção e leitura), mantendo o estilo do meu trabalho."
  );
}

function msgCoberturaPedirFoto() {
  return (
    "Sobre *cobertura*: me manda uma foto bem nítida da tattoo atual (de perto e de um pouco mais longe).\n\n" +
    "Assim eu analiso e te falo com sinceridade se dá pra fazer ou não."
  );
}

function msgPedirLocalOuTamanho() {
  return (
    "Me diz rapidinho:\n" +
    "• onde no corpo você quer fazer\n" +
    "• e o tamanho aproximado (se não souber em cm, descreve como você imagina)."
  );
}

function msgSoBlackGrey() {
  return (
    "Só pra alinhar:\n\n" +
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
    "• Depois do orçamento, você tem até *12 horas* pra enviar a foto do comprovante.\n" +
    "Se não enviar nesse prazo, o agendamento é *cancelado* e o agendamento é cancelado."
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
    "• Pra eu confirmar o agendamento, eu preciso da *foto do comprovante* aqui no Whats.\n" +
    pixLine +
    "Assim que chegar, eu sigo com a agenda."
  );
}

function msgPixDireto() {
  const pixLine = ENV.PIX_KEY ? ENV.PIX_KEY : "(chave pix não configurada no momento)";
  return (
    "Aqui está:\n\n" +
    `• Chave Pix: ${pixLine}\n` +
    "• Sinal para reserva: *R$ 50*\n\n" +
    "Depois me manda a *foto do comprovante* aqui."
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
    "Lembre antes da sessão:\n\n" +
    "• Beba bastante água.\n" +
    "• Evite álcool no dia anterior.\n" +
    "• Se alimente bem antes de vir."
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
  const pixLine = ENV.PIX_KEY ? `• Chave Pix: ${ENV.PIX_KEY}\n` : "";
  return (
    `Pelo tamanho e complexidade do que você me enviou, o investimento fica em *R$ ${valor}*.\n\n` +
    `• Eu organizo em *${sessoes} sessão(ões)* pra ficar bem executado e cicatrizar redondo.\n` +
    "• Pagamento: Pix, débito ou crédito em até 12x.\n" +
    "• Inclui *1 retoque* (se necessário) entre 40 e 50 dias.\n\n" +
    "Pra confirmar e reservar o horário eu peço um *sinal de R$ 50* que é abatatido no valor final no dia da sessão.\n" +
    pixLine +
    "Depois me manda a *foto do comprovante* aqui.\n\n" +
    depositDeadlineLine()
  );
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

// -------------------- Routes --------------------
app.get("/", (_req, res) => res.status(200).send("OK"));

app.get("/health", (_req, res) => {
  const miss = missingEnvs();
  res.status(miss.length ? 500 : 200).json({
    ok: miss.length === 0,
    missing: miss,
    have: {
      OPENAI_API_KEY: !!ENV.OPENAI_API_KEY,
      ZAPI_INSTANCE_ID: !!ENV.ZAPI_INSTANCE_ID,
      ZAPI_INSTANCE_TOKEN: !!ENV.ZAPI_INSTANCE_TOKEN,
      ZAPI_CLIENT_TOKEN: !!ENV.ZAPI_CLIENT_TOKEN,
      PIX_KEY: !!ENV.PIX_KEY,
      OWNER_PHONE: !!ENV.OWNER_PHONE,
    },
  });
});

app.post("/zapi", async (req, res) => {
  res.status(200).json({ ok: true });

  try {
    const miss = missingEnvs();
    if (miss.length) {
      console.warn("[ENV Missing]", miss.join(", "));
      return;
    }

    const inbound = parseZapiInbound(req.body || {});
    const { phone, message, imageUrl, imageMime, fromMe, messageType, contactName } = inbound;

    console.log("[IN]", {
      phone,
      fromMe,
      messageType,
      hasImageUrl: !!imageUrl,
      messagePreview: (message || "").slice(0, 120),
    });

    if (!phone) return;
    if (fromMe) return;

    const session = getSession(phone);
    const lower = (message || "").toLowerCase();

    // ✅ se já entrou em handoff manual
    if (session.manualHandoff) {
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
        const reply = `Perfeito.

• Se tiver uma imagem de referência (print/foto), me manda pra eu avaliar certinho.
• E me diz onde no corpo + tamanho aproximado.`;
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
      const reply = msgPixDireto();
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
      const reply = msgTempoResposta();
      if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
      return;
    }

    if (hes && !session.finished) {
      const reply = msgHesitacaoResposta();
      if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
      return;
    }

    if (priceAsk && !session.finished) {
      if (!session.imageDataUrl || (!session.bodyRegion && !session.sizeLocation)) {
        const reply = msgPrecoAntesDoValor();
        if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
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
    // Se passou do prazo e ainda não confirmou depósito, cancela e reinicia
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

    // -------------------- FLUXO NOVO (com gate do primeiro contato) --------------------

    // ✅ inicio -> manda saudação + pergunta do primeiro contato (SEM pedir referência ainda)
    if (session.stage === "inicio") {
      const reply = chooseGreetingOnce(session, contactName);
      if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);

      session.greeted = true;
      session.askedFirstContact = true;
      session.stage = "aguardando_primeiro_contato";
      return;
    }

    // ✅ aguardando resposta do "primeiro contato?"
    if (session.stage === "aguardando_primeiro_contato") {
      const ans = detectFirstContactAnswer(message);

      // cliente disse que já tem orçamento em andamento -> avisa dono e para o bot
      if (ans === "ongoing") {
        await notifyOwner(
          [
            "⚠️ CLIENTE DISSE QUE JÁ TEM ORÇAMENTO/ATENDIMENTO EM ANDAMENTO COM VOCÊ",
            `• Cliente: ${String(phone).replace(/\D/g, "")}`,
            `• Mensagem: ${(message || "").slice(0, 400)}`,
            "• Ação: você assume a conversa (bot parou).",
          ].join("\n")
        );

        session.manualHandoff = true;
        session.stage = "manual_pendente";
        return; // não responde mais nada
      }

      // primeiro contato -> segue o fluxo normal
      if (ans === "first") {
        session.firstContactResolved = true;
        session.stage = "aguardando_referencia";

        const reply =
          "Perfeito.\n\n" +
          "Me manda:\n" +
          "• a referência em imagem (se tiver)\n" +
          "• onde no corpo você quer fazer + tamanho aproximado";
        if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
        return;
      }

      // se não entendeu, pergunta de novo (humano, curto)
      const retry =
        "Só pra eu te direcionar certinho:\n" +
        "você já tem um orçamento em andamento comigo ou é o primeiro contato?";
      if (!antiRepeat(session, retry)) await zapiSendText(phone, retry);
      return;
    }

    // ✅ coverup sem imagem
    if (session.isCoverup && !session.imageDataUrl && !imageUrl) {
      const reply = msgCoberturaPedirFoto();
      if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
      session.stage = "aguardando_referencia";
      return;
    }

    // ✅ se está aguardando referência e NÃO tem imagem -> pede (sem repetir “perfeito” em loop)
    if (session.stage === "aguardando_referencia" && !session.imageDataUrl && !imageUrl) {
      const reply =
        "Tranquilo.\n\n" +
        "Quando puder, me manda:\n" +
        "• referência em imagem (print/foto)\n" +
        "• onde no corpo + tamanho aproximado";
      if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
      return;
    }

    // ✅ comprovante por texto sem foto (depois do orçamento)
    const depositTextOnly = detectDepositTextOnly(message);
    const isAfterQuote = session.stage === "pos_orcamento" || session.sentQuote;

    if (!session.depositConfirmed && depositTextOnly && !imageUrl && isAfterQuote) {
      // se cliente falou “já já mando”, responde só “fico no aguardo”
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

    // ✅ FOTO do comprovante (prioridade) — não analisa como referência
    const isReceiptImage = Boolean(imageUrl) && detectReceiptContext(session, message);
    if (!session.depositConfirmed && isReceiptImage && isAfterQuote) {
      session.depositConfirmed = true;
      session.stage = "agenda";
      session.askedSchedule = true;

      await notifyOwner(
        [
          "⚠️ COMPROVANTE RECEBIDO (bot)",
          `• Cliente: ${String(phone).replace(/\D/g, "")}`,
          "• Próximo passo: você confirma agenda manualmente",
        ].join("\n")
      );

      const reply = msgPerguntaAgenda();
      if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
      return;
    }

    // ✅ imagem referência chegou (PRIORIDADE) -> salva + pede região/tamanho (SEM mandar coisa repetida)
    if (imageUrl && !isReceiptImage) {
      try {
        const dataUrl = await fetchImageAsDataUrl(imageUrl, imageMime);
        session.imageDataUrl = dataUrl;

        // se for vídeo/arquivo e o modelo não conseguir ler, não trava: segue pedindo info + handoff se necessário
        session.imageSummary = await describeImageForClient(dataUrl);

        if (detectColorIntentBySummary(session.imageSummary)) {
          session.awaitingBWAnswer = true;
          const reply = msgSoBlackGrey();
          if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
          return;
        }

        // reset flags de fluxo
        session.sentSummary = false;
        session.askedDoubts = false;
        session.doubtsResolved = false;
        session.sentQuote = false;

        session.stage = "aguardando_info";

        if (!session.bodyRegion && !session.sizeLocation) {
          const reply = msgPedirLocalOuTamanho();
          if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
          return;
        }
      } catch (e) {
        console.error("[IMG] failed:", e?.message || e);
        // não tenta “analisar” — pede info e segue
        session.stage = "aguardando_info";
        if (!session.bodyRegion && !session.sizeLocation) {
          const reply = msgPedirLocalOuTamanho();
          if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
          return;
        }
      }
    }

    // ✅ se tem imagem e está aguardando info -> manda resumo / dúvidas
    if (session.imageDataUrl && session.stage === "aguardando_info") {
      if (!session.bodyRegion && !session.sizeLocation) {
        const reply = msgPedirLocalOuTamanho();
        if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
        return;
      }

      if (!session.sentSummary) {
        // se não conseguiu summary, não inventa: pede 1 frase do que é e segue
        if (!session.imageSummary) {
          const reply =
            "Recebi a referência.\n\n" +
            "Só me confirma:\n" +
            "• onde no corpo\n" +
            "• tamanho aproximado\n" +
            "e se é só igual a referência ou quer alguma alteração.";
          if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
          session.sentSummary = true;
        } else {
          const intro =
            "Recebi a referência.\n\n" +
            "Pra esse projeto ficar bem feito, ele exige:\n\n" +
            session.imageSummary;
          if (!antiRepeat(session, intro)) await zapiSendText(phone, intro);
          session.sentSummary = true;
        }
      }

      if (!session.askedDoubts) {
        const reply = msgChecagemDuvidas();
        if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
        session.askedDoubts = true;
        session.stage = "aguardando_duvidas";
        return;
      }

      session.stage = "aguardando_duvidas";
    }

    // -------------------- DÚVIDAS -> ORÇAMENTO --------------------
    if (session.stage === "aguardando_duvidas") {
      if (answeredNoDoubts(message)) {
        session.doubtsResolved = true;

        const infoParaCalculo =
          session.sizeLocation ||
          (session.bodyRegion ? `Região do corpo: ${session.bodyRegion} (tamanho não informado)` : "não informado");

        const hours = await estimateHoursInternal(session.imageDataUrl, infoParaCalculo, session.isCoverup);
        const sessoes = sessionsFromHours(hours);
        const valor = calcPriceFromHours(hours);

        const quote = msgOrcamentoCompleto(valor, sessoes);
        if (!antiRepeat(session, quote)) await zapiSendText(phone, quote);

        // ✅ marca que já falou das 12h e inicia contador de 12h
        session.sentDepositDeadlineInfo = true;
        session.depositDeadlineAt = Date.now() + 12 * 60 * 60 * 1000;

        session.sentQuote = true;
        session.stage = "pos_orcamento";
        return;
      }

      // se mandou qualquer coisa diferente, tenta responder humano e curto
      if (pain || timeAsk || priceAsk || hes || /\?/.test(message)) {
        const reply =
          "Entendi.\n\n" +
          "Me fala rapidinho qual é a dúvida principal que eu te explico e já seguimos.";
        if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
        return;
      }

      // fallback (sem loop)
      await handoffToManual(phone, session, "Mensagem fora do fluxo (etapa dúvidas)", message);
      return;
    }

    // -------------------- PÓS ORÇAMENTO --------------------
    if (session.stage === "pos_orcamento") {
      // cliente disse "já já mando o comprovante" -> não repete 12h/pix
      if (detectWillSendReceipt(message)) {
        session.waitingReceipt = true;
        const reply = msgFicoNoAguardoComprovante();
        if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
        return;
      }

      if (/fech|vamos|bora|quero|ok|topo|pode marcar/i.test(lower)) {
        const pixLine = ENV.PIX_KEY ? `• Chave Pix: ${ENV.PIX_KEY}\n` : "";
        const reply =
          "Fechado.\n\n" +
          "Pra reservar teu horário eu peço um *sinal de R$ 50*.\n" +
          pixLine +
          "Depois me manda a *foto do comprovante* aqui no Whats.";
        if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
        return;
      }

      if (/mensal|por mês|dividir|parcelar por mês/i.test(lower)) {
        const reply =
          "Dá sim.\n\n" +
          "Eu consigo organizar em *sessões mensais*.\n" +
          "Me diz em quantos meses você prefere que eu já te proponho o formato certinho.";
        if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
        return;
      }

      if (maybeRegion || maybeSizeLoc) {
        session.sentSummary = false;
        session.askedDoubts = false;
        session.doubtsResolved = false;
        session.sentQuote = false;
        session.stage = "aguardando_info";
        const reply = "Boa — com essa info eu ajusto certinho. Só um instante.";
        if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
        return;
      }

      await handoffToManual(phone, session, "Mensagem fora do fluxo (pós orçamento)", message);
      return;
    }

    // -------------------- AGENDA --------------------
    if (session.stage === "agenda") {
      const pref = detectCommercialPref(message);
      const hasDate = detectHasSpecificDate(message);
      const noDate = detectNoSpecificDate(message);

      if (pref || hasDate || noDate) {
        session.scheduleCaptured = true;
        session.manualHandoff = true;
        session.stage = "pos_agenda_manual";

        await notifyOwner(
          [
            "🗓️ PREFERÊNCIA DE AGENDA (bot)",
            `• Cliente: ${String(phone).replace(/\D/g, "")}`,
            `• Mensagem: ${(message || "").slice(0, 400)}`,
            "• Ação: confirmar agendamento manualmente e responder o cliente",
          ].join("\n")
        );

        if (noDate && !hasDate) {
          const reply = [msgVouVerificarAgendaSemData(), "", msgCuidadosPreSessao()].join("\n\n");
          if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
          return;
        }

        if (hasDate) {
          const reply = [msgVouVerificarAgendaComData(), "", msgCuidadosPreSessao()].join("\n\n");
          if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
          return;
        }

        const reply =
          "Fechado.\n\n" +
          "Vou verificar minha agenda e já te retorno.\n\n" +
          msgCuidadosPreSessao();
        if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
        return;
      }

      const reply = msgPerguntaAgenda();
      if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
      return;
    }

    // fallback final
    await handoffToManual(phone, session, "Fallback geral (não configurado)", message);
  } catch (err) {
    console.error("[ZAPI WEBHOOK ERROR]", err?.message || err);
  }
});

app.listen(Number(ENV.PORT), () => {
  console.log("Server running on port", ENV.PORT);
});
