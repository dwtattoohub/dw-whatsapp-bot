// app.js (ESM)
// ENV no Render (obrigatórias):
// OPENAI_API_KEY
// ZAPI_INSTANCE_ID
// ZAPI_INSTANCE_TOKEN
// ZAPI_CLIENT_TOKEN
// OWNER_PHONE            (seu WhatsApp pessoal com DDI+DDD, ex: 5544999999999)
// PIX_KEY                (sua chave Pix - telefone/cpf/email/chave aleatória)
// (opcional) SYSTEM_PROMPT

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
  OWNER_PHONE: process.env.OWNER_PHONE || "",
  PIX_KEY: process.env.PIX_KEY || "",
  SYSTEM_PROMPT: process.env.SYSTEM_PROMPT || "",
  PORT: process.env.PORT || "10000",
};

function missingEnvs() {
  const req = [
    "OPENAI_API_KEY",
    "ZAPI_INSTANCE_ID",
    "ZAPI_INSTANCE_TOKEN",
    "ZAPI_CLIENT_TOKEN",
    "OWNER_PHONE",
    "PIX_KEY",
  ];
  return req.filter((k) => !ENV[k] || String(ENV[k]).trim() === "");
}

const openai = new OpenAI({ apiKey: ENV.OPENAI_API_KEY });

// -------------------- Session (RAM) --------------------
const sessions = {}; // key: phone
function getSession(phone) {
  if (!sessions[phone]) {
    sessions[phone] = {
      stage: "inicio",
      imageDataUrl: null,
      imageSummary: null,
      sizeLocation: null, // opcional
      bodyRegion: null, // opcional
      isCoverup: false,

      // status interno
      status: "NOVO", // NOVO | ORCADO | AGUARDANDO_SINAL | SINAL_PAGO
      lastQuoteValue: null,

      // FLAGS (não repetir)
      sentSummary: false,
      sentPayments: false,
      sentQuote: false,

      // anti loop
      lastReply: null,
      lastReplyAt: 0,
    };
  }
  return sessions[phone];
}

function antiRepeat(session, reply) {
  const now = Date.now();
  if (session.lastReply === reply && now - session.lastReplyAt < 90_000) return true;
  session.lastReply = reply;
  session.lastReplyAt = now;
  return false;
}

// -------------------- Time / Owner notify --------------------
function nowBR() {
  return new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
}

function looksLikeProofText(msg) {
  const t = (msg || "").toLowerCase();
  return /paguei|pago|pix|comprovante|transfer|enviei|sinal|dep(ó|o)sito|ted|doc|receipt|paid/i.test(
    t
  );
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

async function notifyOwner(text) {
  if (!ENV.OWNER_PHONE) return;
  try {
    await zapiSendText(ENV.OWNER_PHONE, text);
  } catch (e) {
    console.error("[OWNER NOTIFY FAIL]", e?.message || e);
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

  return {
    phone: phone ? String(phone) : null,
    message: String(message || "").trim(),
    imageUrl: imageUrl ? String(imageUrl) : null,
    imageMime: String(imageMime || "image/jpeg"),
    fromMe,
    messageType,
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
    "mão",
    "mao",
    "dedo",
    "punho",
    "antebraço",
    "antebraco",
    "braço",
    "braco",
    "ombro",
    "peito",
    "costela",
    "pescoço",
    "pescoco",
    "nuca",
    "pé",
    "pe",
    "tornozelo",
    "panturrilha",
    "canela",
    "coxa",
    "joelho",
    "virilha",
    "costas",
    "escápula",
    "escapula",
    "coluna",
    "rosto",
    "cabeça",
    "cabeca",
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

// Preço interno: 1ª hora 150, demais 120
function calcPriceFromHours(hours) {
  const h = Math.max(1, Math.round(Number(hours) || 1));
  return 150 + Math.max(0, h - 1) * 120;
}

// Sessões internas: max 7h por sessão
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

async function estimateHoursInternal(imageDataUrl, info, isCoverup) {
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
            text: `Info do cliente: ${info || "não informado"}.
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

function msgFechamentoValor(valor) {
  return (
    `Pelo tamanho e complexidade do que você me enviou, o investimento fica em *R$ ${valor}*.\n\n` +
    "Pra reservar seu horário, eu peço um *sinal de R$ 100*.\n" +
    `Chave Pix: *${ENV.PIX_KEY}*\n\n` +
    "Assim que confirmar o Pix, me manda o comprovante aqui e eu já te passo as opções de agenda certinhas."
  );
}

function msgSinalPix() {
  return (
    "Perfeito! Pra reservar teu horário, o sinal é de *R$ 100*.\n" +
    `Chave Pix: *${ENV.PIX_KEY}*\n\n` +
    "Assim que fizer o Pix, me manda o comprovante aqui e eu já te envio as opções de agenda."
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
      OWNER_PHONE: !!ENV.OWNER_PHONE,
      PIX_KEY: !!ENV.PIX_KEY,
    },
  });
});

// Webhook
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

    const session = getSession(phone);
    const lower = (message || "").toLowerCase();

    // intents
    if (detectCoverup(message)) session.isCoverup = true;
    const askedCreation = /cria|criação|desenho|autor|exclusiv/i.test(lower);

    // captura região/tamanho (sem exigir cm)
    const maybeRegion = extractBodyRegion(message);
    if (!session.bodyRegion && maybeRegion) session.bodyRegion = maybeRegion;

    const maybeSizeLoc = extractSizeLocation(message);
    if (!session.sizeLocation && maybeSizeLoc) session.sizeLocation = maybeSizeLoc;

    // 0) Chegou imagem -> salva, gera resumo, reseta flags (nova referência)
    if (imageUrl) {
      try {
        const dataUrl = await fetchImageAsDataUrl(imageUrl, imageMime);
        session.imageDataUrl = dataUrl;
        session.imageSummary = await describeImageForClient(dataUrl);

        session.sentSummary = false;
        session.sentPayments = false;
        session.sentQuote = false;

        session.stage = "aguardando_info";
      } catch (e) {
        console.error("[IMG] failed:", e?.message || e);
      }
    }

    // 1) Criação
    if (askedCreation) {
      const reply = msgCriacao();
      if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
    }

    // 2) Cobertura (se ainda não tem imagem)
    if (session.isCoverup && !session.imageDataUrl) {
      const reply = msgCoberturaPedirFoto();
      if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
      session.stage = "aguardando_referencia";
      return;
    }

    // 3) Fluxo inicial
    if (session.stage === "inicio") {
      const reply = msgInicio();
      if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
      session.stage = "aguardando_referencia";
      return;
    }

    // 4) Aguardando referência
    if (session.stage === "aguardando_referencia") {
      if (!session.imageDataUrl) {
        const wantsPrice = /valor|preço|orc|orç|quanto/i.test(lower);
        const reply = wantsPrice ? msgInicio() : "Me manda a referência em *imagem* pra eu avaliar certinho 🙏";
        if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
        return;
      }
      session.stage = "aguardando_info";
    }

    // 5) Detectar sinal/comprovante e NOTIFICAR você
    const proofByText = looksLikeProofText(message);
    const sentImageNow = Boolean(imageUrl);

    if (session.status === "AGUARDANDO_SINAL" && (proofByText || sentImageNow)) {
      session.status = "SINAL_PAGO";

      const clientMsg =
        "Perfeito — recebendo aqui ✅\n" +
        "Vou conferir e já te respondo com as opções de data/horário pra deixar tudo certinho.";

      if (!antiRepeat(session, clientMsg)) await zapiSendText(phone, clientMsg);

      const ownerMsg =
        `✅ SINAL / COMPROVANTE RECEBIDO\n` +
        `Cliente: ${phone}\n` +
        `Quando: ${nowBR()}\n` +
        `Orçamento (último): ${session.lastQuoteValue ? "R$ " + session.lastQuoteValue : "não registrado"}\n` +
        `Ação: colocar na agenda e confirmar horário.`;

      await notifyOwner(ownerMsg);
      return;
    }

    // 6) Com imagem, mas faltam infos mínimas: pelo menos local/região OU tamanho
    if (session.imageDataUrl && session.stage === "aguardando_info") {
      if (!session.bodyRegion && !session.sizeLocation) {
        const reply = msgPedirLocalOuTamanho();
        if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
        return;
      }

      // 6.1) Explica o valor do trabalho (UMA VEZ)
      if (!session.sentSummary && session.imageSummary) {
        const intro =
          "Perfeito, recebi a referência.\n" +
          "Antes de falar de valor, deixa eu te explicar o que esse projeto exige pra ficar bem feito:\n\n" +
          session.imageSummary;

        if (!antiRepeat(session, intro)) await zapiSendText(phone, intro);
        session.sentSummary = true;
      }

      // 6.2) Calcula com tamanho OU só região
      const infoParaCalculo =
        session.sizeLocation ||
        (session.bodyRegion ? `Região do corpo: ${session.bodyRegion} (tamanho não informado)` : "não informado");

      const hours = await estimateHoursInternal(session.imageDataUrl, infoParaCalculo, session.isCoverup);
      const sessoes = sessionsFromHours(hours);
      const valor = calcPriceFromHours(hours);

      // 6.3) Pagamentos e sessões (UMA VEZ)
      if (!session.sentPayments) {
        const bloco = msgPagamentosESessoes(sessoes);
        if (!antiRepeat(session, bloco)) await zapiSendText(phone, bloco);
        session.sentPayments = true;
      }

      // 6.4) Valor (UMA VEZ) + Pix
      if (!session.sentQuote) {
        const final = msgFechamentoValor(valor);
        if (!antiRepeat(session, final)) await zapiSendText(phone, final);
        session.sentQuote = true;

        session.lastQuoteValue = valor;
        session.status = "AGUARDANDO_SINAL";
        session.stage = "pos_orcamento";
      }

      return;
    }

    // 7) Pós orçamento
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

      // Cliente quer fechar -> manda Pix e muda status
      if (/fech|vamos|bora|quero|topo|ok|fechar/i.test(lower)) {
        const reply = msgSinalPix();
        if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
        session.status = "AGUARDANDO_SINAL";
        return;
      }

      // Se o cliente manda mais info de local/tamanho depois, recalcula uma vez
      if (maybeRegion || maybeSizeLoc) {
        session.sentPayments = false;
        session.sentQuote = false;
        session.stage = "aguardando_info";
        const reply = "Perfeito — com essa informação eu consigo ajustar o orçamento certinho. Só um instante.";
        if (!antiRepeat(session, reply)) await zapiSendText(phone, reply);
        return;
      }

      const reply =
        "Perfeito.\n" +
        "Se você quiser, me confirma só o *local no corpo* (e o tamanho, se souber) pra eu ajustar tudo certinho — ou me diz se prefere seguir com esse formato mesmo.";
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
