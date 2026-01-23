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

      // referência
      imageDataUrl: null,   // data:image/...;base64,...
      imageSummary: null,   // descrição técnica pro cliente (curta)
      sizeLocation: null,   // "25cm no antebraço" (opcional)
      bodyRegion: null,     // "costela", "pescoço", "mão" etc (aceita sem cm)
      isCoverup: false,

      // perfil do cliente (arquiteto / explorador / sonhador)
      clientProfile: null,
      greeted: false,
      greetVariant: null,       // fixa 1 variação por cliente
      closingVariant: null,     // fixa 1 variação por cliente

      // FLAGS pra não repetir
      sentProfileMsg: false,
      sentNeedRefMsg: false,
      sentSummary: false,
      askedDoubts: false,
      sentPayments: false,
      sentQuote: false,

      // etapa de sinal/agenda
      depositConfirmed: false,      // confirmado SOMENTE por foto do comprovante (imageUrl) após orçamento
      askedSchedule: false,
      scheduleCaptured: false,      // cliente já respondeu (comercial/pós e/ou data)
      manualHandoff: false,         // daqui pra frente você assume manualmente

      // controle de estilo/encerramento
      awaitingBWAnswer: false,
      finished: false,

      // fallback manual
      manualPending: false,

      // anti loop básico
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

// ✅ Notificação no seu Whats (OWNER_PHONE)
async function notifyOwner(text) {
  if (!ENV.OWNER_PHONE) return;
  try {
    await zapiSendText(ENV.OWNER_PHONE, text);
  } catch (e) {
    console.log("[OWNER NOTIFY FAIL]", e?.message || e);
  }
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

  // (nome do contato) – raramente vem no webhook; se não vier, fica null
  const contactName =
    body?.senderName ||
    body?.pushName ||
    body?.data?.senderName ||
    body?.data?.pushName ||
    body?.name ||
    null;

  return {
    phone: phone ? String(phone) : null,
    message: String(message || "").trim(),
    imageUrl: imageUrl ? String(imageUrl) : null,
    imageMime: String(imageMime || "image/jpeg"),
    fromMe,
    messageType: String(messageType || ""),
    contactName: contactName ? String(contactName) : null,
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
function pickOne(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function safeName(name) {
  if (!name) return "";
  const n = String(name).trim();
  if (!n) return "";
  // evita nomes gigantes / lixo
  return n.length > 24 ? n.slice(0, 24) : n;
}

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

// ✅ IMPORTANTE: comprovante confirmado só com FOTO (imageUrl) após orçamento
function detectDepositTextOnly(text) {
  const t = (text || "").toLowerCase();
  return /comprovante|pix\s*feito|pix\s*realizado|paguei|pago|transferi|transferência|transferencia|sinal|enviei\s*o\s*pix|mandei\s*o\s*pix|caiu\s*o\s*pix|confirmad/i.test(t);
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
  return /obrigad|valeu|tmj|agradeço|fechou|show|top|blz|beleza|muito\s*obrigad/i.test(t);
}

// ✅ Black & Grey only: detect cor no texto
function detectColorIntentByText(text) {
  const t = (text || "").toLowerCase();
  return /colorid|color|cores|vermelh|azul|amarel|verde|roxo|rosa|laranj|aquarel|new\s*school/i.test(t);
}

// ✅ tenta inferir "colorida" pela descrição (se a IA mencionar)
function detectColorIntentBySummary(summary) {
  const s = (summary || "").toLowerCase();
  return /colorid|cores|color|tinta\s*colorida/i.test(s);
}

// ✅ detecta resposta do cliente sobre aceitar black&grey
function detectBWAccept(text) {
  const t = (text || "").toLowerCase();
  if (/\b(sim|aceito|pode|fechado|bora|ok|topo|manda|vamo|vamos|preto\s*e\s*cinza|black)\b/i.test(t)) return "yes";
  if (/\b(não|nao|prefiro\s*color|quero\s*color|não\s*quero\s*preto|nao\s*quero\s*preto|colorido)\b/i.test(t)) return "no";
  return "";
}

// ✅ extrai preferências de agenda
function detectCommercialPref(text) {
  const t = (text || "").toLowerCase();
  if (/(p[oó]s|pos)[ -]?comercial|noite|ap[oó]s\s*o\s*trabalho|depois\s*do\s*trabalho/i.test(t)) return "pos";
  if (/comercial|manh[aã]|tarde|hor[aá]rio\s*comercial/i.test(t)) return "comercial";
  return "";
}

function detectNoSpecificDate(text) {
  const t = (text || "").toLowerCase();
  return /pr[oó]xim[ao]\s*(hor[aá]rio|data)\s*(livre|dispon[ií]vel)|qualquer\s*data|pr[oó]xima\s*data|pode\s*marcar\s*no\s*pr[oó]ximo|o\s*que\s*voc[eê]\s*tiver|sem\s*data|qualquer\s*hor[aá]rio/i.test(t);
}

function detectHasSpecificDate(text) {
  const t = (text || "").toLowerCase();
  return /(\d{1,2}\/\d{1,2})|(\d{1,2}\-\d{1,2})|dia\s*\d{1,2}|(segunda|ter[cç]a|quarta|quinta|sexta|s[aá]bado|domingo)/i.test(t);
}

// ✅ Dúvidas / objeções comuns
function askedPain(text) {
  const t = (text || "").toLowerCase();
  return /d[oó]i|dor|dói\s*muito|aguenta|anestesi|medo/i.test(t);
}
function askedTime(text) {
  const t = (text || "").toLowerCase();
  return /quanto\s*tempo|demora|dura|sess[aã]o\s*quanto|termina\s*em/i.test(t);
}
function askedPrice(text) {
  const t = (text || "").toLowerCase();
  return /quanto\s*custa|valor|pre[cç]o|or[cç]amento|investimento/i.test(t);
}
function askedHesitation(text) {
  const t = (text || "").toLowerCase();
  return /vou\s*pensar|te\s*aviso|depois\s*eu\s*vejo|talvez|vou\s*ver|preciso\s*ver|vou\s*analisar/i.test(t);
}
function answeredNoDoubts(text) {
  const t = (text || "").toLowerCase();
  return /\b(n[aã]o|não)\b.*\b(d[uú]vida|duvida)\b|\bsem\s*d[uú]vida\b|\bt[aá]\s*tranquilo\b|\btranquilo\b|\bde\s*boa\b|\btudo\s*certo\b/i.test(t);
}
function answeredHasDoubts(text) {
  const t = (text || "").toLowerCase();
  return /\btenho\b.*\b(d[uú]vida|duvida)\b|\bcom\s*d[uú]vida\b|\buma\s*d[uú]vida\b/i.test(t);
}

// ✅ Perfil do cliente (arquiteto/explorador/sonhador)
function classifyClientProfile(text, hasImage) {
  const t = (text || "").toLowerCase().trim();

  // se já mandou imagem, tende ao "arquiteto" (trouxe referência)
  const architectSignals = /refer[eê]ncia|igual|parecido|mesmo\s*estilo|pinterest|instagram|artista|pose|ângulo|realista|fine\s*line|black\s*&\s*grey|whip|contraste|detalhe|sombr|estilo/i;
  const explorerSignals = /quero\s*(um|uma)|ideia|animal|m[ií]stic|simbol|caveira|le[aã]o|tigre|anjo|olho|retrato|rosto|feminina|jesus|cruz|cora[cç][aã]o/i;
  const dreamerSignals = /liberdade|for[cç]a|supera[cç][aã]o|fam[ií]lia|luto|fe|prop[oó]sito|recome[cç]o|significado|sentimento|fase|hist[oó]ria|mem[oó]ria|represent/i;

  if (hasImage) return "arquiteto";
  if (architectSignals.test(t) && t.length > 20) return "arquiteto";
  if (dreamerSignals.test(t) && !architectSignals.test(t)) return "sonhador";
  if (explorerSignals.test(t)) return "explorador";
  return null;
}

// ✅ Manual fallback (quando não temos config)
async function handoffToManual(phone, session, reason, messagePreview) {
  session.manualPending = true;
  session.manualHandoff = true;
  session.stage = "manual_pendente";

  await notifyOwner(
    [
      "⚠️ ATENDIMENTO PARA ASSUMIR (bot)",
      `• Cliente: ${String(phone).replace(/\D/g, "")}`,
      `• Motivo: ${reason}`,
      `• Mensagem: ${(messagePreview || "").slice(0, 220)}`,
    ].join("\n")
  );

  const reply =
    "Perfeito.\n\n" +
    "• Vou analisar e em breve te respondo por aqui.";
  if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
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
Você é um tatuador profissional atendendo no WhatsApp (tom humano, gente boa e profissional).
Regras:
- Nunca diga que é IA.
- Não assine mensagem.
- Não fale de horas nem preço/hora para o cliente (isso é interno).
- Use parágrafos curtos e mensagens didáticas.
- Informações importantes começam com "• ".
- Antes de falar valor: explique o valor do trabalho (complexidade, sombras, transições, acabamento, encaixe).
- Você trabalha com realismo preto e cinza (black & grey) e whip shading.
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
    temperature: 0.4,
    messages: [
      { role: "system", content: BASE_SYSTEM },
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              "Analise a referência e gere uma explicação curta e profissional do que o projeto exige (sombras, transições, volume, contraste, acabamento, encaixe). NÃO fale de preço, NÃO fale de horas. Não enfeite demais. 5 a 8 linhas no máximo.",
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

// -------------------- Mensagens (variações) --------------------
const GREETINGS = [
  (name) =>
    `Olá${name ? `, ${name}` : ""}! Aqui é o DW Tatuador, especializado em realismo preto e cinza e whip shading.\n\n` +
    "Fico feliz em receber sua mensagem! Conta pra mim: qual é a sua ideia pra transformarmos em arte na pele?\n\n" +
    "• Pra eu te orientar certinho, me manda a referência em *imagem*.\n" +
    "• Me diz também *onde no corpo* você quer fazer.\n" +
    "• Se souber o *tamanho aproximado*, melhor — mas se não souber, sem problema.",
  (name) =>
    `Opa${name ? `, ${name}` : ""}! Tudo certo?\n\n` +
    "Aqui é o DW. Eu trabalho com realismo preto e cinza (black & grey) e whip shading.\n\n" +
    "Me diz sua ideia e o que você quer representar nessa tattoo.\n\n" +
    "• Me manda a referência em *imagem*.\n" +
    "• E me fala *onde no corpo* você quer fazer.\n" +
    "• Se tiver noção de tamanho, manda também.",
  (name) =>
    `Ei${name ? `, ${name}` : ""}! Bem-vindo(a).\n\n` +
    "Sou o DW, tatuador focado em realismo preto e cinza com whip shading.\n\n" +
    "Conta pra mim: qual é a ideia principal da sua tattoo?\n\n" +
    "• Me envia a referência em *imagem*.\n" +
    "• Local no corpo.\n" +
    "• Tamanho aproximado (se souber).",
];

const CLOSINGS = [
  () =>
    "Perfeito.\n\n" +
    "• Qualquer dúvida sobre o atendimento, é só me chamar que eu te respondo por aqui.\n" +
    "• Se precisar remarcar, tranquilo — só peço *aviso com 48h de antecedência*.\n\n" +
    "Obrigado por confiar no meu trabalho. Agora é só chegar no dia e a gente faz um trampo bem forte e bem executado.",
  () =>
    "Fechado!\n\n" +
    "• Se pintar qualquer dúvida até o dia, me chama aqui.\n" +
    "• Pra remarcação, só peço *48h de antecedência* pra eu conseguir reorganizar a agenda.\n\n" +
    "Obrigado pela confiança — vai ficar insano.",
  () =>
    "Combinado.\n\n" +
    "• Se tiver qualquer dúvida, estou à disposição.\n" +
    "• Remarcação: me avisa com *48h de antecedência*.\n\n" +
    "Obrigado por fechar comigo — vai ser uma experiência top e um resultado de alto nível.",
];

// -------------------- Replies fixas --------------------
function msgCriacao() {
  return (
    "Sim — eu faço *criações exclusivas*.\n\n" +
    "• A referência serve como base.\n" +
    "• Eu adapto a composição pro teu corpo (encaixe, proporção e leitura), mantendo o estilo do meu trabalho."
  );
}

function msgCoberturaPedirFoto() {
  return (
    "Sobre *cobertura*: me manda uma foto bem nítida da tattoo atual (de perto e de um pouco mais longe).\n\n" +
    "• Só pra ser transparente: eu *raramente* pego cobertura, porque meu estilo (whip shading) é bem limpo e delicado e, na maioria dos casos, cobertura não entrega o resultado que eu gosto de entregar.\n\n" +
    "Me manda a foto que eu analiso e te falo com sinceridade se dá pra fazer ou não."
  );
}

function msgPedirLocalOuTamanho() {
  return (
    "Perfeito.\n\n" +
    "• Me confirma só *o local no corpo* (ex: costela, pescoço, mão, antebraço).\n" +
    "• E, se souber, o *tamanho aproximado*.\n\n" +
    "Se não souber em cm, pode falar do jeito que você imagina que eu consigo estimar por aqui."
  );
}

function msgEndereco() {
  return (
    "Claro.\n\n" +
    "• Endereço: *Av. Mauá, 1308* — próximo à rodoviária.\n" +
    "• É um estúdio *privado e aconchegante*, pensado pra você ter uma experiência confortável e focada no resultado."
  );
}

function msgSoBlackGrey() {
  return (
    "Perfeito — só um detalhe importante pra alinhar direitinho.\n\n" +
    "• Eu trabalho com *black & grey* (preto e cinza).\n" +
    "• Não faço tattoo totalmente colorida — no máximo *pequenos detalhes* (ex: olhos ou pontos específicos), quando combina com o projeto.\n\n" +
    "Se você curtir a ideia em preto e cinza, eu sigo e deixo o desenho com muita profundidade e contraste."
  );
}

function msgFinalizaPorNaoAceitarBW() {
  return (
    "Entendi.\n\n" +
    "• Como eu trabalho exclusivamente com *black & grey*, não vou conseguir te atender do jeito que você quer em colorido.\n\n" +
    "Obrigado por me chamar e fico à disposição caso você decida fazer em preto e cinza no futuro."
  );
}

function msgChecagemDuvidas() {
  return (
    "Perfeito.\n\n" +
    "• Ficou alguma dúvida sobre o atendimento?\n" +
    "Se não ficou, me confirma aqui que eu já te passo o investimento e as formas de pagamento."
  );
}

function msgPagamentos() {
  return (
    "• Pagamento:\n" +
    "• Pix\n" +
    "• Débito\n" +
    "• Crédito em até 12x\n\n" +
    "• O orçamento já inclui *1 sessão de retoque* (se necessário) entre 40 e 50 dias após cicatrização.\n\n" +
    "Se ficar pesado pagar tudo de uma vez, dá pra fazer em *sessões mensais* (com ajuste no total)."
  );
}

function msgFechamentoValor(valor, sessoes) {
  const pixLine = ENV.PIX_KEY ? `• Chave Pix: ${ENV.PIX_KEY}\n` : "";
  return (
    `Pelo tamanho e complexidade do que você me enviou, o investimento fica em *R$ ${valor}*.\n\n` +
    `• Pra manter qualidade e cicatrização correta, eu organizo esse projeto em *${sessoes} sessão(ões)*.\n\n` +
    msgPagamentos() +
    "\n\n" +
    "• Pra reservar o horário eu peço um *sinal de R$ 50*.\n" +
    pixLine +
    "• Assim que você *enviar a foto do comprovante* aqui, eu confirmo o agendamento e seguimos pra agenda."
  );
}

function msgPixDireto() {
  const pixLine = ENV.PIX_KEY ? ENV.PIX_KEY : "(chave pix não configurada no momento)";
  return (
    "Perfeito.\n\n" +
    `• Chave Pix: ${pixLine}\n` +
    "• Sinal para reserva: *R$ 50*\n\n" +
    "Assim que você enviar a *foto do comprovante* aqui, eu confirmo e seguimos pra agenda."
  );
}

function msgAguardandoComprovante() {
  const pixLine = ENV.PIX_KEY ? `• Chave Pix: ${ENV.PIX_KEY}\n` : "";
  return (
    "Perfeito.\n\n" +
    "• Pra eu confirmar o agendamento, eu preciso da *foto do comprovante* aqui no Whats.\n" +
    pixLine +
    "Assim que chegar, eu já sigo com a agenda."
  );
}

function msgPerguntaAgenda() {
  return (
    "Perfeito — comprovante recebido.\n\n" +
    "• Pra eu agendar do melhor jeito pra você:\n" +
    "• Você prefere horário *comercial* ou *pós-comercial*?\n" +
    "• Você tem alguma data específica livre?\n\n" +
    "Se você não tiver uma data em mente, eu posso te colocar no *próximo horário disponível* e já te retorno com as opções."
  );
}

function msgVouVerificarAgendaSemData() {
  return (
    "Fechado.\n\n" +
    "• Vou verificar minha agenda agora.\n" +
    "• Em instantes eu te retorno com as *próximas datas e horários disponíveis* pra você escolher."
  );
}

function msgVouVerificarAgendaComData() {
  return (
    "Perfeito.\n\n" +
    "• Vou verificar na agenda se essa data está disponível.\n" +
    "• Em instantes eu te retorno confirmando as opções de *data e horário* da sua sessão."
  );
}

function msgCuidadosPreSessao() {
  return (
    "• Cuidados pré-sessão (pra sua pele responder bem e a experiência ser melhor):\n\n" +
    "• Beba bastante água no dia anterior e no dia da sessão.\n" +
    "• Hidrate a pele da região (creme hidratante comum) por alguns dias antes.\n" +
    "• Evite álcool no dia anterior.\n" +
    "• Se alimente bem antes de vir (refeição completa).\n\n" +
    "Isso ajuda na resistência, no conforto durante a sessão e no resultado final."
  );
}

// ✅ scripts por perfil
function msgPerfilArquiteto() {
  return (
    "Perfeito! Me envia tudo que você já tem em mente: fotos, desenhos, referências de estilo, ou até textos que te inspiram.\n\n" +
    "• Quanto mais detalhes, melhor eu consigo visualizar e adaptar à sua pele.\n" +
    "• O que te atraiu nessas referências?"
  );
}

function msgPerfilExplorador() {
  return (
    "Maravilha! Ter um ponto de partida já é meio caminho andado.\n\n" +
    "• Me descreve um pouco mais sobre essa ideia.\n" +
    "• O que ela representa pra você?\n" +
    "• Tem algum elemento específico que não pode faltar?"
  );
}

function msgPerfilSonhador() {
  return (
    "Que ótimo que você está explorando essa ideia.\n\n" +
    "• Me ajuda com palavras-chave: sentimentos, símbolos, memórias, algo que essa tattoo precisa carregar.\n" +
    "• Não precisa ter desenho pronto — a gente constrói isso juntos.\n\n" +
    "O que isso significa pra você de forma *visual*?"
  );
}

// ✅ objeções
function msgDorResposta() {
  return (
    "Entendo perfeitamente sua preocupação com a dor — é uma dúvida muito comum.\n\n" +
    "• A sensação varia de pessoa pra pessoa e da área do corpo.\n" +
    "• A maioria descreve como um desconforto suportável, mais como uma ardência/arranhão intenso do que uma dor insuportável.\n" +
    "• Eu trabalho num ritmo que ajuda a minimizar esse incômodo e faço pausas quando precisar.\n\n" +
    "Se você me disser a área que pensa em tatuar, eu te falo quais regiões costumam ser mais tranquilas."
  );
}

function msgTempoResposta() {
  return (
    "Boa pergunta.\n\n" +
    "• O tempo varia conforme tamanho e nível de detalhe.\n" +
    "• Projetos mais simples costumam ir em uma sessão, e os mais detalhados podem pedir mais de uma.\n\n" +
    "Meu foco é sempre garantir qualidade e o seu conforto, sem correr etapa.\n" +
    "Me confirma a ideia e a região do corpo que eu te passo um panorama bem alinhado."
  );
}

function msgPrecoAntesDoValor() {
  return (
    "Fechado — eu te passo o investimento certinho.\n\n" +
    "• Só que antes, pra ser justo com você, eu preciso entender referência + local + tamanho.\n" +
    "• Assim eu consigo te orientar pelo *nível de complexidade* e entregar um resultado que vale o investimento.\n\n" +
    "Me manda a referência em imagem e me diz onde no corpo você quer fazer."
  );
}

function msgHesitacaoResposta() {
  return (
    "Compreendo perfeitamente — uma tattoo é uma decisão importante e é ótimo pensar com calma.\n\n" +
    "• Pra eu te ajudar melhor: tem algo específico te deixando em dúvida?\n" +
    "• É sobre o design, o investimento, ou a data?\n\n" +
    "Se você tiver uma data preferencial, me avisa porque a agenda costuma preencher rápido."
  );
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

    // ✅ comando reset/reiniciar atendimento
    if (/^reset$|^reiniciar$|^reinicia$|^começar\s*novamente$|^comecar\s*novamente$/i.test(lower)) {
      resetSession(phone);
      const s2 = getSession(phone);
      const name = safeName(contactName);
      s2.greetVariant = pickOne(GREETINGS);
      s2.closingVariant = pickOne(CLOSINGS);
      const reply =
        "Perfeito.\n\n" +
        "• Atendimento reiniciado.\n\n" +
        (s2.greetVariant ? s2.greetVariant(name) : "") ;
      if (!antiRepeat(s2, reply)) await zapiSendText(phone, reply);
      s2.stage = "aguardando_referencia";
      s2.greeted = true;
      return;
    }

    // ✅ se já está em handoff manual, não responde mais (evita bagunçar ordem)
    if (session.manualHandoff && session.stage === "manual_pendente") return;

    // ✅ endereço
    if (askedAddress(message)) {
      const reply = msgEndereco();
      if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
      return;
    }

    // ✅ se cliente pedir pix
    if (askedPix(message)) {
      const reply = msgPixDireto();
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

    // define perfil do cliente cedo (quando ele responde qualquer coisa relevante)
    if (!session.clientProfile) {
      const prof = classifyClientProfile(message, Boolean(imageUrl));
      if (prof) session.clientProfile = prof;
    }

    // se falar de colorido em texto (alinha black & grey)
    if (!session.finished && detectColorIntentByText(message)) {
      session.awaitingBWAnswer = true;
      const reply = msgSoBlackGrey();
      if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
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

    // se está aguardando resposta de black & grey
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
      }
    }

    // confirmação por TEXTO sem foto: avisa que precisa da foto do comprovante
    const depositTextOnly = detectDepositTextOnly(message);
    const isAfterQuote = session.stage === "pos_orcamento" || session.sentQuote;

    if (!session.depositConfirmed && depositTextOnly && !imageUrl && isAfterQuote) {
      const reply = msgAguardandoComprovante();
      if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
      return;
    }

    // FOTO do comprovante (image) após orçamento => confirma e pergunta agenda + notifica OWNER
    const depositByImageAfterQuote = Boolean(imageUrl) && isAfterQuote;

    if (!session.depositConfirmed && depositByImageAfterQuote) {
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

    // imagem chegou (referência) -> salva e gera resumo
    if (imageUrl) {
      try {
        const dataUrl = await fetchImageAsDataUrl(imageUrl, imageMime);
        session.imageDataUrl = dataUrl;

        session.imageSummary = await describeImageForClient(dataUrl);

        // se a descrição indicar “colorida”, valida black & grey
        if (detectColorIntentBySummary(session.imageSummary)) {
          session.awaitingBWAnswer = true;
          const reply = msgSoBlackGrey();
          if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
        }

        // Nova referência: reseta flags pra manter ORDEM correta
        session.sentSummary = false;
        session.askedDoubts = false;
        session.sentPayments = false;
        session.sentQuote = false;

        // mantém perfil
        if (!session.clientProfile) session.clientProfile = "arquiteto";

        session.stage = "aguardando_info";
      } catch (e) {
        console.error("[IMG] failed:", e?.message || e);
      }
    }

    // ========== ORDEM DO FLUXO ==========
    // 1) Saudação (1 variação) -> pede referência/local/tamanho
    // 2) Perfil (arquiteto/explorador/sonhador) -> mensagem do perfil
    // 3) Recebe imagem + infos -> resumo técnico (valor do trabalho)
    // 4) Pergunta dúvidas
    // 5) Tira dúvidas (dor/tempo/preço/hesitação) e volta pra "dúvidas"
    // 6) Se sem dúvidas -> envia pagamentos + investimento + sinal
    // 7) Comprovante por FOTO -> agenda -> captura preferências -> handoff manual
    // 8) Finalização só após comprovante + você confirmar manualmente e o cliente agradecer

    // --------- fluxo inicial (saudação) ---------
    if (session.stage === "inicio") {
      const name = safeName(contactName);
      if (!session.greetVariant) session.greetVariant = pickOne(GREETINGS);
      if (!session.closingVariant) session.closingVariant = pickOne(CLOSINGS);

      const reply = session.greetVariant ? session.greetVariant(name) : GREETINGS[0](name);
      if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);

      session.stage = "aguardando_referencia";
      session.greeted = true;
      return;
    }

    // --------- aguardando referência (sem imagem) ---------
    if (session.stage === "aguardando_referencia") {
      // se o cliente ainda não mandou imagem
      if (!session.imageDataUrl) {
        // se perguntou preço cedo
        if (askedPrice(message)) {
          const reply = msgPrecoAntesDoValor();
          if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
          return;
        }

        // classifica perfil e manda script do perfil (uma vez), sem travar o pedido da imagem
        if (!session.sentProfileMsg && !session.imageDataUrl) {
          if (!session.clientProfile) session.clientProfile = classifyClientProfile(message, false);
          const prof = session.clientProfile;

          let profMsg = "";
          if (prof === "arquiteto") profMsg = msgPerfilArquiteto();
          else if (prof === "explorador") profMsg = msgPerfilExplorador();
          else if (prof === "sonhador") profMsg = msgPerfilSonhador();

          if (profMsg) {
            if (!antiRepeat(session, profMsg)) await zapiSendText(phone, profMsg);
            session.sentProfileMsg = true;
          }
        }

        // reforça pedido da referência (uma vez)
        if (!session.sentNeedRefMsg) {
          const reply =
            "• Me manda a referência em *imagem* pra eu avaliar certinho.\n" +
            "• E me diz *onde no corpo* você quer fazer.\n" +
            "• Se tiver noção de tamanho, me fala também.";
          if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
          session.sentNeedRefMsg = true;
        }

        return;
      }

      // se já tem imagem, vai pra infos
      session.stage = "aguardando_info";
    }

    // --------- com imagem, mas faltam infos mínimas ---------
    if (session.imageDataUrl && session.stage === "aguardando_info") {
      if (!session.bodyRegion && !session.sizeLocation) {
        const reply = msgPedirLocalOuTamanho();
        if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
        return;
      }

      // 3) resumo técnico (uma vez)
      if (!session.sentSummary && session.imageSummary) {
        const intro =
          "Perfeito, recebi a referência.\n\n" +
          "• Antes de falar de investimento, deixa eu te explicar o que esse projeto exige pra ficar bem feito:\n\n" +
          session.imageSummary;

        if (!antiRepeat(session, intro)) await zapiSendText(phone, intro);
        session.sentSummary = true;

        // depois do resumo, vai pra etapa de dúvidas
        const dq = msgChecagemDuvidas();
        if (!antiRepeat(session, dq)) await zapiSendText(phone, dq);
        session.askedDoubts = true;
        session.stage = "pos_resumo_duvidas";
        return;
      }

      // se por algum motivo não tem summary (falhou IA), pergunta dúvidas mesmo assim e segue
      if (!session.askedDoubts) {
        const dq = msgChecagemDuvidas();
        if (!antiRepeat(session, dq)) await zapiSendText(phone, dq);
        session.askedDoubts = true;
        session.stage = "pos_resumo_duvidas";
        return;
      }
    }

    // --------- etapa de dúvidas (antes do orçamento) ---------
    if (session.stage === "pos_resumo_duvidas") {
      // se o cliente agradece ou fala "sem dúvida" -> libera orçamento
      if (answeredNoDoubts(message)) {
        // calcula orçamento agora (somente quando liberar)
        const infoParaCalculo =
          session.sizeLocation ||
          (session.bodyRegion ? `Região do corpo: ${session.bodyRegion} (tamanho não informado)` : "não informado");

        const hours = await estimateHoursInternal(session.imageDataUrl, infoParaCalculo, session.isCoverup);
        const sessoes = sessionsFromHours(hours);
        const valor = calcPriceFromHours(hours);

        // manda orçamento completo (pagamentos + sinal)
        const final = msgFechamentoValor(valor, sessoes);
        if (!antiRepeat(session, final)) await zapiSendText(phone, final);

        session.sentPayments = true;
        session.sentQuote = true;
        session.stage = "pos_orcamento";
        return;
      }

      // se disse que tem dúvidas ou fez pergunta => responde conforme categoria e volta a perguntar
      if (answeredHasDoubts(message) || askedPain(message) || askedTime(message) || askedPrice(message) || askedHesitation(message)) {
        if (askedPain(message)) {
          const r = msgDorResposta();
          if (!antiRepeat(session, r)) await zapiSendText(phone, r);
        } else if (askedTime(message)) {
          const r = msgTempoResposta();
          if (!antiRepeat(session, r)) await zapiSendText(phone, r);
        } else if (askedPrice(message)) {
          const r = msgPrecoAntesDoValor();
          if (!antiRepeat(session, r)) await zapiSendText(phone, r);
        } else if (askedHesitation(message)) {
          const r = msgHesitacaoResposta();
          if (!antiRepeat(session, r)) await zapiSendText(phone, r);
        } else {
          // dúvida genérica: chama manual
          await handoffToManual(phone, session, "Dúvida não mapeada (pré-orçamento)", message);
          return;
        }

        const dq = msgChecagemDuvidas();
        if (!antiRepeat(session, dq)) await zapiSendText(phone, dq);
        return;
      }

      // resposta não reconhecida nessa etapa => manual
      await handoffToManual(phone, session, "Resposta fora do fluxo (pré-orçamento)", message);
      return;
    }

    // ======= PART 1 END =======
    // (continua na Parte 2: pós_orcamento, agenda, finalização, fallback final e app.listen)
  } catch (err) {
    console.error("[ZAPI WEBHOOK ERROR]", err?.message || err);
  }
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

    // ✅ comando reset/reiniciar atendimento
    if (/^reset$|^reiniciar$|^reinicia$|^começar\s*novamente$|^comecar\s*novamente$/i.test(lower)) {
      resetSession(phone);
      const s2 = getSession(phone);
      const name = safeName(contactName);
      s2.greetVariant = pickOne(GREETINGS);
      s2.closingVariant = pickOne(CLOSINGS);
      const reply =
        "Perfeito.\n\n" +
        "• Atendimento reiniciado.\n\n" +
        (s2.greetVariant ? s2.greetVariant(name) : "");
      if (!antiRepeat(s2, reply)) await zapiSendText(phone, reply);
      s2.stage = "aguardando_referencia";
      s2.greeted = true;
      return;
    }

    // ✅ se já está em handoff manual, não responde mais (evita bagunçar ordem)
    if (session.manualHandoff && session.stage === "manual_pendente") return;

    // ✅ endereço
    if (askedAddress(message)) {
      const reply = msgEndereco();
      if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
      return;
    }

    // ✅ se cliente pedir pix
    if (askedPix(message)) {
      const reply = msgPixDireto();
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

    // define perfil do cliente cedo (quando ele responde qualquer coisa relevante)
    if (!session.clientProfile) {
      const prof = classifyClientProfile(message, Boolean(imageUrl));
      if (prof) session.clientProfile = prof;
    }

    // se falar de colorido em texto (alinha black & grey)
    if (!session.finished && detectColorIntentByText(message)) {
      session.awaitingBWAnswer = true;
      const reply = msgSoBlackGrey();
      if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
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

    // ✅ se está aguardando resposta de black & grey
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
      }
    }

    // ✅ confirmação por TEXTO sem foto: avisa que precisa da foto do comprovante
    const depositTextOnly = detectDepositTextOnly(message);
    const isAfterQuote = session.stage === "pos_orcamento" || session.sentQuote;

    if (!session.depositConfirmed && depositTextOnly && !imageUrl && isAfterQuote) {
      const reply = msgAguardandoComprovante();
      if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
      return;
    }

    // ✅ FOTO do comprovante (image) após orçamento => confirma e pergunta agenda + notifica OWNER
    const depositByImageAfterQuote = Boolean(imageUrl) && isAfterQuote;

    if (!session.depositConfirmed && depositByImageAfterQuote) {
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

    // ✅ imagem chegou (referência) -> salva e gera resumo
    if (imageUrl) {
      try {
        const dataUrl = await fetchImageAsDataUrl(imageUrl, imageMime);
        session.imageDataUrl = dataUrl;

        session.imageSummary = await describeImageForClient(dataUrl);

        // ✅ se a descrição indicar “colorida”, valida black & grey
        if (detectColorIntentBySummary(session.imageSummary)) {
          session.awaitingBWAnswer = true;
          const reply = msgSoBlackGrey();
          if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
        }

        // ✅ Nova referência: reseta flags pra manter ORDEM correta
        session.sentSummary = false;
        session.askedDoubts = false;
        session.sentPayments = false;
        session.sentQuote = false;

        // mantém perfil
        if (!session.clientProfile) session.clientProfile = "arquiteto";

        session.stage = "aguardando_info";
      } catch (e) {
        console.error("[IMG] failed:", e?.message || e);
      }
    }

    // --------- fluxo inicial (saudação) ---------
    if (session.stage === "inicio") {
      const name = safeName(contactName);
      if (!session.greetVariant) session.greetVariant = pickOne(GREETINGS);
      if (!session.closingVariant) session.closingVariant = pickOne(CLOSINGS);

      const reply = session.greetVariant ? session.greetVariant(name) : GREETINGS[0](name);
      if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);

      session.stage = "aguardando_referencia";
      session.greeted = true;
      return;
    }

    // --------- aguardando referência (sem imagem) ---------
    if (session.stage === "aguardando_referencia") {
      if (!session.imageDataUrl) {
        if (askedPrice(message)) {
          const reply = msgPrecoAntesDoValor();
          if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
          return;
        }

        if (!session.sentProfileMsg && !session.imageDataUrl) {
          if (!session.clientProfile) session.clientProfile = classifyClientProfile(message, false);
          const prof = session.clientProfile;

          let profMsg = "";
          if (prof === "arquiteto") profMsg = msgPerfilArquiteto();
          else if (prof === "explorador") profMsg = msgPerfilExplorador();
          else if (prof === "sonhador") profMsg = msgPerfilSonhador();

          if (profMsg) {
            if (!antiRepeat(session, profMsg)) await zapiSendText(phone, profMsg);
            session.sentProfileMsg = true;
          }
        }

        if (!session.sentNeedRefMsg) {
          const reply =
            "• Me manda a referência em *imagem* pra eu avaliar certinho.\n" +
            "• E me diz *onde no corpo* você quer fazer.\n" +
            "• Se tiver noção de tamanho, me fala também.";
          if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
          session.sentNeedRefMsg = true;
        }

        return;
      }

      session.stage = "aguardando_info";
    }

    // --------- com imagem, mas faltam infos mínimas ---------
    if (session.imageDataUrl && session.stage === "aguardando_info") {
      if (!session.bodyRegion && !session.sizeLocation) {
        const reply = msgPedirLocalOuTamanho();
        if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
        return;
      }

      if (!session.sentSummary && session.imageSummary) {
        const intro =
          "Perfeito, recebi a referência.\n\n" +
          "• Antes de falar de investimento, deixa eu te explicar o que esse projeto exige pra ficar bem feito:\n\n" +
          session.imageSummary;

        if (!antiRepeat(session, intro)) await zapiSendText(phone, intro);
        session.sentSummary = true;

        const dq = msgChecagemDuvidas();
        if (!antiRepeat(session, dq)) await zapiSendText(phone, dq);
        session.askedDoubts = true;
        session.stage = "pos_resumo_duvidas";
        return;
      }

      if (!session.askedDoubts) {
        const dq = msgChecagemDuvidas();
        if (!antiRepeat(session, dq)) await zapiSendText(phone, dq);
        session.askedDoubts = true;
        session.stage = "pos_resumo_duvidas";
        return;
      }
    }

    // --------- etapa de dúvidas (antes do orçamento) ---------
    if (session.stage === "pos_resumo_duvidas") {
      if (answeredNoDoubts(message)) {
        const infoParaCalculo =
          session.sizeLocation ||
          (session.bodyRegion ? `Região do corpo: ${session.bodyRegion} (tamanho não informado)` : "não informado");

        const hours = await estimateHoursInternal(session.imageDataUrl, infoParaCalculo, session.isCoverup);
        const sessoes = sessionsFromHours(hours);
        const valor = calcPriceFromHours(hours);

        const final = msgFechamentoValor(valor, sessoes);
        if (!antiRepeat(session, final)) await zapiSendText(phone, final);

        session.sentPayments = true;
        session.sentQuote = true;
        session.stage = "pos_orcamento";
        return;
      }

      if (answeredHasDoubts(message) || askedPain(message) || askedTime(message) || askedPrice(message) || askedHesitation(message)) {
        if (askedPain(message)) {
          const r = msgDorResposta();
          if (!antiRepeat(session, r)) await zapiSendText(phone, r);
        } else if (askedTime(message)) {
          const r = msgTempoResposta();
          if (!antiRepeat(session, r)) await zapiSendText(phone, r);
        } else if (askedPrice(message)) {
          const r = msgPrecoAntesDoValor();
          if (!antiRepeat(session, r)) await zapiSendText(phone, r);
        } else if (askedHesitation(message)) {
          const r = msgHesitacaoResposta();
          if (!antiRepeat(session, r)) await zapiSendText(phone, r);
        } else {
          await handoffToManual(phone, session, "Dúvida não mapeada (pré-orçamento)", message);
          return;
        }

        const dq = msgChecagemDuvidas();
        if (!antiRepeat(session, dq)) await zapiSendText(phone, dq);
        return;
      }

      await handoffToManual(phone, session, "Resposta fora do fluxo (pré-orçamento)", message);
      return;
    }

    // ===================== PÓS ORÇAMENTO =====================
    if (session.stage === "pos_orcamento") {
      // se o cliente tentar “fechar” mas não mandar comprovante: reforça sinal + foto
      if (/fech|vamos|bora|quero|ok|topo|pode\s*marcar|como\s*fa[cç]o\s*o\s*pix|vou\s*fazer\s*o\s*pix/i.test(lower)) {
        const pixLine = ENV.PIX_KEY ? `• Chave Pix: ${ENV.PIX_KEY}\n` : "";
        const reply =
          "Fechado.\n\n" +
          "• Pra reservar teu horário eu peço um *sinal de R$ 50*.\n" +
          pixLine +
          "• Assim que você enviar a *foto do comprovante* aqui, eu confirmo o agendamento e seguimos pra agenda.";
        if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
        return;
      }

      // parcelamento mensal
      if (/mensal|por\s*m[eê]s|dividir|parcelar\s*por\s*m[eê]s/i.test(lower)) {
        const reply =
          "Dá sim.\n\n" +
          "• Quando fica pesado pagar tudo de uma vez, eu consigo organizar em *sessões mensais*.\n" +
          "• O total ajusta um pouco por virar um atendimento em etapas.\n\n" +
          "Me diz em quantos meses você prefere que eu já te proponho o formato certinho.";
        if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
        return;
      }

      // se cliente mandar mais info de local/tamanho depois, recalcula (volta pro resumo + dúvidas)
      if (maybeRegion || maybeSizeLoc) {
        session.sentSummary = false;
        session.askedDoubts = false;
        session.sentPayments = false;
        session.sentQuote = false;
        session.stage = "aguardando_info";
        const reply = "Perfeito — com essa informação eu consigo ajustar o orçamento certinho. Só um instante.";
        if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
        return;
      }

      // se o cliente fizer dúvidas comuns depois do orçamento, responde
      if (askedPain(message)) {
        const r = msgDorResposta();
        if (!antiRepeat(session, r)) await zapiSendText(phone, r);
        return;
      }
      if (askedTime(message)) {
        const r = msgTempoResposta();
        if (!antiRepeat(session, r)) await zapiSendText(phone, r);
        return;
      }
      if (askedHesitation(message)) {
        const r = msgHesitacaoResposta();
        if (!antiRepeat(session, r)) await zapiSendText(phone, r);
        return;
      }

      // se ele mandar algo fora do configurado: manual
      await handoffToManual(phone, session, "Mensagem não mapeada (pós-orçamento)", message);
      return;
    }

    // ===================== AGENDA (APÓS COMPROVANTE POR FOTO) =====================
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
            "📌 INFO DE AGENDA (bot)",
            `• Cliente: ${String(phone).replace(/\D/g, "")}`,
            `• Preferência: ${pref || "não informado"}`,
            `• Data específica: ${hasDate ? "sim" : "não"}`,
            `• Próximo horário disponível: ${noDate ? "sim" : "não"}`,
            `• Mensagem: ${(message || "").slice(0, 220)}`,
            "• Ação: confirmar agendamento manualmente e depois aguardar agradecimento do cliente pra enviar finalização.",
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

        // se só falou comercial/pós mas não disse data e nem pediu próximo horário
        const reply =
          "Perfeito.\n\n" +
          "• Vou verificar minha agenda e já te retorno com opções de *data e horário*.\n\n" +
          msgCuidadosPreSessao();
        if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
        return;
      }

      // se ainda não respondeu direito
      const reply = msgPerguntaAgenda();
      if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
      return;
    }

    // ===================== FINALIZAÇÃO (SÓ APÓS VOCÊ CONFIRMAR MANUAL E CLIENTE AGRADECER) =====================
    // Regra: finalização NÃO vai junto com agenda automática.
    // Ela entra quando você já assumiu manualmente (pos_agenda_manual/manualHandoff) e o cliente agradece.
    if ((session.stage === "pos_agenda_manual" || session.manualHandoff) && detectThanks(message)) {
      if (!session.closingVariant) session.closingVariant = pickOne(CLOSINGS);
      const reply = session.closingVariant ? session.closingVariant() : CLOSINGS[0]();
      if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
      session.finished = true;
      session.stage = "finalizado";
      return;
    }

    // ===================== FALLBACK FINAL =====================
    // Qualquer coisa que fuja do fluxo: assume manual (e avisa o cliente padrão)
    await handoffToManual(phone, session, "Fallback geral (fora do fluxo)", message);
    return;
  } catch (err) {
    console.error("[ZAPI WEBHOOK ERROR]", err?.message || err);
  }
});

// -------------------- START --------------------
app.listen(Number(ENV.PORT), () => {
  console.log("Server running on port", ENV.PORT);
});

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

// -------------------- VARIAÇÕES de saudação (1 por atendimento) --------------------
const GREETINGS = [
  (name) =>
    `Olá${name ? `, ${name}` : ""}! Aqui é o DW Tatuador, especializado em realismo preto e cinza e whip shading.\n\n` +
    `Fico feliz em receber sua mensagem! Conta pra mim: qual é a sua ideia pra transformarmos em arte na pele?\n\n` +
    `• Se tiver uma referência em *imagem*, já pode me mandar.\n` +
    `• Me diz também *onde no corpo* você quer fazer e o *tamanho aproximado* (se souber).`,
  (name) =>
    `Opa${name ? `, ${name}` : ""}! Tudo certo?\n` +
    `Aqui é o DW — trabalho com realismo *black & grey* e whip shading.\n\n` +
    `Me conta tua ideia e o que você quer representar com essa tattoo.\n\n` +
    `• Se tiver referência em *imagem*, manda.\n` +
    `• Me diz *local no corpo* e *tamanho aproximado* (se souber).`,
  (name) =>
    `Olá${name ? `, ${name}` : ""}! Seja bem-vindo.\n` +
    `Eu sou o DW, tatuador focado em realismo preto e cinza e um acabamento bem limpo.\n\n` +
    `Quero entender direitinho pra te orientar do melhor jeito: qual é a tua ideia?\n\n` +
    `• Se tiver referência em *imagem*, manda.\n` +
    `• Local no corpo + tamanho aproximado ajudam muito.`
];

// -------------------- VARIAÇÕES de finalização (1 por atendimento; só após agradecer) --------------------
const CLOSINGS = [
  () =>
    `Perfeito.\n\n` +
    `• Obrigado por confiar no meu trabalho.\n` +
    `• Qualquer dúvida sobre o atendimento, é só me chamar.\n` +
    `• Se precisar remarcar, tranquilo — só peço *48h de antecedência*.\n\n` +
    `A gente se vê na sessão. Vai ficar um trampo muito forte.`,
  () =>
    `Fechado!\n\n` +
    `• Valeu por fechar comigo.\n` +
    `• Se surgir qualquer dúvida até o dia, me chama por aqui.\n` +
    `• Pra remarcar, só avisar com *48h de antecedência*.\n\n` +
    `Agora é só chegar bem hidratado e alimentado que vai ser uma experiência top.`,
  () =>
    `Show.\n\n` +
    `• Obrigado pela confiança.\n` +
    `• Tô à disposição se precisar de qualquer ajuste ou tirar dúvidas.\n` +
    `• Remarcação: *48h de antecedência*.\n\n` +
    `Vai ficar com muita presença e acabamento limpo.`
];

// -------------------- PERFIL do cliente --------------------
function classifyClientProfile(text, hasImage) {
  const t = String(text || "").toLowerCase();

  // Arquiteto: referência, artista, estilo, pose, execução
  if (
    hasImage ||
    /refer[eê]ncia|referencia|foto|imagem|print|pose|estilo|artista|igual|id[eê]ntic|realista|black\s*&\s*grey|whip|fineline|tra[cç]o|sombras/i.test(t)
  ) return "arquiteto";

  // Explorador: ideia geral + pede ajuda pra desenvolver
  if (
    /quero\s*um|quero\s*algo|ideia\s*geral|m[ií]stic|animal|le[oã]o|tigre|lobo|medusa|jesus|anjo|santo|samurai|viking|caveira|olho|simbol|conceito|me\s*ajuda\s*a\s*criar|criar\s*um\s*conceito/i.test(t)
  ) return "explorador";

  // Sonhador: sentimento / significado abstrato
  if (
    /signific|represent|liberdade|supera[cç][aã]o|for[cç]a|fam[ií]lia|prote[cç][aã]o|f[eé]|renascimento|mudan[cç]a|fase|hist[oó]ria|lembran[cç]a|homenagem/i.test(t)
  ) return "sonhador";

  return "";
}

function msgPerfilArquiteto() {
  return (
    "Perfeito!\n\n" +
    "• Me envia tudo que você já tem em mente: fotos, referências de estilo, pose e qualquer detalhe que te inspira.\n" +
    "• Quanto mais detalhe você mandar, mais preciso eu consigo adaptar pro seu corpo.\n\n" +
    "O que te atraiu nessas referências? (contraste, expressão, composição, tema…)"
  );
}

function msgPerfilExplorador() {
  return (
    "Maravilha.\n\n" +
    "• Ter um ponto de partida já é meio caminho andado.\n" +
    "Me descreve um pouco mais: o que essa tattoo representa pra você?\n\n" +
    "• Tem algum elemento que *não pode faltar*?"
  );
}

function msgPerfilSonhador() {
  return (
    "Que massa essa ideia.\n\n" +
    "• Pra eu entender bem, me fala em palavras-chave: quais sentimentos essa tattoo tem que passar?\n" +
    "• Se tiver memórias, símbolos ou referências que te lembrem disso, pode mandar.\n\n" +
    "Não precisa ter desenho pronto — a gente constrói isso juntos."
  );
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
  return /n[aã]o|nao|nenhuma|tudo\s*certo|tranquilo|fechado|sem\s*d[uú]vidas|ok|blz|beleza|deboa|de boa/i.test(t);
}

function answeredHasDoubts(text) {
  const t = String(text || "").toLowerCase();
  return /tenho|sim|alguma|d[uú]vida|me\s*explica|n[aã]o\s*entendi|como\s*funciona|e\s*se/i.test(t);
}

// -------------------- RESPOSTAS de OBJEÇÕES (dor / tempo / preço / hesitação) --------------------
function msgDorResposta() {
  return (
    "Entendo perfeitamente — essa dúvida é super comum.\n\n" +
    "• A sensação varia de pessoa pra pessoa e depende bastante da região.\n" +
    "• A maioria dos meus clientes descreve mais como uma *ardência / arranhão intenso* do que uma dor absurda.\n" +
    "• Eu trabalho com ritmo e pausas pra você ficar confortável.\n\n" +
    "Me diz a área do corpo que você pensa e eu te falo as regiões mais tranquilas e as mais sensíveis pra você decidir com segurança."
  );
}

function msgTempoResposta() {
  return (
    "Boa.\n\n" +
    "• O tempo varia principalmente pelo *tamanho* e pelo *nível de detalhe* (transições, textura, contraste e acabamento).\n" +
    "• Meu foco é não correr e manter a qualidade do realismo e uma cicatrização correta.\n\n" +
    "Me diz o local no corpo e o tamanho aproximado que eu te passo uma noção bem fiel de como costuma funcionar."
  );
}

function msgPrecoAntesDoValor() {
  return (
    "Boa pergunta.\n\n" +
    "• Pra eu te passar um valor justo, eu preciso ver a referência em *imagem* e entender *onde no corpo* + *tamanho*.\n" +
    "• Isso muda totalmente o nível de detalhe, sombras, encaixe e acabamento.\n\n" +
    "Me manda a referência e essas infos que eu já te retorno com tudo bem alinhado."
  );
}

function msgHesitacaoResposta() {
  return (
    "Tranquilo — é uma decisão importante mesmo.\n\n" +
    "• Pra eu te ajudar a decidir com segurança: tem algo específico que tá te travando?\n" +
    "• É dúvida no desenho, no orçamento ou na data?\n\n" +
    "Minha agenda costuma preencher rápido, então se você tiver uma data preferencial, me fala que eu tento priorizar um encaixe pra você."
  );
}

// -------------------- ORÇAMENTO (unificado e na ordem correta) --------------------
// ✅ RENOMEADO pra não bater com a função msgFechamentoValor(valor) que já existe no seu app.js
function msgFechamentoValorOrcamento(valor, sessoes) {
  const pixLine = ENV.PIX_KEY ? `• Chave Pix: ${ENV.PIX_KEY}\n` : "";
  return (
    `Pelo tamanho e complexidade do que você me enviou, o investimento fica em *R$ ${valor}*.\n\n` +
    `• Pra ficar bem executado e cicatrizar redondo, eu organizo em *${sessoes} sessão(ões)*.\n` +
    "• Pagamento: Pix, débito ou crédito em até 12x.\n" +
    "• O orçamento inclui *1 retoque* (se necessário) entre 40 e 50 dias.\n\n" +
    "• Pra reservar o horário eu peço um *sinal de R$ 50*.\n" +
    pixLine +
    "• Assim que você enviar a *foto do comprovante* aqui, eu confirmo o agendamento e seguimos pra agenda."
  );
}

// -------------------- HANDOFF manual (quando não tem configurado) --------------------
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
    "Perfeito.\n\n" +
    "• Vou analisar direitinho e em breve te respondo.";
  if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
}
