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

      // triagem primeiro contato
      triageAsked: false,
      triageAttempts: 0,
      isOngoingWithOwner: null, // true/false

      // referência / info
      imageDataUrl: null,
      imageSummary: null,
      sizeLocation: null,
      bodyRegion: null,
      isCoverup: false,

      // fluxo
      sentSummary: false,
      askedDoubts: false,
      sentQuote: false,

      // sinal / agenda
      depositConfirmed: false,
      manualHandoff: false,
      finished: false,
      lastOwnerNotifyAt: 0,

      // controle de repetição
      lastReply: null,
      lastReplyAt: 0,

      // controle de insistência (pra não ficar pedindo referência infinito)
      askRefCount: 0,
      askInfoCount: 0,
      lastAskAt: 0,

      // preto e cinza
      awaitingBWAnswer: false,
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
function safeName(name) {
  const n = String(name || "").trim();
  if (!n) return "";
  if (n.length > 24) return n.slice(0, 24);
  if (/undefined|null|unknown/i.test(n)) return "";
  return n;
}

function pickOne(arr) {
  if (!Array.isArray(arr) || !arr.length) return null;
  return arr[Math.floor(Math.random() * arr.length)];
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
  // qualquer texto com número (ex: 10cm, 15x8, 20 cm)
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
    "perna", "pernas", "barriga", "abdomen", "abdômen", "biceps", "bíceps",
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
  if (/sim|aceito|pode|fechado|bora|ok|topo|manda|vamo|quero\s*preto|preto\s*e\s*cinza/i.test(t)) return "yes";
  if (/não|nao|prefiro\s*color|quero\s*color|não\s*quero\s*preto|nao\s*quero\s*preto|quero\s*colorida/i.test(t)) return "no";
  return "";
}

// comprovante confirmado só com FOTO (imageUrl) após orçamento
function detectDepositTextOnly(text) {
  const t = (text || "").toLowerCase();
  return /comprovante|pix\s*feito|pix\s*realizado|paguei|pago|transferi|transferência|transferencia|sinal|enviei\s*o\s*pix|mandei\s*o\s*pix|caiu\s*o\s*pix|confirmad/i.test(t);
}

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
  return /n[aã]o|nao|nenhuma|tudo\s*certo|tranquilo|fechado|sem\s*d[uú]vidas|ok|blz|beleza|deboa|de boa|suave/i.test(t);
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
- Não fale de horas nem preço/hora para o cliente (isso é interno).
- Antes de falar preço: explique o valor do trabalho (complexidade, sombras, transições, acabamento, encaixe).
- Você trabalha com whip shading (técnica limpa).
- Você não faz sessões acima de 7 horas; se passar disso, divide em 2+ sessões (sem falar horas).
- Pagamento: Pix, débito, crédito até 12x.
- Inclui 1 retoque se necessário em 40–50 dias.
- Parcelamento mensal existe: se o cliente não conseguir pagar de uma vez, pode dividir em sessões mensais (ajuste no total).
- Cobertura: peça foto da tattoo atual, mas deixe claro que vai analisar antes de confirmar.
- Criação: você faz criações exclusivas baseadas na referência e adapta ao corpo do cliente.
`).trim();

async function describeImageForClient(imageDataUrl) {
  const resp = await openai.chat.completions.create({
    model: "gpt-4o",
    temperature: 0.3,
    messages: [
      { role: "system", content: BASE_SYSTEM },
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              "Analise a referência e gere uma explicação curta, direta e profissional do que o projeto exige (sombras, transições, volume, contraste, acabamento, encaixe). NÃO fale de preço, NÃO fale de horas. 4 a 7 linhas. Linguagem humana, sem repetir palavras.",
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
          "Você é um tatuador experiente. Estime SOMENTE um número de horas (inteiro) para execução, considerando complexidade e as infos (tamanho/local OU apenas região). Responda APENAS com um número.",
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

// -------------------- Mensagens (sem "Perfeito" repetido) --------------------
function msgGreetingAndTriage(contactName) {
  const nm = safeName(contactName);
  const variants = [
    (name) =>
      `Oi${name ? `, ${name}` : ""}! Aqui é o DW.\n` +
      `Eu trabalho com realismo preto e cinza e whip shading, com acabamento bem limpo.\n\n` +
      `Antes de eu te orientar: é seu primeiro contato comigo? (sim/não)`,
    (name) =>
      `Olá${name ? `, ${name}` : ""}! Tudo certo?\n` +
      `Eu sou o DW — realismo black & grey e whip shading.\n\n` +
      `Só pra eu seguir certo contigo: é seu primeiro contato? Responde "sim" ou "não".`,
    (name) =>
      `E aí${name ? `, ${name}` : ""}! Aqui é o DW.\n` +
      `Trampo com realismo preto e cinza e um sombreamento bem fino.\n\n` +
      `Me confirma uma coisa: é o primeiro contato comigo? (sim/não)`,
  ];
  const fn = pickOne(variants) || variants[0];
  return fn(nm);
}

function detectFirstContactAnswer(text) {
  const t = (text || "").toLowerCase();

  // NÃO = já tem orçamento/atendimento andando com você
  if (/^n[aã]o$|^nao$/.test(t)) return "ongoing";
  if (/j[aá]\s*(tenho|tive|conversei|falei|estou\s*falando)|em\s*andamento|or[cç]amento\s*andando|j[aá]\s*tem/i.test(t)) return "ongoing";
  if (/or[cç]amento|atendimento|conversa\s*com\s*voc[eê]|já\s*conversamos/i.test(t) && /j[aá]/.test(t)) return "ongoing";

  // SIM = primeiro contato
  if (/^sim$/.test(t)) return "first";
  if (/primeir|1a\s*vez|primeira\s*vez|come[cç]ando|do\s*zero/i.test(t)) return "first";

  return "";
}

function msgTriageClarify() {
  return (
    `Só pra eu seguir certo contigo:\n\n` +
    `• Responde "sim" se é seu primeiro contato\n` +
    `• Responde "não" se já existe um orçamento/atendimento em andamento comigo`
  );
}

function msgEndereco() {
  return (
    "Endereço do estúdio:\n\n" +
    "• Av. Mauá, 1308 — próximo à rodoviária.\n" +
    "Se quiser, me diz seu bairro que eu te passo um ponto de referência pra facilitar."
  );
}

function msgPixDireto() {
  const pixLine = ENV.PIX_KEY ? ENV.PIX_KEY : "(chave pix não configurada no momento)";
  return (
    "Chave Pix pra sinal:\n\n" +
    `• ${pixLine}\n` +
    "• Sinal para reserva: *R$ 50*\n\n" +
    "Quando fizer, envia a *foto do comprovante* aqui que eu já confirmo e seguimos pra agenda."
  );
}

function msgSoBlackGrey() {
  return (
    "Só alinhando um detalhe importante:\n\n" +
    "• Eu trabalho com *preto e cinza (black & grey)*.\n" +
    "• Não faço tattoo totalmente colorida.\n\n" +
    "Se você curtir em preto e cinza, dá pra ficar com muita profundidade e contraste."
  );
}

function msgFinalizaPorNaoAceitarBW() {
  return (
    "Entendi.\n\n" +
    "Como eu trabalho só com *preto e cinza*, eu não vou conseguir te atender do jeito que você quer em colorido.\n" +
    "Se em algum momento você decidir fazer em black & grey, é só me chamar."
  );
}

function msgPedirReferenciaOuIdeia(session) {
  // 1ª tentativa: pede imagem + local + tamanho
  // 2ª tentativa: pede só o básico e avisa que vai analisar assim que receber
  const now = Date.now();
  session.lastAskAt = now;
  session.askRefCount += 1;

  if (session.askRefCount <= 1) {
    return (
      "Me manda uma referência em *imagem* (print/foto), se tiver.\n" +
      "E me diz também:\n" +
      "• onde no corpo\n" +
      "• tamanho aproximado (cm ou “do tamanho de uma mão”, por exemplo)\n\n" +
      "Aí eu já te retorno com o orçamento certinho."
    );
  }

  return (
    "Pra eu te passar um orçamento fiel, eu preciso só de 2 coisas:\n\n" +
    "• uma *imagem de referência* (se tiver)\n" +
    "• onde no corpo + tamanho aproximado\n\n" +
    "Assim que você mandar isso eu já sigo."
  );
}

function msgPedirLocalOuTamanho(session) {
  const now = Date.now();
  session.lastAskAt = now;
  session.askInfoCount += 1;

  if (session.askInfoCount <= 1) {
    return (
      "Boa — agora me confirma:\n" +
      "• onde no corpo você quer fazer\n" +
      "• tamanho aproximado\n\n" +
      "Se for cobertura, me avisa também."
    );
  }

  return (
    "Só falta eu saber:\n" +
    "• local no corpo\n" +
    "• tamanho aproximado\n\n" +
    "Com isso eu fecho teu orçamento."
  );
}

function msgDorResposta() {
  return (
    "Total — essa dúvida é normal.\n\n" +
    "A sensação varia bastante pela região e pela tolerância de cada um.\n" +
    "Geralmente é uma ardência/arranhado mais intenso.\n\n" +
    "Me diz a região do corpo que você quer fazer que eu te falo se costuma ser mais tranquilo ou mais sensível."
  );
}

function msgTempoResposta() {
  return (
    "Depende do tamanho e do nível de detalhe (transições, textura, contraste e acabamento).\n\n" +
    "Me diz onde no corpo + tamanho aproximado que eu te passo uma noção bem fiel."
  );
}

function msgPrecoAntesDoValor() {
  return (
    "Pra eu te passar um valor justo, eu preciso:\n\n" +
    "• referência em imagem (se tiver)\n" +
    "• onde no corpo\n" +
    "• tamanho aproximado\n\n" +
    "Com isso eu te retorno certinho."
  );
}

function msgHesitacaoResposta() {
  return (
    "Tranquilo.\n\n" +
    "O que tá pesando mais pra você agora: desenho, valor ou data?\n" +
    "Se você me disser o ponto principal, eu te oriento direto."
  );
}

function msgChecagemDuvidas() {
  const variants = [
    "Ficou alguma dúvida antes de eu te passar o investimento e as formas de pagamento?",
    "Quer tirar alguma dúvida do atendimento antes de eu te passar o investimento?",
    "Se tiver alguma dúvida rápida, manda agora. Se estiver tudo ok, eu já te passo o investimento e as formas de pagamento.",
  ];
  return pickOne(variants) || variants[0];
}

function msgOrcamentoCompleto(valor, sessoes) {
  const pixLine = ENV.PIX_KEY ? `• Chave Pix: ${ENV.PIX_KEY}\n` : "";
  return (
    `Pelo tamanho e complexidade do projeto, o investimento fica em *R$ ${valor}*.\n\n` +
    `• Pra ficar bem executado e cicatrizar redondo, eu organizo em *${sessoes} sessão(ões)*.\n` +
    "• Pagamento: Pix, débito ou crédito em até 12x.\n" +
    "• Inclui *1 retoque* (se necessário) entre 40 e 50 dias.\n\n" +
    "Pra reservar horário:\n" +
    "• sinal de *R$ 50*\n" +
    pixLine +
    "Depois é só enviar a *foto do comprovante* aqui que eu confirmo e seguimos pra agenda."
  );
}

function msgAguardandoComprovante() {
  const pixLine = ENV.PIX_KEY ? `• Chave Pix: ${ENV.PIX_KEY}\n` : "";
  return (
    "Certo.\n\n" +
    "Pra eu confirmar o agendamento, preciso da *foto do comprovante* aqui no Whats.\n" +
    pixLine +
    "Assim que chegar eu já sigo com a agenda."
  );
}

function msgPerguntaAgenda() {
  return (
    "Comprovante recebido.\n\n" +
    "Pra eu te encaixar do melhor jeito:\n" +
    "• você prefere horário *comercial* ou *pós-comercial*?\n" +
    "• tem alguma data específica livre?"
  );
}

function msgCuidadosPreSessao() {
  return (
    "Antes da sessão:\n\n" +
    "• se alimente bem\n" +
    "• hidrate bastante\n" +
    "• evite álcool no dia anterior\n\n" +
    "Isso ajuda no conforto e no resultado."
  );
}

function msgClosing() {
  const variants = [
    "Fechado. Qualquer ajuste ou dúvida, me chama por aqui.",
    "Combinado. Se surgir alguma dúvida até o dia, é só me chamar.",
    "Show. Tô por aqui se precisar de algo.",
  ];
  return pickOne(variants) || variants[0];
}

// -------------------- HANDOFF manual --------------------
async function handoffToManual(phone, session, motivo, mensagemCliente, silentToClient = false) {
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

  if (silentToClient) return;

  const reply = "Entendi. Vou analisar direitinho e te retorno em breve.";
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
      if (detectThanks(message) && !session.finished) {
        const reply = msgClosing();
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
        "Beleza — atendimento reiniciado.\n\n" +
        "Me manda uma referência em imagem (se tiver) e me diz onde no corpo + tamanho aproximado.";
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
      // só bloqueia se ainda não tem o mínimo pra orçamento
      if (!session.imageDataUrl || (!session.bodyRegion && !session.sizeLocation)) {
        const reply = msgPrecoAntesDoValor();
        if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
        return;
      }
    }

    // ✅ flags gerais
    if (detectCoverup(message)) session.isCoverup = true;

    const maybeRegion = extractBodyRegion(message);
    if (!session.bodyRegion && maybeRegion) session.bodyRegion = maybeRegion;

    const maybeSizeLoc = extractSizeLocation(message);
    if (!session.sizeLocation && maybeSizeLoc) session.sizeLocation = maybeSizeLoc;

    // ✅ intenção de colorido
    if (!session.finished && detectColorIntentByText(message)) {
      session.awaitingBWAnswer = true;
      const reply = msgSoBlackGrey();
      if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
      return;
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

    // ✅ comprovante por texto sem foto (após orçamento)
    const depositTextOnly = detectDepositTextOnly(message);
    const isAfterQuote = session.stage === "pos_orcamento" || session.sentQuote;

    if (!session.depositConfirmed && depositTextOnly && !imageUrl && isAfterQuote) {
      const reply = msgAguardandoComprovante();
      if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
      return;
    }

    // ✅ FOTO do comprovante após orçamento
    const depositByImageAfterQuote = Boolean(imageUrl) && isAfterQuote;

    if (!session.depositConfirmed && depositByImageAfterQuote) {
      session.depositConfirmed = true;
      session.stage = "agenda";

      await notifyOwner(
        [
          "⚠️ COMPROVANTE RECEBIDO (bot)",
          `• Cliente: ${String(phone).replace(/\D/g, "")}`,
          "• Próximo passo: você confirma agenda manualmente",
        ].join("\n")
      );

      const reply = [msgPerguntaAgenda(), "", msgCuidadosPreSessao()].join("\n\n");
      if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
      return;
    }

    // -------------------- FLUXO (SIMPLIFICADO e FUNCIONAL) --------------------

    // ✅ inicio -> manda saudação + triagem
    if (session.stage === "inicio") {
      const reply = msgGreetingAndTriage(contactName);
      if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
      session.stage = "triagem_primeiro_contato";
      return;
    }

    // ✅ triagem primeiro contato
    if (session.stage === "triagem_primeiro_contato") {
      const ans = detectFirstContactAnswer(message);

      if (!ans) {
        session.triageAttempts += 1;

        if (session.triageAttempts <= 1) {
          const reply = msgTriageClarify();
          if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
          return;
        }

        // se não respondeu claramente, handoff (melhor que ficar repetindo)
        await handoffToManual(phone, session, "Triagem sem resposta clara (sim/não)", message);
        return;
      }

      if (ans === "ongoing") {
        session.isOngoingWithOwner = true;

        // avisa você e cala o bot (silent)
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
        return;
      }

      // primeiro contato: segue normal
      session.isOngoingWithOwner = false;
      session.stage = "aguardando_referencia";

      const reply = msgPedirReferenciaOuIdeia(session);
      if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
      return;
    }

    // ✅ se está aguardando referência e NÃO tem imagem -> evita loop
    if (session.stage === "aguardando_referencia" && !session.imageDataUrl && !imageUrl) {
      // se o cliente ficar mandando texto aleatório sem mandar o básico, depois de 2 tentativas vira handoff
      if (session.askRefCount >= 2) {
        await handoffToManual(phone, session, "Cliente sem referência/infos após tentativas", message);
        return;
      }

      const reply = msgPedirReferenciaOuIdeia(session);
      if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
      return;
    }

    // ✅ imagem chegou (referência) — prioridade total
    if (imageUrl && !depositByImageAfterQuote) {
      try {
        const dataUrl = await fetchImageAsDataUrl(imageUrl, imageMime);
        session.imageDataUrl = dataUrl;
        session.imageSummary = await describeImageForClient(dataUrl);

        // se imagem indica colorido, alinha
        if (detectColorIntentBySummary(session.imageSummary)) {
          session.awaitingBWAnswer = true;
          const reply = msgSoBlackGrey();
          if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
          return;
        }

        // reset flags
        session.sentSummary = false;
        session.askedDoubts = false;
        session.sentQuote = false;

        session.stage = "aguardando_info";

        // se falta info básica, pede e para
        if (!session.bodyRegion || !session.sizeLocation) {
          const reply = msgPedirLocalOuTamanho(session);
          if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
          return;
        }
      } catch (e) {
        console.error("[IMG] failed:", e?.message || e);
        // se falhar download, melhor handoff do que bugado insistindo
        await handoffToManual(phone, session, "Falha ao baixar imagem", message);
        return;
      }
    }

    // ✅ aguardando_info: precisa de imagem + local + tamanho
    if (session.stage === "aguardando_info") {
      if (!session.imageDataUrl) {
        // se por algum motivo caiu aqui sem imagem, volta pra referência
        session.stage = "aguardando_referencia";
        const reply = msgPedirReferenciaOuIdeia(session);
        if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
        return;
      }

      if (!session.bodyRegion || !session.sizeLocation) {
        if (session.askInfoCount >= 2) {
          await handoffToManual(phone, session, "Faltou local/tamanho após tentativas", message);
          return;
        }
        const reply = msgPedirLocalOuTamanho(session);
        if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
        return;
      }

      // manda resumo 1x
      if (!session.sentSummary && session.imageSummary) {
        const intro =
          "Recebi a referência.\n\n" +
          "Pra esse projeto ficar bem executado, ele pede:\n\n" +
          session.imageSummary;

        if (!antiRepeat(session, intro)) await zapiSendText(phone, intro);
        session.sentSummary = true;
      }

      // pergunta dúvida 1x
      if (!session.askedDoubts) {
        const reply = msgChecagemDuvidas();
        if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
        session.askedDoubts = true;
        session.stage = "aguardando_duvidas";
        return;
      }

      session.stage = "aguardando_duvidas";
      return;
    }

    // ✅ dúvidas -> orçamento
    if (session.stage === "aguardando_duvidas") {
      if (answeredNoDoubts(message)) {
        const infoParaCalculo = session.sizeLocation || `Região: ${session.bodyRegion || "não informado"}`;

        const hours = await estimateHoursInternal(session.imageDataUrl, infoParaCalculo, session.isCoverup);
        const sessoes = sessionsFromHours(hours);
        const valor = calcPriceFromHours(hours);

        const quote = msgOrcamentoCompleto(valor, sessoes);
        if (!antiRepeat(session, quote)) await zapiSendText(phone, quote);

        session.sentQuote = true;
        session.stage = "pos_orcamento";
        return;
      }

      // se perguntou dor/tempo/preço/hesitação, responde e mantém no fluxo
      if (pain) {
        const reply = msgDorResposta();
        if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
        return;
      }
      if (timeAsk) {
        const reply = msgTempoResposta();
        if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
        return;
      }
      if (priceAsk) {
        // já tem base, então só orienta: "se estiver ok eu passo o investimento"
        const reply =
          "Consigo te passar certinho sim.\n" +
          "Se estiver tudo alinhado, me confirma que tá ok que eu já te passo o investimento e formas de pagamento.";
        if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
        return;
      }
      if (hes) {
        const reply = msgHesitacaoResposta();
        if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
        return;
      }

      // qualquer coisa fora, melhor handoff do que bot burro repetindo
      await handoffToManual(phone, session, "Mensagem fora do fluxo (dúvidas)", message);
      return;
    }

    // ✅ pós orçamento
    if (session.stage === "pos_orcamento") {
      if (/fech|vamos|bora|quero|ok|topo|pode marcar|vou fazer|vamo fechar/i.test(lower)) {
        const pixLine = ENV.PIX_KEY ? `• Chave Pix: ${ENV.PIX_KEY}\n` : "";
        const reply =
          "Beleza — pra reservar teu horário:\n\n" +
          "• sinal de *R$ 50*\n" +
          pixLine +
          "Depois é só enviar a *foto do comprovante* aqui que eu confirmo e seguimos pra agenda.";
        if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
        return;
      }

      if (/mensal|por mês|dividir|parcelar por mês/i.test(lower)) {
        const reply =
          "Dá pra organizar sim.\n\n" +
          "Eu consigo montar em *sessões mensais* quando fica pesado pagar tudo de uma vez.\n" +
          "Me diz em quantos meses você prefere que eu te proponho o formato certinho.";
        if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
        return;
      }

      // se o cliente mandou info nova, volta pra ajuste (sem spam)
      if (maybeRegion || maybeSizeLoc) {
        session.sentSummary = false;
        session.askedDoubts = false;
        session.sentQuote = false;
        session.stage = "aguardando_info";
        const reply = "Show — com essa informação eu ajusto certinho. Só um instante.";
        if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
        return;
      }

      await handoffToManual(phone, session, "Mensagem fora do configurado (pós orçamento)", message);
      return;
    }

    // ✅ agenda (após comprovante): capta preferência e te chama
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

        const reply =
          "Fechado — vou confirmar aqui e já te retorno com as opções.\n\n" +
          msgCuidadosPreSessao();
        if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
        return;
      }

      // se não respondeu o que precisa, pergunta só uma vez e se insistir -> handoff
      await handoffToManual(phone, session, "Agenda sem resposta útil", message);
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
