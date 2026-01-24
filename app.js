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

// -------------------- Configs --------------------
const DEPOSIT_TIMEOUT_HOURS = 12; // 12h pra mandar comprovante após orçamento
const DEPOSIT_TIMEOUT_MS = DEPOSIT_TIMEOUT_HOURS * 60 * 60 * 1000;
const ANTI_REPEAT_WINDOW_MS = 90_000;

// -------------------- Session (RAM) --------------------
const sessions = {}; // key: phone

function getSession(phone) {
  if (!sessions[phone]) {
    sessions[phone] = {
      stage: "inicio",

      // referência / info
      imageDataUrl: null,
      imageSummary: null,
      sizeLocation: null,
      bodyRegion: null,
      isCoverup: false,

      // controle de primeira triagem
      greeted: false,
      greetVariant: null,
      closingVariant: null,
      askedFirstContact: false, // já fez a pergunta?
      firstContactResolved: false, // já respondeu?
      manualHandoff: false, // trava bot e passa pro dono
      finished: false,

      // flags de fluxo
      sentSummary: false,
      askedDoubts: false,
      sentQuote: false,
      depositConfirmed: false,

      // timers
      quoteSentAt: 0, // quando enviou orçamento

      // anti spam/loop
      lastReply: null,
      lastReplyAt: 0,

      // owner notify cooldown
      lastOwnerNotifyAt: 0,
    };
  }
  return sessions[phone];
}

function resetSession(phone) {
  delete sessions[phone];
}

function antiRepeat(session, reply) {
  const now = Date.now();
  if (session.lastReply === reply && now - session.lastReplyAt < ANTI_REPEAT_WINDOW_MS) return true;
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
    `Fico feliz em receber sua mensagem! Conta pra mim: qual é a sua ideia pra transformarmos em arte na pele?\n\n` +
    `• Se tiver uma referência em *imagem*, já pode me mandar.\n` +
    `• Me diz também *onde no corpo* você quer fazer e o *tamanho aproximado* (se souber).\n\n` +
    `Pra eu te atender do jeito certo: é seu *primeiro contato* comigo?\n` +
    `Responde *SIM* (primeiro contato) ou *NÃO* (já tem orçamento em andamento).`,
];

const CLOSINGS = [
  () =>
    `Fechado!\n\n` +
    `• Obrigado por confiar no meu trabalho.\n` +
    `• Qualquer dúvida, é só me chamar.\n` +
    `• Se precisar remarcar, tranquilo — só peço *48h de antecedência*.\n\n` +
    `A gente se vê na sessão.`,
  () =>
    `Show!\n\n` +
    `• Valeu por fechar comigo.\n` +
    `• Se surgir qualquer dúvida até o dia, me chama por aqui.\n` +
    `• Remarcação: *48h de antecedência*.\n\n` +
    `Só chegar bem hidratado e alimentado.`,
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
    "mão", "mao", "dedo", "punho", "antebraço", "antebraco", "braço", "braco",
    "ombro", "peito", "costela", "pescoço", "pescoco", "nuca",
    "pé", "pe", "tornozelo", "panturrilha", "canela",
    "coxa", "joelho", "virilha",
    "costas", "escápula", "escapula", "coluna",
    "rosto", "cabeça", "cabeca",
    "perna", "panturrilha",
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

// comprovante confirmado só com FOTO (imageUrl) após orçamento
function detectDepositTextOnly(text) {
  const t = (text || "").toLowerCase();
  return /comprovante|pix\s*feito|pix\s*realizado|paguei|pago|transferi|transferência|transferencia|sinal|enviei\s*o\s*pix|mandei\s*o\s*pix|caiu\s*o\s*pix|confirmad/i.test(t);
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
  if (/^(sim|aceito|pode|fechado|bora|ok|topo|manda|vamo)\b/i.test(t)) return "yes";
  if (/^(n[aã]o|nao)\b|prefiro\s*color|quero\s*color|n[aã]o\s*quero\s*preto/i.test(t)) return "no";
  return "";
}

// primeira triagem: primeiro contato?
function detectFirstContactAnswer(text) {
  const t = (text || "").toLowerCase().trim();

  // EM ANDAMENTO
  if (/^n[aã]o$|^nao$/.test(t)) return "ongoing";
  if (/andamento|já\s*tenho|ja\s*tenho|já\s*falei|ja\s*falei|já\s*conversei|ja\s*conversei|or[cç]amento/i.test(t)) return "ongoing";

  // PRIMEIRO CONTATO
  if (/^sim$/.test(t)) return "first";
  if (/primeir[ao]|primeira|primeiro|1a\s*vez|primeira\s*vez|primeiro\s*contato|do\s*zero|come[cç]ando/i.test(t))
    return "first";

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

// Dúvidas (bem simples + sem robô)
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
function answeredOkToSendValue(text) {
  const t = String(text || "").toLowerCase();
  // respostas que significam "pode mandar o valor"
  if (/nem\s*uma\s*d[uú]vida|sem\s*d[uú]vidas|tudo\s*certo|pode\s*passar|manda|pode\s*mandar|ok|blz|beleza|fechado/i.test(t))
    return true;

  // elogios que não são dúvidas (pra não cair em handoff)
  if (/lind[ao]|perfeit[ao]|top|show|espetacular|massa|ficou\s*doida|curti|amei/i.test(t)) return true;

  return false;
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
Você é um tatuador profissional atendendo no WhatsApp (tom humano e direto).
Regras:
- Nunca diga que é IA.
- Não assine mensagem.
- Não fale de preço/hora para o cliente (isso é interno).
- Antes de falar preço: explique o valor do trabalho (complexidade, sombras, transições, acabamento e encaixe).
- Você trabalha com whip shading.
- Você não faz sessões acima de 7 horas; se passar disso, divide em 2+ sessões (sem falar horas).
- Pagamento: Pix, débito, crédito até 12x.
- Inclui 1 retoque se necessário em 40–50 dias.
- Cobertura: peça foto da tattoo atual e avise que vai analisar antes de confirmar.
- Criação: você cria algo exclusivo baseado na referência e adapta ao corpo.
`).trim();

async function describeImageForClient(imageDataUrl) {
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
              "Analise a referência e gere uma explicação curta, direta e profissional do que o projeto exige (sombras, transições, volume, contraste, acabamento, encaixe). NÃO fale de preço, NÃO fale de horas. 4 a 7 linhas. Linguagem humana.",
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
    temperature: 0.10,
    messages: [
      {
        role: "system",
        content:
          "Você é um tatuador experiente. Estime SOMENTE um número de horas (inteiro) para execução, considerando complexidade e as informações do cliente. Responda APENAS com um número. Sem texto.",
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

// -------------------- Replies (sem “Perfeito” repetindo) --------------------
function msgCriacao() {
  return (
    "Sim — eu faço *criações exclusivas*.\n" +
    "A referência serve como base, e eu adapto pro teu corpo (encaixe, proporção e leitura), mantendo o estilo do meu trabalho."
  );
}

function msgCoberturaPedirFoto() {
  return (
    "Sobre *cobertura*: me manda uma foto bem nítida da tattoo atual (de perto e de um pouco mais longe).\n\n" +
    "Eu preciso ver contraste, saturação e cicatrização pra te falar com sinceridade se dá pra chegar no resultado certo."
  );
}

function msgPedirLocalOuTamanho() {
  return (
    "Show. Pra eu te passar um valor bem fiel, me diz:\n\n" +
    "• *onde no corpo* você quer fazer\n" +
    "• *tamanho aproximado* (se não souber em cm, descreve do jeito que imagina)"
  );
}

function msgSoBlackGrey() {
  return (
    "Só pra alinhar:\n\n" +
    "• Eu trabalho com *black & grey* (preto e cinza).\n" +
    "• Não faço tattoo totalmente colorida.\n\n" +
    "Se você curtir em preto e cinza, eu sigo e deixo com bastante profundidade e contraste."
  );
}

function msgFinalizaPorNaoAceitarBW() {
  return (
    "Entendi.\n\n" +
    "Como eu trabalho só com *black & grey*, não vou conseguir te atender do jeito que você quer em colorido.\n" +
    "Se você decidir fazer em preto e cinza no futuro, é só me chamar."
  );
}

function msgEndereco() {
  return (
    "Claro.\n\n" +
    "• Endereço: *Av. Mauá, 1308* — próximo à rodoviária.\n" +
    "Se quiser, me diz seu bairro que eu te passo uma referência rápida de como chegar."
  );
}

function msgAguardandoComprovante() {
  const pixLine = ENV.PIX_KEY ? `• Chave Pix: ${ENV.PIX_KEY}\n` : "";
  return (
    "Fechado.\n\n" +
    "Pra eu confirmar o agendamento, eu preciso da *foto do comprovante* aqui no Whats.\n" +
    pixLine +
    `Você tem até *${DEPOSIT_TIMEOUT_HOURS} horas* pra enviar o comprovante. Se passar disso sem enviar, o agendamento é *cancelado* e o horário volta pra agenda.`
  );
}

function msgPixDireto() {
  const pixLine = ENV.PIX_KEY ? ENV.PIX_KEY : "(chave pix não configurada no momento)";
  return (
    "Aqui vai:\n\n" +
    `• Chave Pix: ${pixLine}\n` +
    "• Sinal para reserva: *R$ 50*\n\n" +
    "Assim que você enviar a *foto do comprovante* aqui, eu confirmo e seguimos pra agenda."
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
    "Pra reservar o horário eu peço um *sinal de R$ 50*.\n" +
    pixLine +
    `Depois do orçamento, você tem até *${DEPOSIT_TIMEOUT_HOURS} horas* pra enviar o comprovante. Se não enviar nesse prazo, o agendamento é *cancelado* e o horário volta pra agenda.`
  );
}

function msgPerguntaAgenda() {
  return (
    "Comprovante recebido.\n\n" +
    "Pra eu agendar do melhor jeito pra você:\n" +
    "• Você prefere horário *comercial* ou *pós-comercial*?\n" +
    "• Você tem alguma data específica livre?"
  );
}

function msgVouVerificarAgendaSemData() {
  return (
    "Fechado.\n\n" +
    "Vou verificar minha agenda e já te retorno com as próximas opções de data e horário."
  );
}

function msgVouVerificarAgendaComData() {
  return (
    "Show.\n\n" +
    "Vou verificar se essa data está disponível e já te retorno confirmando as opções."
  );
}

function msgCuidadosPreSessao() {
  return (
    "Antes da sessão:\n\n" +
    "• Beba bastante água no dia anterior e no dia.\n" +
    "• Evite álcool no dia anterior.\n" +
    "• Se alimente bem antes de vir."
  );
}

function msgReferenciaJaRecebida() {
  return (
    "Recebi a referência.\n\n" +
    "Agora só me confirma:\n" +
    "• *onde no corpo*\n" +
    "• *tamanho aproximado*"
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

  const reply = "Beleza — vou analisar direitinho e já te respondo.";
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

    // ✅ se já entrou em handoff manual (bot trava)
    if (session.manualHandoff) {
      // se cliente agradecer depois do handoff, pode fechar com uma despedida única
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
        "Me manda a referência em *imagem* e me diz *onde no corpo* você quer fazer.";
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

    // ✅ intents gerais
    if (detectCoverup(message)) session.isCoverup = true;
    const askedCreation = /cria|criação|desenho|autor|exclusiv/i.test(lower);

    const maybeRegion = extractBodyRegion(message);
    if (!session.bodyRegion && maybeRegion) session.bodyRegion = maybeRegion;

    const maybeSizeLoc = extractSizeLocation(message);
    if (!session.sizeLocation && maybeSizeLoc) session.sizeLocation = maybeSizeLoc;

    if (askedCreation) {
      const reply = msgCriacao();
      if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
      // não retorna: deixa seguir o fluxo
    }

    // ✅ regra de 12h após orçamento: cancela se passou
    if (session.stage === "pos_orcamento" && session.sentQuote && !session.depositConfirmed && session.quoteSentAt) {
      const elapsed = Date.now() - session.quoteSentAt;
      if (elapsed > DEPOSIT_TIMEOUT_MS) {
        const reply =
          `Esse orçamento expirou porque não recebi o comprovante dentro de *${DEPOSIT_TIMEOUT_HOURS} horas*.\n\n` +
          "Se você ainda quiser agendar, me chama aqui que eu reabro e te passo as opções novamente.";
        // reseta e manda mensagem única
        resetSession(phone);
        const s3 = getSession(phone);
        if (!antiRepeat(s3, reply)) await zapiSendText(phone, reply);
        return;
      }
    }

    // ✅ filtro de cor
    if (!session.finished && detectColorIntentByText(message)) {
      session.stage = session.stage || "aguardando_referencia";
      const reply = msgSoBlackGrey();
      if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
      // espera o sim/não na conversa
      session.awaitingBWAnswer = true;
      return;
    }
    if (session.awaitingBWAnswer) {
      const bw = detectBWAccept(message);
      if (bw === "no") {
        session.finished = true;
        session.stage = "finalizado";
        const reply = msgFinalizaPorNaoAceitarBW();
        if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
        return;
      }
      if (bw === "yes") {
        session.awaitingBWAnswer = false;
        // segue fluxo
      }
    }

    // -------------------- INÍCIO: SAUDAÇÃO + PRIMEIRO CONTATO --------------------
    if (session.stage === "inicio") {
      const reply = chooseGreetingOnce(session, contactName);
      if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
      session.greeted = true;
      session.askedFirstContact = true;
      session.stage = "primeiro_contato";
      return;
    }

    // ✅ resolve primeira triagem (SIM = primeiro contato, NÃO = já em andamento)
    if (session.stage === "primeiro_contato") {
      const ans = detectFirstContactAnswer(message);

      if (ans === "ongoing") {
        // avisa dono e trava bot sem responder mais nada (como você pediu)
        await notifyOwner(
          [
            "⚠️ ATENDIMENTO JÁ EM ANDAMENTO",
            `• Cliente: ${String(phone).replace(/\D/g, "")}`,
            "• Motivo: disse que NÃO é primeiro contato / já tem orçamento em andamento",
            `• Mensagem: ${(message || "").slice(0, 300)}`,
          ].join("\n")
        );

        session.manualHandoff = true;
        session.stage = "manual_pendente";
        return;
      }

      if (ans === "first") {
        session.firstContactResolved = true;
        session.stage = "aguardando_referencia";
        // não manda msg extra aqui pra não poluir (ele já recebeu a saudação pedindo referência)
        return;
      }

      // se respondeu algo confuso, só pede SIM/NÃO (sem repetir “perfeito”)
      const reply =
        "Só pra eu te atender certo:\n\n" +
        "É seu *primeiro contato* comigo?\n" +
        "Responde *SIM* ou *NÃO*.";
      if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
      return;
    }

    // -------------------- FLUXO PRINCIPAL --------------------

    // ✅ coverup sem imagem
    if (session.isCoverup && !session.imageDataUrl && !imageUrl && session.stage !== "pos_orcamento") {
      const reply = msgCoberturaPedirFoto();
      if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
      session.stage = "aguardando_referencia";
      return;
    }

    // ✅ se cliente mandou algum media que não vira imagem (ex: vídeo), evita “manda referência” repetido
    const looksLikeVideo = /video/i.test(String(messageType || ""));
    if (looksLikeVideo && !imageUrl && !session.imageDataUrl) {
      const reply =
        "Recebi o vídeo.\n\n" +
        "Pra eu avaliar certinho, consegue me mandar *uma foto nítida* da tattoo/referência? (de perto e mais afastado)";
      if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
      session.stage = "aguardando_referencia";
      return;
    }

    // ✅ imagem referência chegou -> salva + segue
    if (imageUrl) {
      try {
        const dataUrl = await fetchImageAsDataUrl(imageUrl, imageMime);
        session.imageDataUrl = dataUrl;
        session.imageSummary = await describeImageForClient(dataUrl);

        if (detectColorIntentBySummary(session.imageSummary)) {
          session.awaitingBWAnswer = true;
          const reply = msgSoBlackGrey();
          if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
          return;
        }

        // reset flags de fluxo quando chega uma referência nova
        session.sentSummary = false;
        session.askedDoubts = false;
        session.sentQuote = false;
        session.depositConfirmed = false;
        session.quoteSentAt = 0;

        // se ainda não tem info -> pede e para (1 msg só)
        session.stage = "aguardando_info";
        if (!session.bodyRegion && !session.sizeLocation) {
          const reply = msgPedirLocalOuTamanho();
          if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
          return;
        }
      } catch (e) {
        console.error("[IMG] failed:", e?.message || e);
        // se falhou baixar imagem, evita loop: passa pro manual
        await handoffToManual(phone, session, "Falha ao baixar imagem", message);
        return;
      }
    }

    // ✅ se está aguardando referência e não tem imagem ainda
    if (session.stage === "aguardando_referencia" && !session.imageDataUrl && !imageUrl) {
      // não repete saudação: só pede o essencial
      const reply =
        "Me manda uma referência em *imagem* (foto/print) pra eu avaliar certinho.\n\n" +
        "E me diz:\n" +
        "• *onde no corpo*\n" +
        "• *tamanho aproximado*";
      if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
      return;
    }

    // ✅ se tem imagem e está aguardando info
    if (session.imageDataUrl && session.stage === "aguardando_info") {
      if (!session.bodyRegion && !session.sizeLocation) {
        const reply = msgPedirLocalOuTamanho();
        if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
        return;
      }

      if (!session.sentSummary && session.imageSummary) {
        const intro =
          "Recebi a referência.\n\n" +
          "Pra esse projeto ficar bem feito, ele exige:\n\n" +
          session.imageSummary;
        if (!antiRepeat(session, intro)) await zapiSendText(phone, intro);
        session.sentSummary = true;
      }

      if (!session.askedDoubts) {
        const reply = msgChecagemDuvidas();
        if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
        session.askedDoubts = true;
        session.stage = "aguardando_ok_valor";
        return;
      }

      session.stage = "aguardando_ok_valor";
    }

    // ✅ depois do resumo + checagem: manda orçamento quando estiver OK
    if (session.stage === "aguardando_ok_valor") {
      const pain = askedPain(message);
      const timeAsk = askedTime(message);
      const priceAsk = askedPrice(message);

      // respostas diretas de dor/tempo/preço (humanas e curtas)
      if (pain) {
        const reply =
          "Sobre dor: varia muito por pessoa e região.\n" +
          "No geral é mais uma *ardência/arranhão intenso*.\n\n" +
          "Me diz a região que você quer fazer que eu te falo se costuma ser mais tranquila ou mais sensível.";
        if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
        return;
      }

      if (timeAsk) {
        const reply =
          "Depende do tamanho e do nível de detalhe (sombras, textura, transição e acabamento).\n\n" +
          "Me confirma o tamanho e a região que eu te passo uma noção bem fiel.";
        if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
        return;
      }

      if (priceAsk && (!session.bodyRegion && !session.sizeLocation)) {
        const reply = msgPedirLocalOuTamanho();
        if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
        return;
      }

      // se cliente falou algo que significa "ok, manda valor" (inclui elogios)
      if (answeredOkToSendValue(message)) {
        const infoParaCalculo =
          session.sizeLocation ||
          (session.bodyRegion ? `Região do corpo: ${session.bodyRegion} (tamanho não informado)` : "não informado");

        const hours = await estimateHoursInternal(session.imageDataUrl, infoParaCalculo, session.isCoverup);
        const sessoes = sessionsFromHours(hours);
        const valor = calcPriceFromHours(hours);

        const quote = msgOrcamentoCompleto(valor, sessoes);
        if (!antiRepeat(session, quote)) await zapiSendText(phone, quote);

        session.sentQuote = true;
        session.quoteSentAt = Date.now();
        session.stage = "pos_orcamento";
        return;
      }

      // se não deu pra interpretar, manda pro manual ao invés de ficar repetindo
      await handoffToManual(phone, session, "Mensagem não clara na etapa de confirmação do valor", message);
      return;
    }

    // -------------------- PÓS ORÇAMENTO --------------------
    if (session.stage === "pos_orcamento") {
      // ✅ comprovante por texto sem foto
      const depositTextOnly = detectDepositTextOnly(message);
      if (!session.depositConfirmed && depositTextOnly && !imageUrl) {
        const reply = msgAguardandoComprovante();
        if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
        return;
      }

      // ✅ FOTO do comprovante (imageUrl) após orçamento
      if (!session.depositConfirmed && imageUrl) {
        session.depositConfirmed = true;
        session.stage = "agenda";

        await notifyOwner(
          [
            "⚠️ COMPROVANTE RECEBIDO (bot)",
            `• Cliente: ${String(phone).replace(/\D/g, "")}`,
            "• Próximo passo: confirmar agenda manualmente",
          ].join("\n")
        );

        const reply = msgPerguntaAgenda();
        if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
        return;
      }

      // ✅ se cliente falar que quer fechar/agendar, manda instrução do sinal + regra 12h
      if (/fech|vamos|bora|quero|ok|topo|pode marcar/i.test(lower)) {
        const reply = msgAguardandoComprovante();
        if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
        return;
      }

      // se vier qualquer outra coisa fora do esperado, passa pro manual (sem loop)
      await handoffToManual(phone, session, "Mensagem fora do fluxo (pós orçamento)", message);
      return;
    }

    // -------------------- AGENDA --------------------
    if (session.stage === "agenda") {
      const pref = detectCommercialPref(message);
      const hasDate = detectHasSpecificDate(message);
      const noDate = detectNoSpecificDate(message);

      if (pref || hasDate || noDate) {
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

        const reply = ["Vou verificar a agenda e já te retorno.", "", msgCuidadosPreSessao()].join("\n\n");
        if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
        return;
      }

      const reply = msgPerguntaAgenda();
      if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
      return;
    }

    // fallback final -> manual (sem repetir msg automática burra)
    await handoffToManual(phone, session, "Fallback geral (não configurado)", message);
  } catch (err) {
    console.error("[ZAPI WEBHOOK ERROR]", err?.message || err);
  }
});

app.listen(Number(ENV.PORT), () => {
  console.log("Server running on port", ENV.PORT);
});
