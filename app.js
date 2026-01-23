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

      // referência / info
      imageDataUrl: null,   // data:image/...;base64,...
      imageSummary: null,   // descrição técnica pro cliente
      sizeLocation: null,   // "25cm no antebraço" (opcional)
      bodyRegion: null,     // "costela", "pescoço", "mão" etc (aceita sem cm)
      isCoverup: false,

      // perfil + saudação/finalização (1 variação por atendimento)
      greeted: false,
      greetVariant: null,
      closingVariant: null,
      clientProfile: null, // "arquiteto" | "explorador" | "sonhador"
      sentProfileMsg: false,

      // ordem / flags
      sentSummary: false,
      askedDoubts: false,     // já perguntou "ficou alguma dúvida?"
      doubtsResolved: false,  // cliente disse que não tem dúvidas
      sentQuote: false,       // orçamento completo enviado

      // etapa de sinal/agenda
      depositConfirmed: false,     // confirmado SOMENTE por foto do comprovante
      askedSchedule: false,
      scheduleCaptured: false,     // cliente já respondeu (comercial/pós e/ou data)
      manualHandoff: false,        // daqui pra frente você assume manualmente

      // controle de estilo/encerramento
      awaitingBWAnswer: false,
      finished: false,

      // handoff anti-spam
      lastOwnerNotifyAt: 0,

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

  // ✅ tenta extrair nome (se a Z-API mandar)
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

// -------------------- util / variações --------------------
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

const CLOSINGS = [
  () =>
    `Perfeito.\n\n` +
    `• Obrigado por confiar no meu trabalho.\n` +
    `• Qualquer dúvida, é só me chamar.\n` +
    `• Se precisar remarcar, tranquilo — só peço *48h de antecedência*.\n\n` +
    `A gente se vê na sessão. Vai ficar um trampo muito forte.`,
  () =>
    `Fechado!\n\n` +
    `• Valeu por fechar comigo.\n` +
    `• Se surgir qualquer dúvida até o dia, me chama por aqui.\n` +
    `• Remarcação: *48h de antecedência*.\n\n` +
    `Agora é só chegar bem hidratado e alimentado que vai ser uma experiência top.`,
  () =>
    `Show.\n\n` +
    `• Obrigado pela confiança.\n` +
    `• Tô à disposição se precisar de qualquer ajuste ou tirar dúvidas.\n` +
    `• Remarcação: *48h de antecedência*.\n\n` +
    `Vai ficar com muita presença e acabamento limpo.`
];

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
  if (/sim|aceito|pode|fechado|bora|ok|topo|manda|vamo/i.test(t)) return "yes";
  if (/não|nao|prefiro\s*color|quero\s*color|não\s*quero\s*preto|nao\s*quero\s*preto/i.test(t)) return "no";
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
  return /pr[oó]xim[ao]\s*(hor[aá]rio|data)\s*(livre|dispon[ií]vel)|qualquer\s*data|pr[oó]xima\s*data|pode\s*marcar\s*no\s*pr[oó]ximo|o\s*que\s*voc[eê]\s*tiver/i.test(t);
}

function detectHasSpecificDate(text) {
  const t = (text || "").toLowerCase();
  return /(\d{1,2}\/\d{1,2})|(\d{1,2}\-\d{1,2})|dia\s*\d{1,2}|(segunda|ter[cç]a|quarta|quinta|sexta|s[aá]bado|domingo)/i.test(t);
}

// -------------------- PERFIL do cliente --------------------
function classifyClientProfile(text, hasImage) {
  const t = String(text || "").toLowerCase();

  // Arquiteto: referência, artista, estilo, pose, execução
  if (
    hasImage ||
    /refer[eê]ncia|referencia|foto|imagem|print|pose|estilo|artista|igual|id[eê]ntic|realista|black\s*&\s*grey|whip|fineline|tra[cç]o|sombras/i.test(t)
  ) return "arquiteto";

  // Explorador: ideia geral + pede ajuda pra criar
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

function msgDorResposta() {
  return (
    "Entendo perfeitamente — essa dúvida é super comum.\n\n" +
    "• A sensação varia de pessoa pra pessoa e depende bastante da região.\n" +
    "• A maioria descreve mais como uma *ardência / arranhão intenso* do que uma dor absurda.\n" +
    "• Eu trabalho com ritmo e pausas pra você ficar confortável.\n\n" +
    "Me diz a área do corpo que você pensa e eu te falo as regiões mais tranquilas e as mais sensíveis pra você decidir com segurança."
  );
}

function msgTempoResposta() {
  return (
    "Boa.\n\n" +
    "• O tempo varia principalmente pelo *tamanho* e pelo *nível de detalhe* (transições, textura, contraste e acabamento).\n" +
    "• Meu foco é manter qualidade e uma cicatrização correta.\n\n" +
    "Me diz o local no corpo e o tamanho aproximado que eu te passo uma noção bem fiel de como costuma funcionar."
  );
}

function msgPrecoAntesDoValor() {
  return (
    "Boa pergunta.\n\n" +
    "• Pra eu te passar um valor justo, eu preciso ver a referência em *imagem* e entender *onde no corpo* + *tamanho*.\n" +
    "• Isso muda o nível de detalhe, sombras, encaixe e acabamento.\n\n" +
    "Me manda a referência e essas infos que eu já te retorno com tudo bem alinhado."
  );
}

function msgHesitacaoResposta() {
  return (
    "Tranquilo — é uma decisão importante mesmo.\n\n" +
    "• Pra eu te ajudar a decidir com segurança: tem algo específico que tá te travando?\n" +
    "• É dúvida no desenho, no orçamento ou na data?\n\n" +
    "Se você tiver uma data preferencial, me fala pra eu tentar priorizar um encaixe pra você."
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
    temperature: 0.4,
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

// -------------------- Replies (mantidas + ajustes de ordem) --------------------
function msgCriacao() {
  return (
    "Sim — eu faço *criações exclusivas*.\n" +
    "A referência serve como base, e eu adapto a composição pro teu corpo (encaixe, proporção e leitura), mantendo o estilo do meu trabalho."
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
    "Perfeito.\n" +
    "• Me diz *onde no corpo* você quer fazer (ex: costela, pescoço, mão, antebraço).\n" +
    "• E o *tamanho aproximado* (se não souber em cm, descreve do jeito que você imagina)."
  );
}

function msgSoBlackGrey() {
  return (
    "Perfeito — só um detalhe importante pra alinhar direitinho.\n\n" +
    "• Eu trabalho com *black & grey* (preto e cinza).\n" +
    "• Não faço tatuagem totalmente colorida — no máximo *pequenos detalhes* quando combina com o projeto.\n\n" +
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

function msgEndereco() {
  return (
    "Claro.\n\n" +
    "• Endereço: *Av. Mauá, 1308* — próximo à rodoviária.\n" +
    "• É um estúdio *privado e aconchegante*, pensado pra você ter uma experiência confortável e focada no resultado.\n\n" +
    "Se quiser, me diz seu bairro que eu te passo uma referência rápida de como chegar."
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

function msgPixDireto() {
  const pixLine = ENV.PIX_KEY ? ENV.PIX_KEY : "(chave pix não configurada no momento)";
  return (
    "Perfeito.\n\n" +
    `• Chave Pix: ${pixLine}\n` +
    "• Sinal para reserva: *R$ 50*\n\n" +
    "Assim que você enviar a *foto do comprovante* aqui, eu confirmo e seguimos pra agenda."
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
    "• Vou verificar minha agenda.\n" +
    "• Já já eu te retorno com as *próximas datas e horários disponíveis* pra você escolher."
  );
}

function msgVouVerificarAgendaComData() {
  return (
    "Perfeito.\n\n" +
    "• Vou verificar na agenda se essa data está disponível.\n" +
    "• Já já eu te retorno confirmando as opções de *data e horário*."
  );
}

function msgCuidadosPreSessao() {
  return (
    "Antes da sessão, pra sua experiência ser a melhor possível:\n\n" +
    "• Beba bastante água no dia anterior e no dia.\n" +
    "• Evite álcool no dia anterior.\n" +
    "• Se alimente bem antes de vir.\n\n" +
    "Isso ajuda no conforto e no resultado final."
  );
}

function msgChecagemDuvidas() {
  return (
    "Perfeito.\n\n" +
    "• Ficou alguma dúvida sobre o atendimento?\n" +
    "Se não ficou, me confirma que tá tudo certo que eu já te passo o investimento e as formas de pagamento."
  );
}

function msgOrcamentoCompleto(valor, sessoes) {
  const pixLine = ENV.PIX_KEY ? `• Chave Pix: ${ENV.PIX_KEY}\n` : "";
  return (
    `Pelo tamanho e complexidade do que você me enviou, o investimento fica em *R$ ${valor}*.\n\n` +
    `• Pra ficar bem executado e cicatrizar redondo, eu organizo em *${sessoes} sessão(ões)*.\n` +
    "• Pagamento: Pix, débito ou crédito em até 12x.\n" +
    "• Inclui *1 retoque* (se necessário) entre 40 e 50 dias.\n\n" +
    "• Pra reservar o horário eu peço um *sinal de R$ 50*.\n" +
    pixLine +
    "• Assim que você enviar a *foto do comprovante* aqui, eu confirmo o agendamento e seguimos pra agenda."
  );
}

// -------------------- HANDOFF manual (fallback desconhecido) --------------------
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

function chooseGreetingOnce(session, contactName) {
  if (!session.greetVariant) session.greetVariant = pickOne(GREETINGS) || GREETINGS[0];
  const nm = safeName(contactName);
  return session.greetVariant(nm);
}

function chooseClosingOnce(session) {
  if (!session.closingVariant) session.closingVariant = pickOne(CLOSINGS) || CLOSINGS[0];
  return session.closingVariant();
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

    // ✅ se já entrou em handoff manual, não atropela (só encerra quando agradecer após tua confirmação/andamento)
    if (session.manualHandoff) {
      if ((session.stage === "pos_agenda_manual" || session.stage === "manual_pendente") && detectThanks(message)) {
        const reply = chooseClosingOnce(session);
        if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
        session.finished = true;
        session.stage = "finalizado";
      }
      return;
    }

    // ✅ comando reset/reiniciar atendimento
    if (/^reset$|^reiniciar$|^reinicia$|^começar\s*novamente$|^comecar\s*novamente$/i.test(lower)) {
      resetSession(phone);
      const s2 = getSession(phone);
      const reply =
        "Perfeito.\n\n" +
        "• Atendimento reiniciado.\n" +
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

    // ✅ se cliente pedir pix
    if (askedPix(message)) {
      const reply = msgPixDireto();
      if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
      return;
    }

    // intents (dor/tempo/preço/hesitação) — responde sempre, mas respeita ordem (sem preço sem base)
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
      // se ainda não tem base, pede referência/local/tamanho
      if (!session.imageDataUrl || (!session.bodyRegion && !session.sizeLocation)) {
        const reply = msgPrecoAntesDoValor();
        if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
        return;
      }
      // se já tem base, vai seguir fluxo normal (não atropela com valor antes de confirmar dúvidas)
    }

    // intents gerais
    if (detectCoverup(message)) session.isCoverup = true;
    const askedCreation = /cria|criação|desenho|autor|exclusiv/i.test(lower);

    // captura região e/ou tamanho (sem exigir cm)
    const maybeRegion = extractBodyRegion(message);
    if (!session.bodyRegion && maybeRegion) session.bodyRegion = maybeRegion;

    const maybeSizeLoc = extractSizeLocation(message);
    if (!session.sizeLocation && maybeSizeLoc) session.sizeLocation = maybeSizeLoc;

    // ✅ se o cliente falar de colorido em texto
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

        // Nova referência: reseta flags do fluxo de orçamento
        session.sentSummary = false;
        session.askedDoubts = false;
        session.doubtsResolved = false;
        session.sentQuote = false;

        // perfil pode ser definido agora também
        if (!session.clientProfile) {
          const p = classifyClientProfile(message, true);
          if (p) session.clientProfile = p;
        }

        session.stage = "aguardando_info";
      } catch (e) {
        console.error("[IMG] failed:", e?.message || e);
      }
    }

    // -------------------- FLUXO NOVO (ORDEM CERTA) --------------------
    // 1) Saudação (uma vez) + pedido (já vem junto)
    if (session.stage === "inicio") {
      const reply = chooseGreetingOnce(session, contactName);
      if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
      session.greeted = true;
      session.stage = "aguardando_referencia";
      return;
    }

    // 2) Definir perfil do cliente (a partir da resposta) e mandar 1 script do perfil (uma vez)
    if (!session.clientProfile) {
      const p = classifyClientProfile(message, Boolean(imageUrl || session.imageDataUrl));
      if (p) session.clientProfile = p;
    }

    if (session.clientProfile && !session.sentProfileMsg && session.stage !== "agenda" && session.stage !== "finalizado") {
      let reply = "";
      if (session.clientProfile === "arquiteto") reply = msgPerfilArquiteto();
      if (session.clientProfile === "explorador") reply = msgPerfilExplorador();
      if (session.clientProfile === "sonhador") reply = msgPerfilSonhador();

      if (reply) {
        if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
        session.sentProfileMsg = true;
      }
      // não retorna: pode precisar pedir imagem/local/tamanho em seguida
    }

    // 3) Aguardando referência
    if (session.stage === "aguardando_referencia") {
      if (!session.imageDataUrl) {
        // se o cliente só mandou texto, reforça de forma simples
        const reply = "Perfeito. • Me manda a referência em *imagem* (print/foto) pra eu avaliar certinho.";
        if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
        return;
      }
      session.stage = "aguardando_info";
    }

    // 4) Com imagem, mas faltam infos mínimas (local/tamanho)
    if (session.imageDataUrl && session.stage === "aguardando_info") {
      if (!session.bodyRegion && !session.sizeLocation) {
        const reply = msgPedirLocalOuTamanho();
        if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
        return;
      }

      // 5) Explica complexidade (direto, sem enfeitar) — UMA VEZ
      if (!session.sentSummary && session.imageSummary) {
        const intro =
          "Perfeito, recebi a referência.\n\n" +
          "• Pra esse projeto ficar bem feito, ele exige:\n\n" +
          session.imageSummary;

        if (!antiRepeat(session, intro)) await zapiSendText(phone, intro);
        session.sentSummary = true;
      }

      // 6) Pergunta se ficou dúvida — UMA VEZ
      if (!session.askedDoubts) {
        const reply = msgChecagemDuvidas();
        if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
        session.askedDoubts = true;
        session.stage = "aguardando_duvidas";
        return;
      }

      // fallback defensivo
      session.stage = "aguardando_duvidas";
    }

    // 7) Dúvidas: se tiver, responde; se não, manda orçamento completo
    if (session.stage === "aguardando_duvidas") {
      // cliente disse que NÃO tem dúvidas
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

        session.sentQuote = true;
        session.stage = "pos_orcamento";
        return;
      }

      // cliente disse que TEM dúvidas (ou fez pergunta)
      if (answeredHasDoubts(message) || pain || timeAsk || priceAsk || hes) {
        // dor/tempo/preço/hesitação já foram tratados lá em cima com return,
        // então aqui sobra “dúvida genérica” -> tenta puxar perfil + pedir detalhe
        let reply = "";
        if (session.clientProfile === "arquiteto") {
          reply =
            "Entendi.\n\n" +
            "• Me diz o que você quer ajustar/confirmar (tamanho, encaixe, contraste, nível de realismo).\n" +
            "• Se tiver outra referência que ajude, pode mandar também.";
        } else if (session.clientProfile === "explorador") {
          reply =
            "Boa.\n\n" +
            "• Me diz o que você quer garantir nesse projeto.\n" +
            "• Tem algum elemento que não pode faltar ou algo que você não quer de jeito nenhum?";
        } else if (session.clientProfile === "sonhador") {
          reply =
            "Entendi.\n\n" +
            "• Me fala em 2 ou 3 palavras o que você quer sentir quando olhar essa tattoo.\n" +
            "• E se existe algum símbolo/lembrança que represente isso pra você.";
        } else {
          reply =
            "Entendi.\n\n" +
            "• Me explica rapidinho qual é a dúvida principal pra eu te orientar do jeito certo.";
        }

        if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
        return;
      }

      // se não encaixou em nada -> handoff
      await handoffToManual(phone, session, "Dúvida fora do configurado (etapa dúvidas)", message);
      return;
    }

    // 8) pós orçamento (aguardando comprovante) — mantém regras já existentes
    if (session.stage === "pos_orcamento") {
      // se cliente tentar “fechar” mas não mandar comprovante: reforça sinal + foto
      if (/fech|vamos|bora|quero|ok|topo|pode marcar/i.test(lower)) {
        const pixLine = ENV.PIX_KEY ? `• Chave Pix: ${ENV.PIX_KEY}\n` : "";
        const reply =
          "Fechado.\n\n" +
          "• Pra reservar teu horário eu peço um *sinal de R$ 50*.\n" +
          pixLine +
          "• Assim que você enviar a *foto do comprovante* aqui, eu confirmo o agendamento e seguimos pra agenda.";
        if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
        return;
      }

      if (/mensal|por mês|dividir|parcelar por mês/i.test(lower)) {
        const reply =
          "Dá sim.\n\n" +
          "• Quando fica pesado pagar tudo de uma vez, eu consigo organizar em *sessões mensais*.\n" +
          "• O total ajusta um pouco por virar um atendimento em etapas.\n\n" +
          "Me diz em quantos meses você prefere que eu já te proponho o formato certinho.";
        if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
        return;
      }

      // se cliente mandar mais info de local/tamanho depois, volta pra recalcular (e volta na ordem correta)
      if (maybeRegion || maybeSizeLoc) {
        session.sentSummary = false;
        session.askedDoubts = false;
        session.doubtsResolved = false;
        session.sentQuote = false;
        session.stage = "aguardando_info";
        const reply = "Perfeito — com essa informação eu consigo ajustar certinho. Só um instante.";
        if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
        return;
      }

      // qualquer coisa fora -> handoff
      await handoffToManual(phone, session, "Mensagem fora do configurado (pós orçamento)", message);
      return;
    }

    // 9) etapa agenda (após comprovante por FOTO) — NÃO envia finalização aqui
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

        // resposta pro cliente (sem finalização)
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
          "Perfeito.\n\n" +
          "• Vou verificar minha agenda e já te retorno com opções de *data e horário*.\n\n" +
          msgCuidadosPreSessao();
        if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
        return;
      }

      const reply = msgPerguntaAgenda();
      if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
      return;
    }

    // fallback final: se cair aqui e não bater em nada -> handoff
    await handoffToManual(phone, session, "Fallback geral (não configurado)", message);
  } catch (err) {
    console.error("[ZAPI WEBHOOK ERROR]", err?.message || err);
  }
});

app.listen(Number(ENV.PORT), () => {
  console.log("Server running on port", ENV.PORT);
});
