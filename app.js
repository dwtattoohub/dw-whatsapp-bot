/**
 * app.js — WhatsApp bot (Z-API webhook) com:
 * - Respostas mais humanas/profissionais (sem “assinar”)
 * - Não fala de horas pro cliente (horas são só internas)
 * - Estimativa de preço coerente por região/tamanho/complexidade
 * - Sessões (máx. 7h por sessão) + retoque 40–50 dias
 * - Pagamento (Pix/Débito/Crédito até 12x) + sinal (R$100 ou 10%)
 * - Pix key configurável por ENV
 * - Anti-repetição (dedupe por messageId + cooldown)
 * - Notificação pro seu Whats pessoal quando detectar “paguei / comprovante”
 *
 * ENV no Render (Environment -> Add):
 *   OPENAI_API_KEY              (opcional, se quiser visão/descrição mais forte)
 *   ZAPI_INSTANCE_ID            (ID da instância)
 *   ZAPI_INSTANCE_TOKEN         (Token da instância)
 *   ZAPI_CLIENT_TOKEN           (Client token / token de integração)
 *   PIX_KEY                     (sua chave pix)
 *   PERSONAL_PHONE_NOTIFY       (seu whats pessoal no formato 55DDDNUMERO)
 *   PORT                        (Render já injeta, mas pode setar)
 */

import express from "express";

const app = express();
app.use(express.json({ limit: "25mb" }));

/* =======================
   ENV / Config
======================= */
const PORT = process.env.PORT || 10000;

const ZAPI_INSTANCE_ID = requireEnv("ZAPI_INSTANCE_ID");
const ZAPI_INSTANCE_TOKEN = requireEnv("ZAPI_INSTANCE_TOKEN");
const ZAPI_CLIENT_TOKEN = requireEnv("ZAPI_CLIENT_TOKEN");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const PIX_KEY = process.env.PIX_KEY || "CHAVE_PIX_AQUI";
const PERSONAL_PHONE_NOTIFY = process.env.PERSONAL_PHONE_NOTIFY || ""; // ex: 5544999999999

// Preço por região:
const PRICE = {
  normal: { firstHour: 150, nextHour: 100 }, // antebraço/costa/perna/etc
  sensitive: { firstHour: 150, nextHour: 120 }, // mão/pé/pescoço/costela
};

const MAX_SESSION_HOURS = 7;

// Anti-spam/repetição:
const MSG_COOLDOWN_MS = 3500;

/* =======================
   Estado em memória
======================= */
const seenMessageIds = new Map(); // messageId -> timestamp
const lastBotReplyAt = new Map(); // phone -> timestamp
const convo = new Map(); // phone -> state

function getState(phone) {
  if (!convo.has(phone)) {
    convo.set(phone, {
      stage: "new", // new -> asked_ref -> got_ref -> asked_style -> asked_area -> quote_sent -> deposit_wait
      lastImageSeen: false,
      hasReference: false,
      wantFidelity: "", // "fiel" | "adaptar"
      area: "", // "mão", "antebraço", etc.
      sizeHint: "", // pequeno|medio|grande|fechado
      notes: "",
      lastQuote: null,
    });
  }
  return convo.get(phone);
}

/* =======================
   Rotas básicas
======================= */
app.get("/", (_, res) => res.status(200).send("ok"));
app.get("/health", (_, res) => res.status(200).json({ ok: true }));

/**
 * Webhook principal (configurar no Z-API: Ao receber -> https://SEU_RENDER_URL/zapi )
 */
app.post("/zapi", async (req, res) => {
  try {
    const incoming = normalizeIncoming(req.body);
    console.log("[ZAPI IN] raw:", safeJson(req.body));

    if (!incoming.phone) return res.status(200).json({ ok: true });

    // Dedupe por messageId (se tiver)
    if (incoming.messageId) {
      if (seenMessageIds.has(incoming.messageId)) {
        return res.status(200).json({ ok: true, deduped: true });
      }
      seenMessageIds.set(incoming.messageId, Date.now());
      cleanupSeenIds();
    }

    // Cooldown por número (evita repetir por múltiplos eventos)
    const last = lastBotReplyAt.get(incoming.phone) || 0;
    if (Date.now() - last < MSG_COOLDOWN_MS) {
      return res.status(200).json({ ok: true, throttled: true });
    }

    // Ignorar mensagens enviadas por você (se Z-API estiver notificando as suas)
    if (incoming.fromMe) {
      return res.status(200).json({ ok: true, fromMe: true });
    }

    const state = getState(incoming.phone);

    console.log("[ZAPI IN] phone:", incoming.phone);
    console.log("[ZAPI IN] text:", incoming.text);
    console.log("[ZAPI IN] isImage:", incoming.isImage);
    console.log("[ZAPI IN] imageUrl:", incoming.imageUrl || null);

    // Se detectar pagamento/comprovante -> notifica seu Whats pessoal
    if (shouldNotifyDeposit(incoming)) {
      await notifyPersonal(incoming);
    }

    // Fluxo principal
    const reply = await buildReply(incoming, state);

    if (reply) {
      await sendText(incoming.phone, reply);
      lastBotReplyAt.set(incoming.phone, Date.now());
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("[WEBHOOK ERROR]", err?.message || err);
    return res.status(200).json({ ok: true });
  }
});

/* =======================
   Lógica de conversa
======================= */
async function buildReply(incoming, state) {
  const text = (incoming.text || "").trim();

  // Se recebeu imagem: marca referência recebida
  if (incoming.isImage) {
    state.hasReference = true;
    state.lastImageSeen = true;

    // tenta extrair “onde no corpo” do texto/caption se houver
    const area = extractArea(text);
    if (area) state.area = area;

    // pergunta de fidelidade se ainda não tem
    if (!state.wantFidelity) {
      state.stage = "asked_style";
      return [
        "Perfeito, recebi a referência.",
        "",
        "Me diz só: você quer essa ideia bem fiel à referência, ou prefere que eu adapte pro seu corpo (encaixe e composição) mantendo o estilo?",
      ].join("\n");
    }
  }

  // Se respondeu fidelidade
  if (!incoming.isImage && state.stage === "asked_style") {
    const fidelity = extractFidelity(text);
    if (fidelity) state.wantFidelity = fidelity;

    // pede área se ainda não tem
    if (!state.area) {
      state.stage = "asked_area";
      return "Show. E em qual região do corpo você quer fazer? (ex: mão, antebraço, costela, perna, costas)";
    }

    // se já tem área, pede tamanho (sem cm)
    if (!state.sizeHint) {
      state.stage = "asked_size";
      return "E você imagina mais pequeno e discreto, médio (pegando bem a região) ou maior/fechando a área?";
    }
  }

  // Se respondeu área
  if (!incoming.isImage && state.stage === "asked_area") {
    const area = extractArea(text);
    if (area) state.area = area;

    if (!state.area) {
      return "Entendi. Só me fala a região certinha do corpo pra eu fechar certinho (mão, antebraço, costela, pescoço, perna, costas…).";
    }

    // pede tamanho (sem cm)
    state.stage = "asked_size";
    return "Boa. E você imagina mais pequeno e discreto, médio (pegando bem a região) ou maior/fechando a área?";
  }

  // Se respondeu tamanho
  if (!incoming.isImage && state.stage === "asked_size") {
    state.sizeHint = extractSizeHint(text) || "medio";

    // se ainda não tem fidelidade, pede
    if (!state.wantFidelity) {
      state.stage = "asked_style";
      return "Fechou. Você prefere bem fiel à referência ou adaptar pro encaixe do seu corpo mantendo o estilo?";
    }

    // Se não tem referência ainda, pede imagem
    if (!state.hasReference) {
      state.stage = "asked_ref";
      return "Perfeito. Pra eu te passar um orçamento justo, me manda uma referência em imagem do que você quer fazer.";
    }

    // Agora fecha orçamento
    return await buildQuoteMessage(incoming, state);
  }

  // Se é novo e ainda não tem referência
  if (state.stage === "new") {
    // Se o texto já indica pedido de orçamento
    if (looksLikeBudgetRequest(text)) {
      state.stage = "asked_ref";
      return [
        "Opa! Tudo certo?",
        "Obrigado por me chamar e confiar no meu trampo.",
        "",
        "Pra eu te passar um orçamento bem justo, me manda uma referência em imagem do que você quer fazer e me diz em qual região do corpo você pretende tatuar.",
      ].join("\n");
    }

    // Qualquer abertura
    return [
      "Opa! Tudo certo?",
      "Me conta a ideia do que você quer tatuar e em qual região do corpo — se já tiver referência em imagem, pode mandar também.",
    ].join("\n");
  }

  // Se estava esperando referência e o cliente não mandou imagem ainda
  if (!state.hasReference && (state.stage === "asked_ref" || state.stage === "new")) {
    if (text) {
      // tenta pegar região e tamanho já pelo texto
      const area = extractArea(text);
      if (area) state.area = area;
      const size = extractSizeHint(text);
      if (size) state.sizeHint = size;

      return "Fechou. Agora me manda uma referência em imagem pra eu avaliar certinho (aí eu te explico os detalhes e fecho o orçamento).";
    }
  }

  // Se já mandou imagem, mas não respondeu fidelidade/tamanho/área
  if (state.hasReference) {
    // Se respondeu algo que define fidelidade
    const fidelity = extractFidelity(text);
    if (fidelity) state.wantFidelity = fidelity;

    // Se respondeu área
    const area = extractArea(text);
    if (area) state.area = area;

    // Se respondeu tamanho
    const size = extractSizeHint(text);
    if (size) state.sizeHint = size;

    // Se já tem o mínimo, fecha
    if (state.wantFidelity && state.area && state.sizeHint) {
      return await buildQuoteMessage(incoming, state);
    }

    // Senão, pergunta o que falta sem repetir em loop
    if (!state.wantFidelity) {
      state.stage = "asked_style";
      return "Me diz só: você quer bem fiel à referência, ou prefere que eu adapte pro encaixe do seu corpo mantendo o estilo?";
    }
    if (!state.area) {
      state.stage = "asked_area";
      return "E em qual região do corpo você quer fazer?";
    }
    if (!state.sizeHint) {
      state.stage = "asked_size";
      return "E você imagina mais pequeno e discreto, médio (pegando bem a região) ou maior/fechando a área?";
    }
  }

  return null;
}

async function buildQuoteMessage(incoming, state) {
  // 1) Analisa/explica a peça (sem falar de horas)
  const analysisText = await describeReference(incoming, state);

  // 2) Estima horas INTERNAS e calcula preço
  const areaType = isSensitiveArea(state.area) ? "sensitive" : "normal";
  const hours = estimateHoursInternal(state, analysisText);
  const price = calcPrice(hours, PRICE[areaType]);

  // 3) Sessões (máx 7h)
  const sessions = Math.max(1, Math.ceil(hours / MAX_SESSION_HOURS));

  // 4) Sinal: R$100 se >= 1000, senão 10%
  const deposit = price >= 1000 ? 100 : Math.max(100, Math.round(price * 0.1)); // mantém mínimo 100

  state.lastQuote = { hours, price, sessions, areaType, deposit };
  state.stage = "quote_sent";

  const paymentsBlock = [
    "Pagamento:",
    "• Pix",
    "• Débito",
    "• Crédito em até 12x",
  ].join("\n");

  const sessionsLine =
    sessions === 1
      ? "Eu trabalho com sessão de até 7 horas pra manter qualidade e acabamento."
      : `Pela complexidade, o ideal é dividir em ${sessions} sessões (cada uma com até 7 horas) pra garantir um resultado bem feito e confortável.`;

  const retouchLine =
    "E o orçamento já inclui 1 sessão de retoque (se necessário) entre 40 e 50 dias após cicatrização.";

  const installmentLine =
    "Se preferir, dá pra fazer em sessões mensais (com ajuste no total), pra ficar mais leve no planejamento.";

  // Mensagem final (profissional, humana, sem “assinar”)
  return [
    "Perfeito. Dei uma olhada com carinho na tua referência e te explico certinho antes do valor:",
    "",
    analysisText,
    "",
    sessionsLine,
    paymentsBlock ? "\n" + paymentsBlock : "",
    "",
    retouchLine,
    installmentLine,
    "",
    `Pelo tamanho e complexidade do projeto, o investimento fica em R$ ${formatBRL(price)}.`,
    "",
    `Pra reservar seu horário, eu peço um sinal de R$ ${formatBRL(deposit)}.`,
    `Chave Pix: ${PIX_KEY}`,
    "Assim que confirmar o Pix, me manda o comprovante aqui que eu já te passo as opções de agenda certinhas.",
  ]
    .filter(Boolean)
    .join("\n");
}

/* =======================
   Análise da referência
======================= */
async function describeReference(incoming, state) {
  // Se tiver OpenAI e uma URL válida de imagem pública, tenta enriquecer a descrição.
  // Se não der (URL inválida), faz descrição “manual” baseada em palavras/estado.
  const base = buildBaseDescription(state);

  if (!OPENAI_API_KEY) return base;

  const url = incoming.imageUrl;
  if (!url || !isHttpUrl(url)) return base;

  try {
    // Observação: se a URL não for pública, o modelo vai retornar invalid_image_url.
    // Nesse caso, caímos no fallback.
    const vision = await openaiVisionDescribe(url, state);
    if (vision) return vision;
    return base;
  } catch (e) {
    console.log("[VISION FALLBACK]", e?.message || e);
    return base;
  }
}

function buildBaseDescription(state) {
  const fidelityText =
    state.wantFidelity === "fiel"
      ? "A proposta é manter a ideia bem fiel à referência, respeitando o encaixe e o fluxo do corpo."
      : "A proposta é adaptar o encaixe e a composição pro teu corpo mantendo o estilo da referência.";

  // Texto “vendedor” e técnico, mas sem revelar horas/por hora
  return [
    `Pelo que você pediu (${state.area || "região"}), esse tipo de peça exige construção de contraste, transição de sombras bem controlada e acabamento limpo pra não “estourar” com o tempo.`,
    "O ponto que mais pesa aqui é: definição de volumes (luz/sombra), textura e profundidade (principalmente em áreas de pele com mais movimento).",
    "Eu faço a leitura da referência e reorganizo a composição pra ficar harmoniosa na anatomia, mantendo o visual forte e bem profissional.",
    fidelityText,
  ].join("\n");
}

async function openaiVisionDescribe(imageUrl, state) {
  const prompt = [
    "Você é um tatuador profissional. Descreva de forma objetiva e convincente a complexidade da tatuagem na imagem para um cliente,",
    "sem falar de horas e sem falar de preço. Foque em: sombras, contraste, volumes, textura, profundidade, acabamento e encaixe anatômico.",
    "Tom: humano e profissional (WhatsApp). 6 a 10 linhas.",
    "",
    `Região: ${state.area || "não informado"}`,
    `Preferência: ${state.wantFidelity || "não informado"}`,
  ].join("\n");

  const body = {
    model: "gpt-4.1-mini",
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: prompt },
          { type: "input_image", image_url: imageUrl },
        ],
      },
    ],
  };

  const resp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const data = await resp.json();

  // Extrai texto
  const text = extractResponseText(data);
  if (!text) return "";
  return text.trim();
}

function extractResponseText(data) {
  try {
    // responses API: output -> [ { content: [ { type:'output_text', text:'...' } ] } ]
    const out = data?.output?.[0]?.content || [];
    for (const c of out) {
      if (c?.type === "output_text" && c?.text) return c.text;
    }
    return "";
  } catch {
    return "";
  }
}

/* =======================
   Estimativa (interno)
======================= */
function estimateHoursInternal(state, analysisText) {
  const area = (state.area || "").toLowerCase();
  const isSensitive = isSensitiveArea(area);

  // A) Base por região
  let baseHours = 3.5; // padrão
  if (isSensitive) baseHours = 2.5;
  if (/(costas|peito|coxa|panturrilha grande|fechar a perna)/i.test(area)) baseHours = 5.0;

  // B) Multiplicador por tamanho
  const size = (state.sizeHint || "medio").toLowerCase();
  let mult = 1.0;
  if (size === "pequeno") mult = 0.85;
  if (size === "medio") mult = 1.0;
  if (size === "grande") mult = 1.35;
  if (size === "fechado") mult = 1.6;

  // C) Complexidade por palavras (texto do cliente + análise)
  const blob = `${analysisText} ${state.notes || ""}`.toLowerCase();

  let points = 0;
  // Realismo / retrato / animal
  if (/(realismo|retrato|rosto|leão|tigre|lobo|olhos|pele|textura)/i.test(blob)) points += 2;
  // Elementos adicionais
  if (/(caveira|relógio|mão|sant|anjo|catedral|fumaça|fundo|cenário|ornamento|detalhe)/i.test(blob)) points += 1;
  // Fundo/ambiente pesado
  if (/(fundo trabalhado|cenário|muita fumaça|muita textura|muito detalhe|catedral)/i.test(blob)) points += 1;

  // Converte pontos em horas extras
  let hours = baseHours * mult + points * 1.0;

  // Travas por região (pra não “viajar”)
  if (isSensitive) hours = clamp(hours, 2.5, 4.0);
  // Rosto/realismo médio em antebraço costuma 6–8h
  if (!isSensitive && /(rosto|retrato|realismo)/i.test(blob) && mult >= 1.0) {
    hours = clamp(hours, 5.5, 9.0);
  }

  // Arredonda para 0.5
  hours = Math.ceil(hours * 2) / 2;

  return hours;
}

function calcPrice(hours, cfg) {
  if (hours <= 1) return cfg.firstHour;
  const extra = hours - 1;
  return Math.round(cfg.firstHour + extra * cfg.nextHour);
}

/* =======================
   Notificação de “pago/comprovante”
======================= */
function shouldNotifyDeposit(incoming) {
  const t = (incoming.text || "").toLowerCase();

  const keywords = [
    "paguei",
    "pix feito",
    "pix realizado",
    "transferi",
    "comprovante",
    "pagamento",
    "sinal",
    "enviei o comprovante",
  ];

  const hit = keywords.some((k) => t.includes(k));

  // Se vier imagem sem texto, também pode ser comprovante
  const imagePossibleReceipt = incoming.isImage && (!incoming.text || incoming.text.trim() === "");

  return (hit || imagePossibleReceipt) && !!PERSONAL_PHONE_NOTIFY;
}

async function notifyPersonal(incoming) {
  const msg = [
    "⚠️ Possível sinal/comprovante recebido",
    `Cliente: ${incoming.phone}`,
    incoming.isImage ? "Tipo: imagem (possível comprovante)" : `Mensagem: "${incoming.text || ""}"`,
  ].join("\n");

  await sendText(PERSONAL_PHONE_NOTIFY, msg);
}

/* =======================
   Z-API send text
======================= */
async function sendText(phone, message) {
  const url = `https://api.z-api.io/instances/${ZAPI_INSTANCE_ID}/token/${ZAPI_INSTANCE_TOKEN}/send-text`;

  const payload = {
    phone,
    message,
  };

  console.log("[ZAPI OUT] sending:", { phone, message: message?.slice(0, 120) + "..." });

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "client-token": ZAPI_CLIENT_TOKEN,
    },
    body: JSON.stringify(payload),
  });

  const data = await resp.json().catch(() => ({}));

  if (!resp.ok) {
    console.log("[ZAPI SEND] status:", resp.status, "body:", safeJson(data));
    throw new Error(`[ZAPI SEND FAILED] ${resp.status} ${safeJson(data)}`);
  }
  return data;
}

/* =======================
   Normalização do webhook
   (tenta suportar formatos diferentes da Z-API)
======================= */
function normalizeIncoming(body) {
  const phone =
    body?.phone ||
    body?.from ||
    body?.senderPhone ||
    body?.data?.phone ||
    body?.data?.from ||
    "";

  const messageId =
    body?.messageId ||
    body?.id ||
    body?.data?.messageId ||
    body?.data?.id ||
    body?.data?.key?.id ||
    "";

  const fromMe = Boolean(
    body?.fromMe ??
      body?.data?.fromMe ??
      body?.data?.key?.fromMe ??
      false
  );

  // Texto:
  const text =
    body?.text?.message ||
    body?.message ||
    body?.body ||
    body?.data?.text ||
    body?.data?.message ||
    body?.data?.body ||
    "";

  // Detecção de imagem:
  const isImage =
    Boolean(body?.image) ||
    Boolean(body?.data?.image) ||
    Boolean(body?.data?.media) ||
    Boolean(body?.data?.imageMessage) ||
    Boolean(body?.data?.message?.imageMessage) ||
    Boolean(body?.data?.message?.image) ||
    body?.type === "image" ||
    body?.data?.type === "image" ||
    false;

  // URL da imagem (se vier):
  const imageUrl =
    body?.image?.url ||
    body?.imageUrl ||
    body?.data?.image?.url ||
    body?.data?.media?.url ||
    body?.data?.imageUrl ||
    body?.data?.message?.image?.url ||
    body?.data?.message?.imageMessage?.url ||
    "";

  return {
    phone: normalizePhone(phone),
    messageId,
    fromMe,
    text: typeof text === "string" ? text : "",
    isImage: !!isImage,
    imageUrl: typeof imageUrl === "string" ? imageUrl : "",
  };
}

function normalizePhone(p) {
  if (!p) return "";
  const digits = String(p).replace(/\D/g, "");
  // garante com DDI 55 (se vier sem)
  if (digits.length === 11 || digits.length === 10) return "55" + digits;
  return digits;
}

/* =======================
   Extração de intenção (fidelidade/área/tamanho)
======================= */
function extractFidelity(text) {
  const t = (text || "").toLowerCase();
  if (/(fiel|igual|bem fiel|na referência|idêntic)/i.test(t)) return "fiel";
  if (/(adapt|encaixe|composição|melhorar encaixe|ajust)/i.test(t)) return "adaptar";
  return "";
}

function extractArea(text) {
  const t = (text || "").toLowerCase();

  const map = [
    { k: ["mão", "mao"], v: "mão" },
    { k: ["pé", "pe"], v: "pé" },
    { k: ["pescoço", "pescoco"], v: "pescoço" },
    { k: ["costela", "costelas"], v: "costela" },
    { k: ["antebraço", "antebraco"], v: "antebraço" },
    { k: ["braço", "braco"], v: "braço" },
    { k: ["perna", "panturrilha"], v: "perna" },
    { k: ["coxa"], v: "coxa" },
    { k: ["costas"], v: "costas" },
    { k: ["peito"], v: "peito" },
    { k: ["ombro"], v: "ombro" },
    { k: ["nuca"], v: "nuca" },
  ];

  for (const it of map) {
    if (it.k.some((w) => t.includes(w))) return it.v;
  }
  return "";
}

function extractSizeHint(text) {
  const t = (text || "").toLowerCase();
  if (/(pequen|discret|pequeno)/i.test(t)) return "pequeno";
  if (/(m[eé]dio|normal|palma|pegando bem)/i.test(t)) return "medio";
  if (/(grand|maior|bem grande)/i.test(t)) return "grande";
  if (/(fechar|fechado|fechando|inteiro|todo|completo)/i.test(t)) return "fechado";
  return "";
}

function looksLikeBudgetRequest(text) {
  const t = (text || "").toLowerCase();
  return /(valor|preço|preco|orçamento|orcamento|quanto fica|quanto custa)/i.test(t);
}

function isSensitiveArea(area) {
  const a = (area || "").toLowerCase();
  return /(mão|mao|pé|pe|pescoço|pescoco|costela)/i.test(a);
}

/* =======================
   Utilitários
======================= */
function formatBRL(n) {
  try {
    return Number(n).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  } catch {
    return String(n);
  }
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function isHttpUrl(url) {
  return /^https?:\/\//i.test(url);
}

function cleanupSeenIds() {
  const now = Date.now();
  for (const [id, ts] of seenMessageIds.entries()) {
    if (now - ts > 1000 * 60 * 30) seenMessageIds.delete(id); // 30min
  }
}

function requireEnv(name) {
  if (!process.env[name]) throw new Error(`Missing env var: ${name}`);
  return process.env[name];
}

function safeJson(obj) {
  try {
    return JSON.stringify(obj);
  } catch {
    return "[unstringifiable]";
  }
}

/* =======================
   Start
======================= */
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
