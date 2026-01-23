// app.js (ESM)
// ENV no Render:
// OPENAI_API_KEY
// ZAPI_INSTANCE_ID
// ZAPI_INSTANCE_TOKEN
// ZAPI_CLIENT_TOKEN
// (opcional) SYSTEM_PROMPT
// (opcional) PIX_KEY

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
      imageDataUrl: null,   // data:image/...;base64,...
      imageSummary: null,   // descrição técnica pro cliente
      sizeLocation: null,   // "25cm no antebraço" (opcional)
      bodyRegion: null,     // "costela", "pescoço", "mão" etc (aceita sem cm)
      isCoverup: false,

      // FLAGS pra não repetir
      sentSummary: false,
      sentPayments: false,
      sentQuote: false,

      // etapa de sinal/agenda
      depositConfirmed: false,
      askedSchedule: false,

      // (ADICIONADO) preferências de agenda
      schedulePref: {
        shift: null,  // "comercial" | "pos"
        dateText: null, // texto livre / "próxima data disponível"
      },

      // ✅ (ADICIONADO) pós-orçamento: dúvidas
      askedDoubts: false,

      // anti loop básico
      lastReply: null,
      lastReplyAt: 0,
    };
  }
  return sessions[phone];
}

function antiRepeat(session, reply) {
  const now = Date.now();
  if (session.lastReply === reply && now - session.lastReplyAt < 90_000) return true; // 90s
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

// -------------------- Inbound normalize --------------------
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

  return {
    phone: phone ? String(phone) : null,
    message: String(message || "").trim(),
    imageUrl: imageUrl ? String(imageUrl) : null,
    imageMime: String(imageMime || "image/jpeg"),
    fromMe,
    messageType: String(messageType || ""),
    raw: body,
  };
}

// -------------------- Image download -> dataUrl --------------------
async function fetchImageAsDataUrl(url, mimeHint = "image/jpeg") {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 15_000);

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
    const maxBytes = 8 * 1024 * 1024;
    if (arr.byteLength > maxBytes) throw new Error(`Image too large: ${arr.byteLength} bytes`);

    const b64 = Buffer.from(arr).toString("base64");
    return `data:${mime};base64,${b64}`;
  } finally {
    clearTimeout(t);
  }
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

function detectDepositConfirmation(text) {
  const t = (text || "").toLowerCase();
  return /comprovante|pix\s*feito|pix\s*realizado|paguei|pago|transferi|transferência|transferencia|sinal|enviei\s*o\s*pix|mandei\s*o\s*pix|caiu\s*o\s*pix|confirmad/i.test(t);
}

// ✅ AJUSTE: pergunta de agenda completa
function msgPerguntaAgenda() {
  return (
    "Perfeito — sinal confirmado.\n\n" +
    "Pra eu agendar do melhor jeito pra você:\n" +
    "1) Você prefere horário *comercial* ou *pós-comercial*?\n" +
    "2) Você tem alguma data específica livre?\n\n" +
    "Se você não tiver uma data em mente, eu posso te passar a *próxima data livre* que eu tenho e já deixar reservado."
  );
}

// ✅ (ADICIONADO) detectar comandos de reset
function isResetCommand(text = "") {
  const t = String(text || "").trim().toLowerCase();
  return /^(reset|reiniciar|começar novamente|comecar novamente|recomeçar|recomecar)$/i.test(t);
}

// ✅ (ADICIONADO) extrair preferência de horário e data na etapa de agenda
function parseSchedulePref(text = "") {
  const t = String(text || "").toLowerCase();

  let shift = null;
  if (/(p[oó]s|pos)[-\s]?comercial|noite|depois do trabalho|ap[oó]s o trabalho|p[oó]s[-\s]?hor[aá]rio/i.test(t)) {
    shift = "pos";
  } else if (/comercial|hor[aá]rio comercial|manh[aã]|tarde/i.test(t)) {
    shift = "comercial";
  }

  let dateText = null;
  if (/pr[oó]xima|proxima|sem prefer[eê]ncia|sem preferencia|qualquer dia|tanto faz/i.test(t)) {
    dateText = "próxima data disponível";
  } else if (/\d{1,2}\/\d{1,2}|\d{1,2}-\d{1,2}|segunda|ter[cç]a|quarta|quinta|sexta|s[aá]bado|domingo/i.test(t)) {
    dateText = String(text || "").trim();
  }

  return { shift, dateText };
}

// ✅ (ADICIONADO) detectar pedido de pix
function isAskingPix(text = "") {
  const t = String(text || "").toLowerCase();
  return /qual\s*o\s*pix|chave\s*pix|me\s*passa\s*o\s*pix|pix\??$/i.test(t);
}

// ✅ (ADICIONADO) detectar resposta “sem dúvida”
function isNoDoubt(text = "") {
  const t = String(text || "").toLowerCase().trim();
  return /^(n[aã]o|nao)\s*(tenho|tem)\s*(d[uú]vida|duvidas)\b|sem\s*d[uú]vida|sem\s*duvidas|tudo\s*certo|tranquilo|ok|de boa|show|fechado|beleza|perfeito$/i.test(t);
}

// ✅ (ADICIONADO) detectar resposta “tenho dúvida”
function isHasDoubt(text = "") {
  const t = String(text || "").toLowerCase();
  return /(tenho|com)\s*d[uú]vida|d[uú]vida|duvida/i.test(t);
}

// Nova regra de preço:
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
- Você trabalha com whip shading (técnica delicada e limpa).
- Você não faz sessões acima de 7 horas; se passar disso, divide em 2+ sessões (sem falar horas).
- Pagamento: Pix, débito, crédito até 12x.
- Inclui 1 retoque se necessário em 40–50 dias.
- Parcelamento mensal existe: se o cliente não conseguir pagar de uma vez, pode dividir em sessões mensais, com ajuste no total.
- Cobertura: peça foto da tattoo atual, mas deixe claro que raramente aceita cobertura por causa do seu estilo (whip shading), e que vai analisar antes de confirmar.
- Criação: você faz criações exclusivas baseadas na referência e adapta ao corpo do cliente.
`).trim();

async function describeImageForClient(imageDataUrl) {
  const resp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.5,
    messages: [
      { role: "system", content: BASE_SYSTEM },
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              "Analise a referência e gere uma explicação curta e profissional do que o projeto exige (sombras, transições, volume, contraste, acabamento, encaixe). NÃO fale de preço, NÃO fale de horas. 6 a 10 linhas no máximo.",
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
    model: "gpt-4o-mini",
    temperature: 0.2,
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
function msgInicio() {
  return (
    "Opa, tudo certo?\n" +
    "Obrigado por me chamar e confiar no meu trabalho.\n\n" +
    "Pra eu te passar um orçamento justo, me manda a referência em *imagem* e me diz *onde no corpo* você quer fazer.\n" +
    "Se souber o tamanho aproximado, melhor — mas se não souber, sem problema."
  );
}

function msgCriacao() {
  return (
    "Sim — eu faço *criações exclusivas*.\n" +
    "A referência serve como base, e eu adapto a composição pro teu corpo (encaixe, proporção e leitura), mantendo o estilo do meu trabalho."
  );
}

function msgCoberturaPedirFoto() {
  return (
    "Sobre *cobertura*: me manda uma foto bem nítida da tattoo atual (de perto e de um pouco mais longe).\n\n" +
    "Só pra ser transparente: eu *raramente* pego cobertura, porque meu estilo (whip shading) é bem limpo e delicado e, na maioria dos casos, cobertura não entrega o resultado que eu gosto de entregar.\n" +
    "Mas me manda a foto que eu analiso e te falo com sinceridade se dá pra fazer ou não."
  );
}

function msgPedirLocalOuTamanho() {
  return (
    "Perfeito.\n" +
    "Me confirma só *o local no corpo* (ex: costela, pescoço, mão, antebraço) e, se souber, o *tamanho aproximado*.\n" +
    "Se não souber em cm, pode falar do jeito que você imagina que eu consigo estimar por aqui."
  );
}

function msgPagamentosESessoes(sessoes) {
  return (
    `Pra ficar com um resultado bem limpo e cicatrização correta, eu organizo esse projeto em *${sessoes} sessão(ões)*.\n` +
    "Eu não passo de 7 horas por sessão — quando o projeto pede mais, eu divido pra manter qualidade.\n\n" +
    "Pagamento:\n" +
    "• Pix\n" +
    "• Débito\n" +
    "• Crédito em até 12x\n\n" +
    "E o orçamento já inclui *1 sessão de retoque* (se necessário) entre 40 e 50 dias após cicatrização.\n\n" +
    "Se ficar pesado pagar tudo de uma vez, dá pra fazer em *sessões mensais* (com ajuste no total)."
  );
}

// ✅ AJUSTE: sinal é R$ 50 + mostra chave Pix
function msgFechamentoValor(valor) {
  const pixLine = ENV.PIX_KEY ? `Chave Pix: ${ENV.PIX_KEY}\n` : "";
  return (
    `Pelo tamanho e complexidade do que você me enviou, o investimento fica em *R$ ${valor}*.\n\n` +
    "Se fizer sentido pra você, pra reservar o horário eu peço um *sinal de R$ 50*.\n" +
    pixLine +
    "Assim que confirmar e me mandar o comprovante aqui, eu já te passo as opções de agenda certinhas."
  );
}

// ✅ (ADICIONADO) pós-orçamento: pergunta de dúvidas
function msgDuvidasAtendimento() {
  return "Ficou alguma dúvida sobre o atendimento?";
}

function msgSemDuvidas() {
  return (
    "Perfeito — obrigado.\n" +
    "Qualquer coisa que você precisar, é só me chamar por aqui. Fico à disposição."
  );
}

function msgPedirDuvida() {
  return "Pode me falar qual é a tua dúvida que eu te explico certinho por aqui.";
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
    const { phone, message, imageUrl, imageMime, fromMe, messageType } = inbound;

    console.log("[IN]", {
      phone,
      fromMe,
      messageType,
      hasImageUrl: !!imageUrl,
      messagePreview: (message || "").slice(0, 120),
    });

    if (!phone) return;
    if (fromMe) return;

    // ✅ RESET atendimento (zera sessão)
    if (isResetCommand(message)) {
      delete sessions[phone];
      const s = getSession(phone);
      const reply =
        "Fechado — vamos começar do zero.\n\n" +
        "Me manda a referência em *imagem* e me diz *onde no corpo* você quer fazer.\n" +
        "Se souber o tamanho aproximado, melhor — mas se não souber, sem problema.";
      if (!antiRepeat(s, reply)) await zapiSendText(phone, reply);
      return;
    }

    const session = getSession(phone);
    const lower = (message || "").toLowerCase();

    // ✅ responder “Qual o pix?” sem bagunçar fluxo
    if (isAskingPix(message)) {
      const pix = ENV.PIX_KEY ? `Chave Pix: ${ENV.PIX_KEY}` : "Minha chave Pix não está cadastrada aqui no sistema.";
      const reply =
        `${pix}\n\n` +
        "Pra reservar teu horário eu peço um *sinal de R$ 50*.\n" +
        "Assim que confirmar e me mandar o comprovante, eu já te passo as opções de agenda certinhas.";
      if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
      return;
    }

    // intents
    if (detectCoverup(message)) session.isCoverup = true;
    const askedCreation = /cria|criação|desenho|autor|exclusiv/i.test(lower);

    // captura região e/ou tamanho (sem exigir cm)
    const maybeRegion = extractBodyRegion(message);
    if (!session.bodyRegion && maybeRegion) session.bodyRegion = maybeRegion;

    const maybeSizeLoc = extractSizeLocation(message);
    if (!session.sizeLocation && maybeSizeLoc) session.sizeLocation = maybeSizeLoc;

    // etapa agenda (após sinal confirmado)
    if (session.stage === "agenda") {
      const pref = parseSchedulePref(message || "");
      if (pref.shift) session.schedulePref.shift = pref.shift;
      if (pref.dateText) session.schedulePref.dateText = pref.dateText;

      if (!session.askedSchedule) {
        const r = msgPerguntaAgenda();
        if (!antiRepeat(session, r)) await zapiSendText(phone, r);
        session.askedSchedule = true;
        return;
      }

      if (session.schedulePref.shift || session.schedulePref.dateText) {
        const shiftText =
          session.schedulePref.shift === "pos"
            ? "pós-comercial"
            : session.schedulePref.shift === "comercial"
              ? "comercial"
              : "não informado";

        const dateText = session.schedulePref.dateText || "não informado";

        const reply =
          "Perfeito. Vou conferir minha agenda e já te retorno com as opções mais próximas.\n\n" +
          `Preferência de horário: *${shiftText}*\n` +
          `Data: *${dateText}*`;

        if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
        session.stage = "pos_agenda";
        return;
      }

      const fallback =
        "Show — só me confirma: você prefere *comercial* ou *pós-comercial*? E tem alguma *data* em mente?\n" +
        "Se não tiver, eu te passo a *próxima data livre*.";
      if (!antiRepeat(session, fallback)) await zapiSendText(phone, fallback);
      return;
    }

    // confirmação de sinal/comprovante -> pergunta agenda (uma vez)
    const depositByText = detectDepositConfirmation(message);
    const depositByImageAfterQuote = Boolean(imageUrl) && (session.stage === "pos_orcamento" || session.sentQuote);

    if (!session.depositConfirmed && (depositByText || depositByImageAfterQuote)) {
      session.depositConfirmed = true;
      session.stage = "agenda";
      session.askedSchedule = false;

      const reply = msgPerguntaAgenda();
      if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
      session.askedSchedule = true;
      return;
    }

    // imagem chegou -> salva e gera resumo (e reseta flags do orçamento, pq é nova referência)
    if (imageUrl) {
      try {
        const dataUrl = await fetchImageAsDataUrl(imageUrl, imageMime);
        session.imageDataUrl = dataUrl;

        session.imageSummary = await describeImageForClient(dataUrl);

        // Nova referência: reseta flags para permitir novo orçamento (uma vez só)
        session.sentSummary = false;
        session.sentPayments = false;
        session.sentQuote = false;

        session.stage = "aguardando_info";
      } catch (e) {
        console.error("[IMG] failed:", e?.message || e);
      }
    }

    // criação
    if (askedCreation) {
      const reply = msgCriacao();
      if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
    }

    // cobertura
    if (session.isCoverup && !session.imageDataUrl) {
      const reply = msgCoberturaPedirFoto();
      if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
      session.stage = "aguardando_referencia";
      return;
    }

    // fluxo inicial
    if (session.stage === "inicio") {
      const reply = msgInicio();
      if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
      session.stage = "aguardando_referencia";
      return;
    }

    // aguardando referência
    if (session.stage === "aguardando_referencia") {
      if (!session.imageDataUrl) {
        const wantsPrice = /valor|preço|orc|orç|quanto/i.test(lower);
        const reply = wantsPrice ? msgInicio() : "Me manda a referência em *imagem* pra eu avaliar certinho 🙏";
        if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
        return;
      }
      session.stage = "aguardando_info";
    }

    // com imagem, mas faltam infos mínimas
    if (session.imageDataUrl && session.stage === "aguardando_info") {
      if (!session.bodyRegion && !session.sizeLocation) {
        const reply = msgPedirLocalOuTamanho();
        if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
        return;
      }

      if (!session.sentSummary && session.imageSummary) {
        const intro =
          "Perfeito, recebi a referência.\n" +
          "Antes de falar de valor, deixa eu te explicar o que esse projeto exige pra ficar bem feito:\n\n" +
          session.imageSummary;

        if (!antiRepeat(session, intro)) await zapiSendText(phone, intro);
        session.sentSummary = true;
      }

      const infoParaCalculo =
        session.sizeLocation ||
        (session.bodyRegion ? `Região do corpo: ${session.bodyRegion} (tamanho não informado)` : "não informado");

      const hours = await estimateHoursInternal(session.imageDataUrl, infoParaCalculo, session.isCoverup);
      const sessoes = sessionsFromHours(hours);
      const valor = calcPriceFromHours(hours);

      if (!session.sentPayments) {
        const bloco = msgPagamentosESessoes(sessoes);
        if (!antiRepeat(session, bloco)) await zapiSendText(phone, bloco);
        session.sentPayments = true;
      }

      if (!session.sentQuote) {
        const final = msgFechamentoValor(valor);
        if (!antiRepeat(session, final)) await zapiSendText(phone, final);
        session.sentQuote = true;
      }

      session.stage = "pos_orcamento";
      session.askedDoubts = false; // ✅ reseta pra fazer a pergunta de dúvidas 1x
      return;
    }

    // pós orçamento
    if (session.stage === "pos_orcamento") {
      if (/mensal|por mês|dividir|parcelar por mês/i.test(lower)) {
        const reply =
          "Dá sim.\n" +
          "Quando fica pesado pagar tudo de uma vez, eu consigo organizar em *sessões mensais*.\n" +
          "Aí o total ajusta um pouco por ficar parcelado por sessão.\n" +
          "Me diz em quantos meses você prefere que eu já te proponho o formato certinho.";
        if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
        return;
      }

      if (/fech|vamos|bora|quero|ok|topo|pode marcar/i.test(lower)) {
        const pixLine = ENV.PIX_KEY ? `\nChave Pix: ${ENV.PIX_KEY}` : "";
        const reply =
          "Fechado.\n" +
          "Pra reservar teu horário eu peço um *sinal de R$ 50*." +
          pixLine +
          "\nAssim que cair, me manda o comprovante aqui que eu já te passo as opções de agenda certinhas.";
        if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
        return;
      }

      if (maybeRegion || maybeSizeLoc) {
        session.sentPayments = false;
        session.sentQuote = false;
        session.stage = "aguardando_info";
        const reply = "Perfeito — com essa informação eu consigo ajustar o orçamento certinho. Só um instante.";
        if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
        return;
      }

      // ✅ AQUI: troca a mensagem final repetitiva por “ficou alguma dúvida…”
      if (isNoDoubt(message)) {
        const reply = msgSemDuvidas();
        if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
        // mantém em pos_orcamento, mas não fica cutucando
        session.askedDoubts = true;
        return;
      }

      if (isHasDoubt(message)) {
        const reply = msgPedirDuvida();
        if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
        session.askedDoubts = true;
        return;
      }

      if (!session.askedDoubts) {
        const reply = msgDuvidasAtendimento();
        if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
        session.askedDoubts = true;
        return;
      }

      // se já perguntou dúvidas e o cliente manda “oi”/mensagem solta, não repete blocos
      const reply =
        "Perfeito. Se você quiser, me diz o que você tem em mente (ou manda a referência) e eu te oriento certinho por aqui.";
      if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
      return;
    }

    // fallback
    const fallback = msgInicio();
    if (!antiRepeat(session, fallback)) await zapiSendText(phone, fallback);
  } catch (err) {
    console.error("[ZAPI WEBHOOK ERROR]", err?.message || err);
  }
});

app.listen(Number(ENV.PORT), () => {
  console.log("Server running on port", ENV.PORT);
});
