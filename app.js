/**
 * app.js — DW WhatsApp Bot (Z-API webhook) — BASE “QUE FUNCIONAVA” + ajustes novos
 *
 * Mantém o SEND da Z-API IGUAL ao antigo (pra não quebrar instância).
 *
 * Ajustes incluídos:
 * - Tom mais profissional + parágrafos
 * - Pergunta dupla junto: (região do corpo) + (fiel vs alterar algo)
 * - Não fala de “7 horas” quando o projeto cabe em 1 sessão (só menciona divisão quando precisar)
 * - Pagamento: Pix / Débito / Crédito até 12x (taxa conforme parcelas)
 * - Sinal: R$ 50
 * - Remarcação: 48h de aviso prévio
 * - Retoque incluso 40–50 dias (se necessário)
 * - Cobertura: pede foto e já avisa que raramente pega
 * - Opção de “sessões mensais” com ajuste: +R$150 por sessão extra (quando cliente pedir dividir)
 * - Anti-repetição: messageId + cooldown + evita re-perguntar o que já respondeu
 *
 * ENV no Render:
 *   ZAPI_INSTANCE_ID            (ID da instância)
 *   ZAPI_INSTANCE_TOKEN         (Token da instância)
 *   ZAPI_CLIENT_TOKEN           (Client token)
 *   PIX_KEY                     (sua chave pix)
 *   PERSONAL_PHONE_NOTIFY       (seu whats pessoal p/ avisos: 55DDDNUMERO)
 *   PORT                        (Render injeta; fallback 10000)
 *   BOT_NAME                    (opcional)
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

const PIX_KEY = process.env.PIX_KEY || "dwtattooshop@gmail.com";
const PERSONAL_PHONE_NOTIFY = process.env.PERSONAL_PHONE_NOTIFY || ""; // ex: 5544999999999
const BOT_NAME = process.env.BOT_NAME || "DW Tattoo";

const DEPOSIT_VALUE = 50; // sinal fixo
const RESCHEDULE_NOTICE_HOURS = 48;
const RETOUCH_WINDOW_DAYS = "40 a 50";

// Regras por região:
const PRICE = {
  normal: { firstHour: 150, nextHour: 100 }, // antebraço/costas/perna/etc
  sensitive: { firstHour: 150, nextHour: 120 }, // mão/pé/pescoço/costela
};

// “sessões mensais”: +R$150 por sessão extra (quando cliente pedir dividir)
const MONTHLY_EXTRA_PER_SESSION = 150;

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
      stage: "new", // new -> asked_ref -> got_ref -> asked_area_style -> asked_size -> quote_sent -> waiting_schedule
      hasReference: false,
      lastImageSeen: false,
      wantFidelity: "", // "fiel" | "adaptar"
      area: "", // "mão", "antebraço", etc.
      sizeHint: "", // pequeno|medio|grande|fechado|cm
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
app.get("/health", (_, res) =>
  res.status(200).json({
    ok: true,
    bot: BOT_NAME,
    env: {
      instanceId: !!process.env.ZAPI_INSTANCE_ID,
      instanceToken: !!process.env.ZAPI_INSTANCE_TOKEN,
      clientToken: !!process.env.ZAPI_CLIENT_TOKEN,
      pixKey: !!process.env.PIX_KEY,
      personalNotify: !!process.env.PERSONAL_PHONE_NOTIFY,
    },
  })
);

// reset geral (pra testes)
app.get("/reset", (_, res) => {
  convo.clear();
  lastBotReplyAt.clear();
  seenMessageIds.clear();
  res.status(200).send("OK – reset geral.");
});

/**
 * Webhook principal (configurar no Z-API: Ao receber -> https://SEU_RENDER_URL/zapi )
 */
app.post("/zapi", async (req, res) => {
  try {
    const incoming = normalizeIncoming(req.body);

    if (!incoming.phone) return res.status(200).json({ ok: true });

    // Dedupe por messageId (se tiver)
    if (incoming.messageId) {
      if (seenMessageIds.has(incoming.messageId)) {
        return res.status(200).json({ ok: true, deduped: true });
      }
      seenMessageIds.set(incoming.messageId, Date.now());
      cleanupSeenIds();
    }

    // Cooldown por número
    const last = lastBotReplyAt.get(incoming.phone) || 0;
    if (Date.now() - last < MSG_COOLDOWN_MS) {
      return res.status(200).json({ ok: true, throttled: true });
    }

    // Ignorar mensagens enviadas por você (caso Z-API notifique as suas)
    if (incoming.fromMe) {
      return res.status(200).json({ ok: true, fromMe: true });
    }

    const state = getState(incoming.phone);

    // Notifica seu Whats pessoal se detectar “paguei/comprovante”
    if (shouldNotifyDeposit(incoming)) {
      await notifyPersonal(incoming);
    }

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

  // comando de reset (por Whats)
  if (/^(\/reset|reset)$/i.test(text)) {
    convo.delete(incoming.phone);
    return "Conversa resetada. Pode me mandar a referência em imagem e me dizer a região do corpo.";
  }

  // cobertura
  if (/cobertura|cobrir/i.test(text)) {
    return [
      "Sobre **cobertura**: eu preciso analisar por foto.",
      "",
      "Mas já te adianto que eu **raramente pego cobertura**, porque meu estilo (realismo/whip shading) é delicado e precisa de contraste controlado e pele “respirando” pra ficar bonito e durar bem.",
      "",
      "Se você quiser, me manda uma foto bem nítida da tattoo atual que eu te digo com sinceridade se dá pra fazer com qualidade.",
    ].join("\n");
  }

  // Se recebeu imagem: marca referência recebida
  if (incoming.isImage) {
    state.hasReference = true;
    state.lastImageSeen = true;

    // tenta extrair região + fidelidade do caption/texto
    const area = extractArea(text);
    if (area) state.area = area;

    const fidelity = extractFidelity(text);
    if (fidelity) state.wantFidelity = fidelity;

    // Se ainda falta região ou fidelidade, pede as duas juntas (sem repetir depois)
    if (!state.area || !state.wantFidelity) {
      state.stage = "asked_area_style";
      return [
        "Perfeito, recebi a referência.",
        "",
        "Me confirma só duas coisas pra eu fechar certinho:",
        "• **Qual região do corpo** você quer tatuar? (ex: mão, antebraço, costela, perna, costas)",
        "• Você quer **bem fiel à referência** ou quer **alterar algo** (adicionar/remover/ajustar)?",
      ].join("\n");
    }

    // Se já tem região + fidelidade, pede tamanho
    if (!state.sizeHint) {
      state.stage = "asked_size";
      return [
        "Show.",
        "",
        "E você imagina essa peça mais **pequena/discreta**, **média** (pegando bem a região) ou **maior/fechando a área**?",
        "Se souber em **cm**, pode me dizer também (não é obrigatório).",
      ].join("\n");
    }

    // Se já tem tudo, fecha orçamento
    return await buildQuoteMessage(incoming, state);
  }

  // Se é novo
  if (state.stage === "new") {
    if (looksLikeBudgetRequest(text)) {
      state.stage = "asked_ref";
      // já tenta pegar região e fidelidade do texto
      const area = extractArea(text);
      if (area) state.area = area;
      const fidelity = extractFidelity(text);
      if (fidelity) state.wantFidelity = fidelity;

      return [
        "Perfeito. Pra eu te passar um orçamento bem justo, me manda uma **referência em imagem**.",
        "",
        "Se já souber, me diz também:",
        "• **Região do corpo**",
        "• Se quer **fiel à referência** ou **alterar algo**",
      ].join("\n");
    }

    // Abertura geral
    state.stage = "asked_ref";
    return [
      "Opa! Tudo certo?",
      "",
      "Me manda a tua **referência em imagem** e me diz:",
      "• **Região do corpo**",
      "• Se quer **fiel** ou **alterar algo** (adicionar/remover/ajustar)",
    ].join("\n");
  }

  // Se está esperando referência
  if (!state.hasReference && state.stage === "asked_ref") {
    // tenta capturar infos do texto enquanto não vem imagem
    const area = extractArea(text);
    if (area) state.area = area;

    const fidelity = extractFidelity(text);
    if (fidelity) state.wantFidelity = fidelity;

    const size = extractSizeHint(text);
    if (size) state.sizeHint = size;

    return [
      "Fechou.",
      "",
      "Agora me manda uma **referência em imagem** pra eu analisar certinho e te passar a proposta completa (com detalhes + valor).",
    ].join("\n");
  }

  // Se já tem referência, mas faltam dados -> coletar sem ficar repetindo
  if (state.hasReference) {
    // Atualiza dados se o cliente respondeu tudo em uma frase
    const fidelity = extractFidelity(text);
    if (fidelity) state.wantFidelity = fidelity;

    const area = extractArea(text);
    if (area) state.area = area;

    const size = extractSizeHint(text);
    if (size) state.sizeHint = size;

    // Se ainda falta região/fidelidade, pede as duas juntas
    if (!state.area || !state.wantFidelity) {
      state.stage = "asked_area_style";
      return [
        "Show.",
        "",
        "Só pra eu fechar certinho:",
        "• **Região do corpo**",
        "• **Fiel à referência** ou quer **alterar algo**?",
      ].join("\n");
    }

    // Se falta tamanho
    if (!state.sizeHint) {
      state.stage = "asked_size";
      return [
        "Boa.",
        "",
        "E o tamanho você imagina mais **pequeno**, **médio** ou **grande/fechando a área**?",
        "Se souber em **cm**, pode mandar também.",
      ].join("\n");
    }

    // Se tem tudo, fecha orçamento
    return await buildQuoteMessage(incoming, state);
  }

  // fallback
  return null;
}

async function buildQuoteMessage(incoming, state) {
  // 1) Análise/explicação (sem falar de horas pro cliente)
  const analysisText = buildBaseAnalysis(state);

  // 2) Estimativa interna + cálculo
  const areaType = isSensitiveArea(state.area) ? "sensitive" : "normal";
  const hoursInternal = estimateHoursInternal(state, analysisText);
  const price = calcPrice(hoursInternal, PRICE[areaType]);
  const sessions = Math.max(1, Math.ceil(hoursInternal / 7));

  state.lastQuote = { hoursInternal, price, sessions, areaType };
  state.stage = "quote_sent";

  // 3) Texto de sessão (só fala de “dividir” quando precisar)
  const sessionBlock =
    sessions <= 1
      ? "Pelo encaixe e nível de detalhe, esse projeto fica bem resolvido em **uma sessão**."
      : [
          "Pelo nível de detalhe e pra manter o padrão de acabamento, o ideal é fazer em **2 sessões**.",
          "Assim eu consigo manter o contraste limpo, as transições bem controladas e o resultado fica mais confortável pra você.",
        ].join("\n");

  const paymentBlock = [
    "Formas de pagamento:",
    "• Pix",
    "• Débito",
    "• Crédito em até 12x (**com taxa da maquininha**, conforme o número de parcelas)",
  ].join("\n");

  const retouchLine = `O orçamento já inclui **1 sessão de retoque** (se necessário), entre **${RETOUCH_WINDOW_DAYS} dias** após a cicatrização.`;

  const depositBlock = [
    `Pra reservar o horário, eu peço um sinal de **R$ ${formatBRL(DEPOSIT_VALUE)}**.`,
    `Chave Pix: ${PIX_KEY}`,
    `Remarcação: pode ajustar a data com **${RESCHEDULE_NOTICE_HOURS}h de aviso prévio**.`,
  ].join("\n");

  const monthlyOption = [
    "Se ficar pesado pagar tudo de uma vez, dá pra organizar em **sessões mensais**.",
    `Nesse formato existe um ajuste no total: **+R$ ${formatBRL(MONTHLY_EXTRA_PER_SESSION)} por sessão extra** (por causa da logística e reserva de agenda).`,
    "Se você quiser assim, me fala em quantas sessões você prefere que eu te passo as opções certinhas.",
  ].join("\n");

  // 4) CTA agenda (direto ao ponto)
  const scheduleBlock = [
    "Pra gente marcar:",
    "Você prefere **horário comercial** ou **pós-expediente**?",
    "E tem alguma **data em mente**? Se não tiver, eu te passo a **mais próxima disponível**.",
  ].join("\n");

  return [
    "Perfeito. Analisei tua referência com atenção e te explico certinho antes do valor:",
    "",
    analysisText,
    "",
    sessionBlock,
    "",
    paymentBlock,
    "",
    retouchLine,
    "",
    `Pelo tamanho e complexidade do projeto, o investimento fica em **R$ ${formatBRL(price)}**.`,
    "",
    depositBlock,
    "",
    monthlyOption,
    "",
    scheduleBlock,
  ].join("\n");
}

/* =======================
   Análise (texto vendedor/técnico)
======================= */
function buildBaseAnalysis(state) {
  const fidelityText =
    state.wantFidelity === "fiel"
      ? "Como você quer **fiel à referência**, o foco aqui é manter leitura, proporção e contraste bem iguais, com acabamento limpo."
      : "Como você quer **alterar/ajustar**, eu mantenho o estilo da referência e adapto o encaixe/composição pra ficar mais forte na anatomia.";

  const sizeTxt = state.sizeHint ? `Tamanho: **${state.sizeHint}**.` : "Tamanho: **estimado pela referência**.";

  return [
    `Na região de **${state.area || "—"}**, esse tipo de peça pede construção de **volumes (luz/sombra)**, transições bem controladas e contraste certo pra **envelhecer bonito**.`,
    "O que mais pesa no valor é o nível de acabamento: definição de profundidade, textura e leitura de longe (pra não “apagar” com o tempo).",
    fidelityText,
    sizeTxt,
  ].join("\n");
}

/* =======================
   Estimativa interna (sem IA)
   (ajustada pra não “viajar” em mão/peito etc)
======================= */
function estimateHoursInternal(state, analysisText) {
  const area = (state.area || "").toLowerCase();
  const sensitive = isSensitiveArea(area);

  // Base por região
  let baseHours = 3.2;
  if (sensitive) baseHours = 2.8; // mão/pé/pescoço/costela geralmente 2.5–3.5 no teu padrão
  if (/(costas|peito)/i.test(area)) baseHours = 5.0;
  if (/(coxa|perna|panturrilha)/i.test(area)) baseHours = 4.2;
  if (/(antebraço|braço)/i.test(area)) baseHours = 3.8;

  // Tamanho
  const size = (state.sizeHint || "medio").toLowerCase();
  let mult = 1.0;

  // aceita cm (ex: "15cm")
  const cm = parseCm(size);
  if (cm) {
    if (cm <= 10) mult = 0.9;
    else if (cm <= 15) mult = 1.0;
    else if (cm <= 20) mult = 1.2;
    else mult = 1.35;
  } else {
    if (/(pequen)/i.test(size)) mult = 0.9;
    if (/(m[eé]dio|medio|normal)/i.test(size)) mult = 1.0;
    if (/(grand|maior)/i.test(size)) mult = 1.25;
    if (/(fechar|fechado|inteiro|todo|completo)/i.test(size)) mult = 1.45;
  }

  // Complexidade por palavras
  const blob = `${analysisText} ${state.notes || ""} ${state.wantFidelity || ""}`.toLowerCase();
  let points = 0;

  // realismo/retrato/animal
  if (/(realismo|retrato|rosto|olhos|pele|textura|animal|leão|tigre|lobo)/i.test(blob)) points += 2;

  // elementos extras/fundo
  if (/(caveira|mão|anjo|catedral|fumaça|fundo|cenário|ornamento|muito detalhe)/i.test(blob)) points += 1;

  // fidelidade costuma exigir mais precisão
  if (state.wantFidelity === "fiel") points += 0.5;

  // Converte em horas
  let hours = baseHours * mult + points * 0.9;

  // Travas
  if (sensitive) hours = clamp(hours, 2.5, 3.5);
  if (!sensitive && /(rosto|retrato|realismo)/i.test(blob) && mult >= 1.0) {
    hours = clamp(hours, 6.0, 9.0);
  }

  // arredonda pra 0.5
  hours = Math.ceil(hours * 2) / 2;
  return hours;
}

function calcPrice(hours, cfg) {
  if (hours <= 1) return cfg.firstHour;
  const extra = hours - 1;
  return Math.round(cfg.firstHour + extra * cfg.nextHour);
}

/* =======================
   Notificação “pago/comprovante”
======================= */
function shouldNotifyDeposit(incoming) {
  if (!PERSONAL_PHONE_NOTIFY) return false;

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
  const imagePossibleReceipt = incoming.isImage && (!incoming.text || incoming.text.trim() === "");

  return hit || imagePossibleReceipt;
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
   Z-API send text (IGUAL AO ANTIGO)
======================= */
async function sendText(phone, message) {
  const url = `https://api.z-api.io/instances/${ZAPI_INSTANCE_ID}/token/${ZAPI_INSTANCE_TOKEN}/send-text`;

  const payload = { phone, message };

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

  const fromMe = Boolean(body?.fromMe ?? body?.data?.fromMe ?? body?.data?.key?.fromMe ?? false);

  const text =
    body?.text?.message ||
    body?.message ||
    body?.body ||
    body?.data?.text ||
    body?.data?.message ||
    body?.data?.body ||
    "";

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
  if (digits.length === 11 || digits.length === 10) return "55" + digits;
  return digits;
}

/* =======================
   Extração (fidelidade/área/tamanho)
======================= */
function extractFidelity(text) {
  const t = (text || "").toLowerCase();
  if (/(fiel|igual|bem fiel|na referência|na referencia|idêntic|identic)/i.test(t)) return "fiel";
  if (/(adapt|encaixe|composição|composicao|ajust|mudar|alterar|adicionar|remover)/i.test(t)) return "adaptar";
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
    { k: ["abdômen", "abdomen", "barriga"], v: "abdômen" },
  ];

  for (const it of map) {
    if (it.k.some((w) => t.includes(w))) return it.v;
  }
  return "";
}

function extractSizeHint(text) {
  const t = (text || "").toLowerCase();

  // cm
  const cm = t.match(/(\d{1,3})\s*(cm|cent[ií]metros?)/i);
  if (cm) return `${cm[1]}cm`;

  if (/(pequen|discret)/i.test(t)) return "pequeno";
  if (/(m[eé]dio|medio|normal|pegando bem)/i.test(t)) return "médio";
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

function parseCm(s) {
  const m = String(s || "").match(/(\d{1,3})\s*cm/i);
  if (!m) return 0;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : 0;
}

function cleanupSeenIds() {
  const now = Date.now();
  for (const [id, ts] of seenMessageIds.entries()) {
    if (now - ts > 1000 * 60 * 30) seenMessageIds.delete(id);
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
  console.log(`[ENV] instanceId=${process.env.ZAPI_INSTANCE_ID ? "OK" : "MISSING"} instanceToken=${process.env.ZAPI_INSTANCE_TOKEN ? "OK" : "MISSING"} clientToken=${process.env.ZAPI_CLIENT_TOKEN ? "OK" : "MISSING"}`);
});
