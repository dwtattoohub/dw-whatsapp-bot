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

// -------------------- Utils --------------------
function normalizePhone(p) {
  return String(p || "").replace(/\D/g, "");
}

function pickRandom(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return "";
  return arr[Math.floor(Math.random() * arr.length)];
}

function safeName(raw) {
  const n = String(raw || "").trim();
  if (!n) return "";
  // corta nomes muito longos e remove caracteres estranhos
  return n.replace(/[^\p{L}\p{N}\s'.-]/gu, "").slice(0, 40).trim();
}

// -------------------- Session (RAM) --------------------
const sessions = {}; // key: phone
function getSession(phone) {
  if (!sessions[phone]) {
    sessions[phone] = {
      stage: "inicio",

      // dados do projeto
      imageDataUrl: null,   // data:image/...;base64,...
      imageSummary: null,   // descrição técnica pro cliente
      sizeLocation: null,   // "25cm no antebraço" (opcional)
      bodyRegion: null,     // "costela", "pescoço", "mão" etc (aceita sem cm)
      isCoverup: false,

      // perfil/psicologia
      greeted: false,
      clientType: "",       // "arquiteto" | "explorador" | "sonhador"

      // FLAGS pra não repetir
      sentSummary: false,
      sentPayments: false,
      sentQuote: false,

      // etapa de sinal/agenda
      depositConfirmed: false,      // confirmado SOMENTE por foto do comprovante
      askedSchedule: false,
      scheduleCaptured: false,      // cliente já respondeu (comercial/pós e/ou data)
      manualHandoff: false,         // daqui pra frente você assume manualmente

      // controle de estilo/encerramento
      awaitingBWAnswer: false,
      finished: false,
      doubtsAsked: false,

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
      "client-token": ENV.ZAPI_CLIENT_TOKEN, // mantém como estava no seu JS que funcionou
    },
    body: JSON.stringify({
      phone: normalizePhone(phone),
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
  // Phone (várias possibilidades)
  const phone =
    body?.phone ||
    body?.from ||
    body?.sender ||
    body?.senderPhone ||
    body?.remoteJid ||
    body?.chatId ||
    body?.data?.phone ||
    body?.data?.from ||
    body?.data?.senderPhone ||
    null;

  // Nome (quando existir)
  const contactName =
    body?.senderName ||
    body?.pushName ||
    body?.data?.senderName ||
    body?.data?.pushName ||
    body?.contact?.name ||
    body?.data?.contact?.name ||
    "";

  // Texto (várias possibilidades)
  const message =
    body?.message ||
    body?.text?.message ||
    body?.text ||
    body?.Body ||
    body?.data?.message ||
    body?.data?.text ||
    body?.data?.body ||
    "";

  // Mídia (imagem)
  const imageUrl =
    body?.image?.imageUrl ||
    body?.image?.url ||
    body?.imageUrl ||
    body?.message?.image?.url ||
    body?.media?.url ||
    body?.data?.image?.imageUrl ||
    body?.data?.imageUrl ||
    body?.data?.mediaUrl ||
    body?.data?.media?.url ||
    null;

  const imageMime =
    body?.image?.mimeType ||
    body?.image?.mimetype ||
    body?.mimeType ||
    body?.data?.mimeType ||
    body?.data?.image?.mimeType ||
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
    contactName: safeName(contactName),
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
  return /obrigad|valeu|tmj|agradeço|fechou|show|top|blz|beleza/i.test(t);
}

function detectNoDoubts(text) {
  const t = (text || "").toLowerCase();
  return /n[aã]o\s*|sem\s*d[uú]vida|sem\s*duvida|t[aá]\s*tudo\s*certo|tudo\s*certo|tranquilo|de\s*boa|ok|perfeito|fechado|suave/i.test(t);
}

// ✅ Black & Grey only: detect cor no texto
function detectColorIntentByText(text) {
  const t = (text || "").toLowerCase();
  return /colorid|color|cores|vermelh|azul|amarel|verde|roxo|rosa|laranj|aquarel|new\s*school/i.test(t);
}

// ✅ tenta inferir "colorida" pela descrição (se a IA mencionar)
function detectColorIntentBySummary(summary) {
  const s = (summary || "").toLowerCase();
  return /colorid|cores|color|tinta\s*colorida|tons\s*vivos/i.test(s);
}

// ✅ detecta resposta do cliente sobre aceitar black&grey
function detectBWAccept(text) {
  const t = (text || "").toLowerCase();
  if (/(^|\b)(sim|aceito|pode|fechado|bora|ok|topo|manda|vamo|vamos|quero\s*em\s*preto|preto\s*e\s*cinza)(\b|$)/i.test(t)) return "yes";
  if (/(^|\b)(n[aã]o|nao|prefiro\s*color|quero\s*color|n[aã]o\s*quero\s*preto|nao\s*quero\s*preto)(\b|$)/i.test(t)) return "no";
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
  return /pr[oó]xim[ao]\s*(hor[aá]rio|data)\s*(livre|dispon[ií]vel)|qualquer\s*data|pr[oó]xima\s*data|pode\s*marcar\s*no\s*pr[oó]ximo|o\s*que\s*voc[eê]\s*tiver|sem\s*data|n[aã]o\s*tenho\s*data/i.test(t);
}

function detectHasSpecificDate(text) {
  const t = (text || "").toLowerCase();
  return /(\d{1,2}\/\d{1,2})|(\d{1,2}\-\d{1,2})|dia\s*\d{1,2}|(segunda|ter[cç]a|quarta|quinta|sexta|s[aá]bado|domingo)/i.test(t);
}

// -------------------- Client behavior (Arquiteto/Explorador/Sonhador) --------------------
function classifyClientType({ message, hasImage }) {
  const t = (message || "").toLowerCase();

  // Arquiteto: referência/precisão
  if (hasImage) return "arquiteto";
  if (/refer[eê]ncia|foto|print|igual|fiel|mesma|estilo|pose|artista|realismo|tra[oç]o|linha|detalh/i.test(t)) return "arquiteto";

  // Sonhador: abstrato/sentimento
  if (/liberdade|for[cç]a|supera[cç][aã]o|significad|represent|sentimento|mem[oó]ria|fase|hist[oó]ria|renascer|recome[cç]o|prop[oó]sito/i.test(t)) {
    return "sonhador";
  }

  // Explorador: ideia geral + pede tua direção
  if (/ideia|algo|quero\s*um|quero\s*algo|m[ií]stic|animal|simbol|criar|montar|me\s*ajuda|sugere|sugest|fazer\s*algo/i.test(t)) {
    return "explorador";
  }

  return "explorador";
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
- Antes de falar preço: explique o valor do trabalho (complexidade, sombras, transições, acabamento, encaixe).
- Você trabalha com black & grey realismo e whip shading (técnica delicada e limpa).
- Você não faz sessões acima de 7 horas; se passar disso, divide em 2+ sessões (sem falar horas).
- Pagamento: Pix, débito, crédito até 12x.
- Inclui 1 retoque se necessário em 40–50 dias.
- Parcelamento mensal existe: se o cliente não conseguir pagar de uma vez, pode dividir em sessões mensais, com ajuste no total.
- Cobertura: peça foto da tattoo atual, mas deixe claro que raramente aceita cobertura por causa do seu estilo, e que vai analisar antes de confirmar.
- Criação: você faz criações exclusivas baseadas na referência e adapta ao corpo do cliente.
- Sempre escreva com parágrafos curtos, sem erros ortográficos.
- Informações importantes devem começar com "•".
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
              "Analise a referência e gere uma explicação curta e profissional do que o projeto exige (sombras, transições, volume, contraste, acabamento, encaixe). NÃO fale de preço, NÃO fale de horas. 6 a 10 linhas no máximo. Use bullets '•' nas partes importantes.",
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

// -------------------- Replies (variações + scripts) --------------------
function msgSaudacaoPrimeira(contactName = "") {
  // variação pedida por você (sem nome quando não tiver)
  const namePart = contactName ? `Olá, ${contactName}!` : "Olá!";
  const v1 = (
    `${namePart}\n` +
    "Aqui é o DW Tatuador, especializado em realismo preto e cinza e whip shading.\n" +
    "Fico feliz em receber sua mensagem.\n\n" +
    "Conta pra mim: qual é a sua ideia pra transformarmos em arte na pele?"
  );

  const v2 = (
    `${contactName ? `Fala, ${contactName}!` : "Fala!"}\n` +
    "Aqui é o DW.\n\n" +
    "• Eu trabalho com realismo black & grey e whip shading, focado em acabamento limpo e leitura forte na pele.\n" +
    "Me conta sua ideia e o que você quer transmitir com essa tattoo."
  );

  const v3 = (
    `${contactName ? `Oi, ${contactName}!` : "Oi!"}\n` +
    "Bem-vindo(a).\n\n" +
    "• Pra eu te orientar do jeito certo (e já pensar encaixe e composição), me diz qual é a ideia principal da tattoo."
  );

  return pickRandom([v1, v2, v3]);
}

function msgPedirReferenciaLocalTamanho() {
  return (
    "Perfeito.\n\n" +
    "• Me manda a referência em *imagem* (print/foto).\n" +
    "• Me diz *onde no corpo* você quer fazer.\n" +
    "• Se souber o tamanho aproximado, melhor — se não souber, sem problema."
  );
}

function msgClienteArquiteto() {
  return (
    "Perfeito.\n\n" +
    "• Me envie tudo que você já tem em mente: fotos, desenhos, referências de estilo, ou até textos que te inspiram.\n" +
    "• Quanto mais detalhes, melhor eu consigo visualizar e adaptar à sua pele.\n\n" +
    "O que te atraiu nessas referências?"
  );
}

function msgClienteExplorador() {
  return (
    "Maravilha.\n\n" +
    "• Ter um ponto de partida já é meio caminho andado.\n" +
    "Me descreve um pouco mais sobre essa ideia: o que ela representa pra você?\n\n" +
    "• Tem algum elemento específico que não pode faltar?"
  );
}

function msgClienteSonhador(sentimento = "") {
  const s = sentimento ? `("${sentimento}")` : "";
  return (
    "Que ótimo.\n\n" +
    "• Pra eu construir isso do jeito certo, pensa em palavras-chave, sensações e referências do que você quer sentir ao olhar pra tattoo.\n" +
    "• Você não precisa ter um desenho pronto — a gente constrói juntos.\n\n" +
    `O que esse significado ${s} precisa evocar visualmente pra você?`
  );
}

function msgCriacao() {
  return (
    "Sim.\n\n" +
    "• Eu faço *criações exclusivas*.\n" +
    "• A referência serve como base e eu adapto a composição pro teu corpo (encaixe, proporção e leitura), mantendo o estilo do meu trabalho."
  );
}

function msgCoberturaPedirFoto() {
  return (
    "Sobre *cobertura*:\n\n" +
    "• Me manda uma foto bem nítida da tattoo atual (de perto e de um pouco mais longe).\n\n" +
    "• Só pra ser transparente: eu *raramente* pego cobertura, porque meu estilo é bem limpo e delicado e, na maioria dos casos, cobertura não entrega o resultado que eu gosto de entregar.\n\n" +
    "Assim que eu ver a foto, eu te falo com sinceridade se dá pra fazer ou não."
  );
}

function msgPedirLocalOuTamanho() {
  return (
    "Perfeito.\n\n" +
    "• Me confirma o *local no corpo* (ex: costela, pescoço, mão, antebraço).\n" +
    "• E, se souber, o *tamanho aproximado*.\n\n" +
    "Se não souber em cm, pode falar do jeito que você imagina que eu consigo estimar por aqui."
  );
}

function msgPagamentosESessoes(sessoes) {
  return (
    `Pra ficar com um resultado bem limpo e cicatrização correta, eu organizo esse projeto em *${sessoes} sessão(ões)*.\n` +
    "Eu não passo de 7 horas por sessão — quando o projeto pede mais, eu divido pra manter qualidade.\n\n" +
    "• Pagamento:\n" +
    "• Pix\n" +
    "• Débito\n" +
    "• Crédito em até 12x\n\n" +
    "• O orçamento já inclui *1 sessão de retoque* (se necessário) entre 40 e 50 dias após cicatrização.\n\n" +
    "Se ficar pesado pagar tudo de uma vez, dá pra fazer em *sessões mensais* (com ajuste no total)."
  );
}

// ✅ sinal R$ 50 + chave pix
function msgFechamentoValor(valor) {
  const pixLine = ENV.PIX_KEY ? `• Chave Pix: ${ENV.PIX_KEY}\n` : "";
  return (
    `Pelo tamanho e complexidade do que você me enviou, o investimento fica em *R$ ${valor}*.\n\n` +
    "• Pra reservar o horário eu peço um *sinal de R$ 50*.\n" +
    pixLine +
    "• Assim que você *enviar a foto do comprovante* aqui, eu confirmo o agendamento e já te passo as opções de agenda."
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
    "Assim que chegar, eu sigo com a agenda."
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
    "• Em instantes eu te retorno com as *próximas datas e horários disponíveis* pra você escolher e eu já deixo reservado."
  );
}

function msgVouVerificarAgendaComData() {
  return (
    "Perfeito.\n\n" +
    "• Vou verificar na agenda se essa data está disponível.\n" +
    "• Em instantes eu te retorno confirmando as opções de *data e horário* da sua sessão."
  );
}

function msgEncerramentoFinal() {
  const v1 =
    "Fechado.\n\n" +
    "• Obrigado por confiar no meu trabalho.\n" +
    "• Qualquer dúvida sobre o atendimento, é só me chamar por aqui.\n" +
    "• Se precisar remarcar, tranquilo — só peço *aviso com 48h de antecedência*.\n\n" +
    "A gente vai fazer um trampo bem forte, com acabamento limpo e leitura perfeita na pele.";

  const v2 =
    "Perfeito.\n\n" +
    "• Gratidão por me escolher.\n" +
    "• Se surgir qualquer dúvida, me chama que eu te ajudo.\n" +
    "• Remarcação: *48h de antecedência* pra manter a organização da agenda.\n\n" +
    "Vai ficar uma tattoo de respeito.";

  const v3 =
    "Combinado.\n\n" +
    "• Obrigado por chamar.\n" +
    "• Fico à disposição pra qualquer dúvida do atendimento.\n" +
    "• Se precisar ajustar a data, só avisar com *48h de antecedência*.\n\n" +
    "Agora é só alinhar a agenda e partir pro trampo.";

  return pickRandom([v1, v2, v3]);
}

function msgCuidadosPreSessao() {
  return (
    "Pra sua sessão render o máximo e a pele responder bem:\n\n" +
    "• Beba bastante água no dia anterior e no dia da sessão.\n" +
    "• Hidrate a pele da região (creme hidratante comum) por alguns dias antes.\n" +
    "• Evite álcool no dia anterior.\n" +
    "• Se alimente bem antes de vir (refeição completa).\n\n" +
    "Isso melhora conforto, resistência durante a sessão e o resultado final."
  );
}

function msgSoBlackGrey() {
  return (
    "Perfeito — só um detalhe importante pra alinhar direitinho.\n\n" +
    "• Eu trabalho com *black & grey* (preto e cinza).\n" +
    "• Não faço tatuagem totalmente colorida.\n" +
    "• No máximo, eu uso *pequenos detalhes* (ex: olhos ou pontos específicos), quando combina com o projeto.\n\n" +
    "Se você curtir a ideia em preto e cinza, eu sigo e deixo o desenho com muita profundidade e contraste."
  );
}

function msgFinalizaPorNaoAceitarBW() {
  return (
    "Entendi.\n\n" +
    "• Como eu trabalho exclusivamente com *black & grey*, eu não vou conseguir te atender do jeito que você quer em colorido.\n\n" +
    "Obrigado por me chamar.\n" +
    "• Se no futuro você decidir fazer em preto e cinza, eu fico à disposição."
  );
}

function msgEndereco() {
  return (
    "Claro.\n\n" +
    "• Endereço: *Av. Mauá, 1308* — próximo à rodoviária.\n" +
    "• É um estúdio *privado e aconchegante*, pensado pra você ter uma experiência confortável e focada no resultado.\n\n" +
    "Se quiser, me diz seu bairro que eu te passo uma referência rápida de como chegar."
  );
}

function msgChecagemDuvidas() {
  return (
    "Perfeito.\n\n" +
    "• Ficou alguma dúvida sobre o atendimento?"
  );
}

function msgSemDuvidasAgradece() {
  return (
    "Perfeito.\n\n" +
    "• Obrigado por me chamar.\n" +
    "• Qualquer dúvida, eu fico à disposição por aqui.\n\n" +
    "Se você for fazer o sinal, só lembra:\n" +
    "• Pra confirmar o agendamento eu preciso da *foto do comprovante*.\n" +
    "• Remarcação: *48h de antecedência*."
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
    const { phone, contactName, message, imageUrl, imageMime, fromMe, messageType } = inbound;

    console.log("[IN]", {
      phone: phone ? normalizePhone(phone) : null,
      fromMe,
      messageType,
      hasImageUrl: !!imageUrl,
      name: contactName || "",
      messagePreview: (message || "").slice(0, 120),
    });

    if (!phone) return;
    if (fromMe) return;

    const p = normalizePhone(phone);
    const session = getSession(p);
    const lower = (message || "").toLowerCase();
    const hasImage = Boolean(imageUrl);

    // ✅ comando reset/reiniciar atendimento
    if (/^reset$|^reiniciar$|^reinicia$|^começar\s*novamente$|^comecar\s*novamente$/i.test(lower)) {
      resetSession(p);
      const s2 = getSession(p);

      const reply =
        "Perfeito.\n\n" +
        "• Atendimento reiniciado.\n\n" +
        "• Me manda a referência em *imagem*.\n" +
        "• Me diz *onde no corpo* você quer fazer.\n" +
        "• Se souber o tamanho, melhor — se não, sem problema.";

      if (!antiRepeat(s2, reply)) await zapiSendText(p, reply);
      return;
    }

    // ✅ endereço
    if (askedAddress(message)) {
      const reply = msgEndereco();
      if (!antiRepeat(session, reply)) await zapiSendText(p, reply);
      return;
    }

    // ✅ se cliente pedir pix
    if (askedPix(message)) {
      const reply = msgPixDireto();
      if (!antiRepeat(session, reply)) await zapiSendText(p, reply);
      return;
    }

    // intents
    if (detectCoverup(message)) session.isCoverup = true;
    const askedCreation = /cria|criação|desenho|autor|exclusiv/i.test(lower);

    // classifica tipo de cliente (uma vez, logo no começo)
    if (!session.clientType) {
      session.clientType = classifyClientType({ message, hasImage });
    }

    // captura região e/ou tamanho (sem exigir cm)
    const maybeRegion = extractBodyRegion(message);
    if (!session.bodyRegion && maybeRegion) session.bodyRegion = maybeRegion;

    const maybeSizeLoc = extractSizeLocation(message);
    if (!session.sizeLocation && maybeSizeLoc) session.sizeLocation = maybeSizeLoc;

    // ✅ se o cliente falar de colorido em texto
    if (!session.finished && detectColorIntentByText(message)) {
      session.awaitingBWAnswer = true;
      const reply = msgSoBlackGrey();
      if (!antiRepeat(session, reply)) await zapiSendText(p, reply);
    }

    // ✅ se está aguardando resposta de black & grey
    if (session.awaitingBWAnswer) {
      const bw = detectBWAccept(message);
      if (bw === "no") {
        session.finished = true;
        session.stage = "finalizado";
        const reply = msgFinalizaPorNaoAceitarBW();
        if (!antiRepeat(session, reply)) await zapiSendText(p, reply);
        return;
      }
      if (bw === "yes") {
        session.awaitingBWAnswer = false;
        // segue fluxo normalmente
      }
    }

    // criação
    if (askedCreation) {
      const reply = msgCriacao();
      if (!antiRepeat(session, reply)) await zapiSendText(p, reply);
      // não retorna: pode continuar o fluxo
    }

    // cobertura
    if (session.isCoverup && !session.imageDataUrl && !hasImage) {
      const reply = msgCoberturaPedirFoto();
      if (!antiRepeat(session, reply)) await zapiSendText(p, reply);
      session.stage = "aguardando_referencia";
      return;
    }

    // ✅ saudação + script inicial (uma vez)
    if (!session.greeted) {
      session.greeted = true;

      const greet = msgSaudacaoPrimeira(contactName);
      if (!antiRepeat(session, greet)) await zapiSendText(p, greet);

      // script por tipo de cliente (sem interrogatório)
      const typeMsg =
        session.clientType === "arquiteto"
          ? msgClienteArquiteto()
          : session.clientType === "sonhador"
            ? msgClienteSonhador("")
            : msgClienteExplorador();

      if (!antiRepeat(session, typeMsg)) await zapiSendText(p, typeMsg);

      // pedido direto (referência/local/tamanho)
      const ask = msgPedirReferenciaLocalTamanho();
      if (!antiRepeat(session, ask)) await zapiSendText(p, ask);

      session.stage = "aguardando_referencia";
      // não return: pode ter vindo imagem já no primeiro evento
    }

    // ✅ confirmação por TEXTO sem foto: avisa que precisa da foto do comprovante
    const depositTextOnly = detectDepositTextOnly(message);
    const isAfterQuote = session.stage === "pos_orcamento" || session.sentQuote;

    if (!session.depositConfirmed && depositTextOnly && !hasImage && isAfterQuote) {
      const reply = msgAguardandoComprovante();
      if (!antiRepeat(session, reply)) await zapiSendText(p, reply);
      return;
    }

    // ✅ FOTO do comprovante (image) após orçamento => confirma e pergunta agenda + notifica OWNER
    const depositByImageAfterQuote = hasImage && isAfterQuote;

    if (!session.depositConfirmed && depositByImageAfterQuote) {
      session.depositConfirmed = true;
      session.stage = "agenda";
      session.askedSchedule = true;

      await notifyOwner(
        [
          "⚠️ COMPROVANTE RECEBIDO (bot)",
          `• Cliente: ${p}`,
          "• Próximo passo: conferir agenda e responder manualmente",
        ].join("\n")
      );

      const reply = msgPerguntaAgenda();
      if (!antiRepeat(session, reply)) await zapiSendText(p, reply);
      return;
    }

    // ✅ imagem chegou (referência) -> salva e gera resumo
    if (hasImage) {
      try {
        const dataUrl = await fetchImageAsDataUrl(imageUrl, imageMime);
        session.imageDataUrl = dataUrl;
        session.imageSummary = await describeImageForClient(dataUrl);

        // ✅ se a descrição indicar “colorida”, valida black & grey
        if (detectColorIntentBySummary(session.imageSummary)) {
          session.awaitingBWAnswer = true;
          const reply = msgSoBlackGrey();
          if (!antiRepeat(session, reply)) await zapiSendText(p, reply);
        }

        // Nova referência: reseta flags para permitir novo orçamento (uma vez só)
        session.sentSummary = false;
        session.sentPayments = false;
        session.sentQuote = false;

        session.stage = "aguardando_info";
      } catch (e) {
        console.error("[IMG] failed:", e?.message || e);
      }
    }

    // aguardando referência
    if (session.stage === "aguardando_referencia") {
      if (!session.imageDataUrl) {
        // Se o cliente está falando sem imagem, conduz sem repetir
        const wantsPrice = /valor|preço|orc|orç|quanto/i.test(lower);
        const reply = wantsPrice
          ? msgPedirReferenciaLocalTamanho()
          : "• Me manda a referência em *imagem* pra eu avaliar certinho.";
        if (!antiRepeat(session, reply)) await zapiSendText(p, reply);
        return;
      }
      session.stage = "aguardando_info";
    }

    // com imagem, mas faltam infos mínimas
    if (session.imageDataUrl && session.stage === "aguardando_info") {
      if (!session.bodyRegion && !session.sizeLocation) {
        const reply = msgPedirLocalOuTamanho();
        if (!antiRepeat(session, reply)) await zapiSendText(p, reply);
        return;
      }

      // 1) explica o valor do trabalho (UMA VEZ)
      if (!session.sentSummary && session.imageSummary) {
        const intro =
          "Perfeito, recebi a referência.\n\n" +
          "• Antes de falar de valor, deixa eu te explicar o que esse projeto exige pra ficar bem feito:\n\n" +
          session.imageSummary;

        if (!antiRepeat(session, intro)) await zapiSendText(p, intro);
        session.sentSummary = true;
      }

      // 2) calcula orçamento
      const infoParaCalculo =
        session.sizeLocation ||
        (session.bodyRegion ? `Região do corpo: ${session.bodyRegion} (tamanho não informado)` : "não informado");

      const hours = await estimateHoursInternal(session.imageDataUrl, infoParaCalculo, session.isCoverup);
      const sessoes = sessionsFromHours(hours);
      const valor = calcPriceFromHours(hours);

      // 3) pagamentos e sessões (UMA VEZ)
      if (!session.sentPayments) {
        const bloco = msgPagamentosESessoes(sessoes);
        if (!antiRepeat(session, bloco)) await zapiSendText(p, bloco);
        session.sentPayments = true;
      }

      // 4) valor (UMA VEZ)
      if (!session.sentQuote) {
        const final = msgFechamentoValor(valor);
        if (!antiRepeat(session, final)) await zapiSendText(p, final);
        session.sentQuote = true;
      }

      session.stage = "pos_orcamento";
      return;
    }

    // ✅ etapa agenda (após comprovante por FOTO)
    if (session.stage === "agenda") {
      const pref = detectCommercialPref(message);
      const hasDate = detectHasSpecificDate(message);
      const noDate = detectNoSpecificDate(message);

      // se cliente informou algo relevante de agenda
      if (pref || hasDate || noDate) {
        session.scheduleCaptured = true;
        session.manualHandoff = true;
        session.stage = "pos_agenda_manual";

        // respostas finais (bot encerra e você assume)
        if (noDate && !hasDate) {
          const reply = [msgVouVerificarAgendaSemData(), "", msgCuidadosPreSessao(), "", msgEncerramentoFinal()].join("\n\n");
          if (!antiRepeat(session, reply)) await zapiSendText(p, reply);
          return;
        }

        if (hasDate) {
          const reply = [msgVouVerificarAgendaComData(), "", msgCuidadosPreSessao(), "", msgEncerramentoFinal()].join("\n\n");
          if (!antiRepeat(session, reply)) await zapiSendText(p, reply);
          return;
        }

        // só informou comercial/pós sem data
        const reply =
          "Perfeito.\n\n" +
          "• Vou verificar minha agenda e já te retorno com opções de *data e horário*.\n\n" +
          msgCuidadosPreSessao() +
          "\n\n" +
          msgEncerramentoFinal();
        if (!antiRepeat(session, reply)) await zapiSendText(p, reply);
        return;
      }

      // ainda não respondeu direito
      const reply = msgPerguntaAgenda();
      if (!antiRepeat(session, reply)) await zapiSendText(p, reply);
      return;
    }

    // pós orçamento
    if (session.stage === "pos_orcamento") {
      // se o cliente tentar “fechar” mas não mandar comprovante: reforça sinal + foto
      if (/fech|vamos|bora|quero|ok|topo|pode marcar/i.test(lower)) {
        const pixLine = ENV.PIX_KEY ? `• Chave Pix: ${ENV.PIX_KEY}\n` : "";
        const reply =
          "Fechado.\n\n" +
          "• Pra reservar teu horário eu peço um *sinal de R$ 50*.\n" +
          pixLine +
          "• Assim que você enviar a *foto do comprovante* aqui, eu confirmo o agendamento e seguimos pra agenda.";
        if (!antiRepeat(session, reply)) await zapiSendText(p, reply);
        return;
      }

      if (/mensal|por mês|dividir|parcelar por mês/i.test(lower)) {
        const reply =
          "Dá sim.\n\n" +
          "• Quando fica pesado pagar tudo de uma vez, eu consigo organizar em *sessões mensais*.\n" +
          "• O total ajusta um pouco por virar um atendimento em etapas.\n\n" +
          "Me diz em quantos meses você prefere que eu já te proponho o formato certinho.";
        if (!antiRepeat(session, reply)) await zapiSendText(p, reply);
        return;
      }

      // se cliente mandar mais info de local/tamanho depois, recalcula
      if (maybeRegion || maybeSizeLoc) {
        session.sentPayments = false;
        session.sentQuote = false;
        session.stage = "aguardando_info";
        const reply = "Perfeito.\n\n• Com essa informação eu consigo ajustar o orçamento certinho.\n• Só um instante.";
        if (!antiRepeat(session, reply)) await zapiSendText(p, reply);
        return;
      }

      // ✅ encerra sem ficar repetindo “local no corpo”
      if (!session.doubtsAsked) {
        session.doubtsAsked = true;
        const reply = msgChecagemDuvidas();
        if (!antiRepeat(session, reply)) await zapiSendText(p, reply);
        return;
      }

      // se cliente respondeu que não tem dúvidas
      if (detectNoDoubts(message)) {
        const reply = msgSemDuvidasAgradece();
        if (!antiRepeat(session, reply)) await zapiSendText(p, reply);
        session.finished = true;
        session.stage = "finalizado";
        return;
      }

      // se não ficou claro, mantém leve
      const reply =
        "Perfeito.\n\n" +
        "• Se quiser, me diz qual parte você quer alinhar (ideia, local, tamanho, ou pagamento) que eu te explico certinho.";
      if (!antiRepeat(session, reply)) await zapiSendText(p, reply);
      return;
    }

    // ✅ quando o cliente agradecer no fim, agradece e encerra
    if ((session.stage === "pos_agenda_manual" || session.manualHandoff) && detectThanks(message)) {
      const reply = msgEncerramentoFinal();
      if (!antiRepeat(session, reply)) await zapiSendText(p, reply);
      session.finished = true;
      session.stage = "finalizado";
      return;
    }

    // fallback (bem contido pra não virar loop)
    const fallback =
      "Perfeito.\n\n" +
      "• Me manda a referência em *imagem* e me diz *onde no corpo* você quer fazer.\n" +
      "• Se souber o tamanho aproximado, melhor.";
    if (!antiRepeat(session, fallback)) await zapiSendText(p, fallback);
  } catch (err) {
    console.error("[ZAPI WEBHOOK ERROR]", err?.message || err);
  }
});

app.listen(Number(ENV.PORT), () => {
  console.log("Server running on port", ENV.PORT);
});
