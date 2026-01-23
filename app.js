/**
 * DW WhatsApp Bot (Z-API + Render) — STABLE SEND
 * Baseado no teu JS “bom”, corrigindo o envio Z-API:
 * - URL SEMPRE com INSTANCE_ID + INSTANCE_TOKEN
 * - Header SEMPRE "client-token" (lowercase)
 */

import express from "express";

const app = express();
app.use(express.json({ limit: "25mb" }));

/* -------------------- ENV -------------------- */
function env(name, { optional = false, fallback = "" } = {}) {
  const v = process.env[name];
  if (!v && !optional) throw new Error(`Missing env var: ${name}`);
  return v || fallback;
}

const ZAPI_INSTANCE_ID = env("ZAPI_INSTANCE_ID");
const ZAPI_INSTANCE_TOKEN = env("ZAPI_INSTANCE_TOKEN");
const ZAPI_CLIENT_TOKEN = env("ZAPI_CLIENT_TOKEN");

const OPENAI_API_KEY = env("OPENAI_API_KEY");
const OWNER_PHONE = normalizePhone(env("OWNER_PHONE"));
const PIX_KEY = env("PIX_KEY");

const MODEL = env("MODEL", { optional: true, fallback: "gpt-4.1-mini" });
const SESSION_SPLIT_FEE = Number(env("SESSION_SPLIT_FEE", { optional: true, fallback: "200" })) || 200;

const PORT = Number(process.env.PORT || 10000);

/* -------------------- In-memory state -------------------- */
const state = new Map();

function getSession(phone) {
  if (!state.has(phone)) {
    state.set(phone, {
      stage: "start",
      region: null,
      fidelity: null,
      sizeCm: null,
      lastBotHash: null,
      lastUserHash: null,
      lastSeenAt: Date.now(),
      lastImageAnalysis: null,
      depositDetected: false,
      askedOnce: { details: false },
    });
  }
  const s = state.get(phone);
  s.lastSeenAt = Date.now();
  return s;
}

function normalizePhone(p) {
  const digits = String(p || "").replace(/\D/g, "");
  if (digits.length === 10 || digits.length === 11) return `55${digits}`;
  return digits;
}

function hashStr(str = "") {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return String(h);
}

/* -------------------- Z-API send helpers (CORRETO) -------------------- */
const ZAPI_BASE = `https://api.z-api.io/instances/${ZAPI_INSTANCE_ID}/token/${ZAPI_INSTANCE_TOKEN}`;

async function zapiSendText(phone, message) {
  const url = `${ZAPI_BASE}/send-text`;

  // LOG do que realmente importa (sem vazar tokens)
  console.log("[ZAPI OUT] url:", url);
  console.log("[ZAPI OUT] phone:", phone);
  console.log("[ZAPI OUT] client-token set:", !!ZAPI_CLIENT_TOKEN);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // IMPORTANTÍSSIMO: lowercase. Esse é o que funciona no teu JS antigo.
      "client-token": ZAPI_CLIENT_TOKEN,
    },
    body: JSON.stringify({ phone, message }),
  });

  const bodyText = await res.text().catch(() => "");
  if (!res.ok) {
    console.log("[ZAPI SEND] status:", res.status, "body:", bodyText);
    throw new Error(`ZAPI_SEND_FAILED_${res.status}`);
  }
  return bodyText;
}

async function zapiSendTextSafe(phone, message) {
  try {
    return await zapiSendText(phone, message);
  } catch (e) {
    console.log("[ZAPI ERROR]", e?.message || e);
    return null;
  }
}

/* -------------------- OpenAI helpers (mantidos) -------------------- */
async function openaiResponses(input) {
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      input,
      temperature: 0.6,
    }),
  });

  const data = await res.json().catch(() => null);
  if (!res.ok) {
    console.log("[OPENAI ERROR]", res.status, data);
    throw new Error("OPENAI_FAILED");
  }
  return data;
}

function pickText(data) {
  try {
    const out = data.output?.[0];
    const content = out?.content || [];
    const txt = content.find((c) => c.type === "output_text")?.text;
    return txt || "";
  } catch {
    return "";
  }
}

async function analyzeImageForTattoo({ imageDataUrl, userText = "" }) {
  const sys = `
Você é um tatuador profissional especialista em black & grey realismo e também um avaliador técnico.
Analise a imagem e/ou texto do cliente e devolva APENAS JSON válido, sem texto extra.

Regras:
- Se a imagem aparentar ser comprovante Pix/transferência, classifique kind="receipt".
- Se for referência de tatuagem/arte, kind="reference".
- complexity: 1 (simples) a 5 (muito complexo).
- estimatedHours: número realista (ex: 2.5, 4, 7). Não exagere.
- description: descreva tecnicamente (sombras, transições, textura, contraste, elementos, leitura), sem falar preço/horas para o cliente (isso é interno).
  `.trim();

  const input = [
    { role: "system", content: sys },
    {
      role: "user",
      content: [
        { type: "input_text", text: userText ? `Contexto do cliente: ${userText}` : "Sem texto, apenas imagem." },
        { type: "input_image", image_url: imageDataUrl },
      ],
    },
  ];

  const data = await openaiResponses(input);
  const txt = pickText(data).trim();

  try {
    return JSON.parse(txt);
  } catch {
    return { kind: "unknown", description: "", complexity: 3, estimatedHours: 4 };
  }
}

/* -------------------- Parsing -------------------- */
const REGION_SPECIAL = ["mao", "mão", "pe", "pé", "pesco", "pescoço", "pescoco", "costela", "ribs"];

function parseRegion(text = "") {
  const t = text.toLowerCase();
  const candidates = [
    "mão","mao","pé","pe","pescoço","pescoco","costela",
    "antebraço","antebraco","braço","braco","perna","costas","coxa","ombro","tórax","torax","panturrilha","nuca","peito","abdomen","abdômen",
  ];
  for (const c of candidates) if (t.includes(c)) return c;
  return null;
}

function parseFidelity(text = "") {
  const t = text.toLowerCase();
  if (t.includes("fiel") || t.includes("igual") || t.includes("mesma") || t.includes("idêntic") || t.includes("identic")) return "fiel";
  if (t.includes("adapt") || t.includes("mudar") || t.includes("alter") || t.includes("adicion") || t.includes("remov")) return "adaptar";
  return null;
}

function parseSizeCm(text = "") {
  const t = text.toLowerCase().replace(",", ".");
  const m1 = t.match(/(\d+(\.\d+)?)\s*cm/);
  if (m1) return Number(m1[1]);
  const m2 = t.match(/(\d+(\.\d+)?)\s*x\s*(\d+(\.\d+)?)/);
  if (m2) return Math.max(Number(m2[1]), Number(m2[3]));
  return null;
}

function isAskingBudget(text = "") {
  const t = text.toLowerCase();
  return t.includes("valor") || t.includes("preço") || t.includes("preco") || t.includes("orçamento") || t.includes("orcamento") || t.includes("quanto");
}

function isClientSaysDepositSent(text = "") {
  const t = text.toLowerCase();
  return t.includes("comprovante") || t.includes("paguei") || t.includes("pix feito") || t.includes("enviei o pix") || t.includes("transferi");
}

/* -------------------- Cálculo interno -------------------- */
function regionIsSpecial(region = "") {
  const r = (region || "").toLowerCase();
  return REGION_SPECIAL.some((k) => r.includes(k));
}

function baseHoursByRegion(region = "") {
  const r = (region || "").toLowerCase();
  if (r.includes("mão") || r.includes("mao") || r.includes("pé") || r.includes("pe")) return 3.0;
  if (r.includes("pesco")) return 3.5;
  if (r.includes("costela")) return 4.5;
  if (r.includes("antebra")) return 4.0;
  if (r.includes("braço") || r.includes("braco")) return 4.5;
  if (r.includes("perna") || r.includes("coxa") || r.includes("panturr")) return 5.0;
  if (r.includes("costas")) return 6.0;
  return 4.0;
}

function adjustHoursBySize(base, sizeCm) {
  if (!sizeCm) return base;
  if (sizeCm <= 8) return Math.max(2.5, base - 0.8);
  if (sizeCm <= 12) return base;
  if (sizeCm <= 18) return base + 1.0;
  if (sizeCm <= 25) return base + 2.0;
  return base + 3.0;
}

function adjustHoursByComplexity(hours, complexity = 3) {
  const c = Math.min(5, Math.max(1, Number(complexity) || 3));
  const mult = 0.85 + c * 0.1;
  return Math.round(hours * mult * 2) / 2;
}

function computeQuote({ region, sizeCm, complexity, aiHours }) {
  const special = regionIsSpecial(region);

  let hours = aiHours && Number(aiHours) > 0 ? Number(aiHours) : baseHoursByRegion(region);
  hours = adjustHoursBySize(hours, sizeCm);
  hours = adjustHoursByComplexity(hours, complexity);

  const sessions = Math.max(1, Math.ceil(hours / 7));
  const rateFirst = 150;
  const rateOther = special ? 120 : 100;

  let remaining = hours;
  let total = 0;

  for (let i = 0; i < sessions; i++) {
    const sessionHours = Math.min(7, remaining);
    remaining -= sessionHours;
    total += sessionHours <= 1 ? rateFirst : rateFirst + (sessionHours - 1) * rateOther;
  }

  total = Math.round(total / 10) * 10;
  return { hours, sessions, total, rateOther, special };
}

/* -------------------- Copy (sem “estrelinhas”) -------------------- */
function msgAskDetails() {
  return [
    "Perfeito, recebi sua referência.",
    "",
    "Só me confirma duas coisas pra eu te passar um orçamento justo:",
    "",
    "1) Em qual região do corpo você pensa em fazer? (ex: antebraço, braço, perna, costas, costela, pescoço, mão)",
    "2) Você quer fiel à referência ou prefere alguma adaptação? (adicionar/remover elementos, ajustar composição, etc.)",
  ].join("\n");
}

function msgAnalysisToClient(description, region, fidelity) {
  const fidelityLine =
    fidelity === "adaptar"
      ? "Como você quer uma adaptação, eu penso o desenho com encaixe e composição pra ficar mais harmônico nessa região."
      : "Como você quer fiel à referência, eu mantenho a leitura do desenho e ajusto só o necessário pra encaixar bem na pele.";

  const descLine = description
    ? `Pelo que você enviou, o trabalho pede atenção a: ${description}`
    : "Pelo estilo e nível de detalhe, ele exige sombras bem limpas, transições e contraste pra dar profundidade sem estourar.";

  return ["Fechado.", "", descLine, "", `Na região de ${region || "corpo"} isso fica bem forte com encaixe e leitura.`, fidelityLine].join("\n");
}

function msgPaymentsAndRules() {
  return [
    "Formas de pagamento:",
    "- Pix",
    "- Débito",
    "- Crédito em até 12x (com taxa da maquininha conforme parcelas)",
    "",
    "Inclui 1 sessão de retoque (se necessário) entre 40 e 50 dias após cicatrização.",
    "",
    "Pra garantir seu horário, eu peço um sinal de R$ 50.",
    `Chave Pix: ${PIX_KEY}`,
    "",
    "Remarcação: só peço 48h de aviso.",
    "",
    "Assim que enviar o comprovante, eu te passo as opções de datas.",
  ].join("\n");
}

function msgQuote(total, sessions) {
  const sessionLine =
    sessions <= 1
      ? "Pelo tamanho e complexidade, dá pra fazer em uma sessão com acabamento bem limpo."
      : "Pelo tamanho e complexidade, é melhor dividir em duas sessões pra manter qualidade.";
  return [sessionLine, "", `O investimento fica em R$ ${total}.`].join("\n");
}

function msgSchedulingAsk() {
  return [
    "Perfeito. Pra eu te passar as opções de agenda:",
    "",
    "Você prefere horário comercial ou pós-horário comercial?",
    "E tem algum dia em mente?",
  ].join("\n");
}

async function sendOnce(phone, session, message) {
  const h = hashStr(message);
  if (session.lastBotHash === h) return;
  session.lastBotHash = h;
  await zapiSendTextSafe(phone, message);
}

/* -------------------- Imagem (mantido do teu) -------------------- */
function extractImageUrlOrBase64(payload) {
  const p = payload || {};
  const img =
    p.image ||
    p.imageUrl ||
    p.imageURL ||
    p.image_url ||
    p.url ||
    p.mediaUrl ||
    p.mediaURL ||
    p.file ||
    p.path ||
    null;

  const base64 = p.imageBase64 || p.base64 || p.mediaBase64 || null;
  return { img, base64 };
}

async function downloadToDataUrl(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error("FAILED_DOWNLOAD_IMAGE");
  const contentType = res.headers.get("content-type") || "image/jpeg";
  const buf = Buffer.from(await res.arrayBuffer());
  const b64 = buf.toString("base64");
  return `data:${contentType};base64,${b64}`;
}

/* -------------------- Fluxo principal -------------------- */
async function handleIncoming({ phone, text, isImage, payload }) {
  const session = getSession(phone);

  // Dedupe de input
  const userKey = hashStr(`${text || ""}|${isImage ? "img" : "txt"}|${payload?.messageId || ""}|${payload?.zaapId || ""}`);
  if (session.lastUserHash === userKey) return;
  session.lastUserHash = userKey;

  // Se for imagem, tenta analisar
  let ai = null;
  if (isImage) {
    try {
      const { img, base64 } = extractImageUrlOrBase64(payload);
      let dataUrl = null;

      if (base64 && String(base64).length > 200) dataUrl = base64.startsWith("data:") ? base64 : `data:image/jpeg;base64,${base64}`;
      else if (img && /^https?:\/\//i.test(String(img))) dataUrl = await downloadToDataUrl(String(img));

      if (dataUrl) {
        ai = await analyzeImageForTattoo({ imageDataUrl: dataUrl, userText: text || "" });
        session.lastImageAnalysis = ai;
      } else {
        ai = { kind: "unknown", description: "", complexity: 3, estimatedHours: baseHoursByRegion(session.region) };
        session.lastImageAnalysis = ai;
      }
    } catch (e) {
      console.log("[IMG ANALYZE ERROR]", e?.message || e);
      ai = { kind: "unknown", description: "", complexity: 3, estimatedHours: baseHoursByRegion(session.region) };
      session.lastImageAnalysis = ai;
    }
  }

  // Detecta comprovante
  const receiptDetected = (ai && ai.kind === "receipt") || isClientSaysDepositSent(text);
  if (receiptDetected) {
    session.depositDetected = true;
    session.stage = "scheduling";

    await zapiSendTextSafe(
      OWNER_PHONE,
      ["⚠️ SINAL/COMPROVANTE RECEBIDO (bot)", `Cliente: ${phone}`, "A conversa entrou na etapa de agenda."].join("\n")
    );

    await sendOnce(phone, session, msgSchedulingAsk());
    return;
  }

  // Se é referência (imagem)
  if (isImage && ai && ai.kind !== "receipt") {
    if (!session.region || !session.fidelity) {
      session.stage = "need_details";
      await sendOnce(phone, session, msgAskDetails());
      return;
    }

    const desc = (ai?.description || "").trim();
    const analysisMsg = msgAnalysisToClient(desc, session.region, session.fidelity);

    const quote = computeQuote({
      region: session.region,
      sizeCm: session.sizeCm,
      complexity: ai?.complexity || 3,
      aiHours: ai?.estimatedHours,
    });

    session.stage = "awaiting_deposit";
    await sendOnce(phone, session, analysisMsg);
    await sendOnce(phone, session, msgQuote(quote.total, quote.sessions));
    await sendOnce(phone, session, msgPaymentsAndRules());
    return;
  }

  // Texto normal
  const t = (text || "").trim();
  const r = parseRegion(t);
  const f = parseFidelity(t);
  const s = parseSizeCm(t);

  if (r && !session.region) session.region = r;
  if (f && !session.fidelity) session.fidelity = f;
  if (s && !session.sizeCm) session.sizeCm = s;

  if (!session.region || !session.fidelity) {
    session.stage = "need_details";
    await sendOnce(phone, session, msgAskDetails());
    return;
  }

  if (isAskingBudget(t) && !session.lastImageAnalysis) {
    await sendOnce(
      phone,
      session,
      [
        "Fechado. Pra eu te passar um orçamento realmente justo, me manda a referência em imagem aqui (pode ser print/foto).",
        "",
        "Com isso eu consigo avaliar sombras, transições e nível de detalhe pra te explicar o valor do jeito certo.",
      ].join("\n")
    );
    return;
  }

  const aiFallback = session.lastImageAnalysis || { description: "", complexity: 3, estimatedHours: baseHoursByRegion(session.region) };
  const quote = computeQuote({
    region: session.region,
    sizeCm: session.sizeCm,
    complexity: aiFallback?.complexity || 3,
    aiHours: aiFallback?.estimatedHours,
  });

  const analysisMsg = msgAnalysisToClient((aiFallback?.description || "").trim(), session.region, session.fidelity);

  session.stage = "awaiting_deposit";
  await sendOnce(phone, session, analysisMsg);
  await sendOnce(phone, session, msgQuote(quote.total, quote.sessions));
  await sendOnce(phone, session, msgPaymentsAndRules());
}

/* -------------------- Webhook endpoint -------------------- */
function normalizeIncoming(payload) {
  const phone = payload.phone || payload.from || payload.sender?.phone || payload.senderPhone || payload?.data?.phone || payload?.data?.from || "";
  const text = payload.text?.message || payload.message?.text || payload.message || payload.body || payload.text || "";
  const isImage = Boolean(payload.isImage || payload.image || payload.imageUrl || payload.imageURL || payload.image_url || payload.imageBase64 || payload.mediaUrl);
  const fromMe = Boolean(payload.fromMe ?? payload?.data?.fromMe ?? payload?.data?.key?.fromMe ?? false);
  const messageId = payload.messageId || payload.id || payload?.data?.messageId || payload?.data?.id || payload?.data?.key?.id || "";

  return {
    phone: normalizePhone(phone),
    text: typeof text === "string" ? text : "",
    isImage,
    fromMe,
    messageId: String(messageId || ""),
  };
}

app.post("/zapi", async (req, res) => {
  try {
    const payload = req.body || {};
    const incoming = normalizeIncoming(payload);

    console.log("[ZAPI IN] phone:", incoming.phone);
    console.log("[ZAPI IN] text:", incoming.text ? incoming.text.slice(0, 200) : "");
    console.log("[ZAPI IN] isImage:", incoming.isImage);
    console.log("[ZAPI IN] fromMe:", incoming.fromMe);
    if (incoming.messageId) console.log("[ZAPI IN] messageId:", incoming.messageId);

    if (!incoming.phone) return res.status(200).json({ ok: true, ignored: true });

    // ignora mensagens do próprio dono (pra evitar loop)
    if (incoming.phone === OWNER_PHONE) return res.status(200).json({ ok: true, ignored: "owner" });

    // ignora eventos enviados pelo próprio bot/instância
    if (incoming.fromMe) return res.status(200).json({ ok: true, ignored: "fromMe" });

    await handleIncoming({
      phone: incoming.phone,
      text: incoming.text,
      isImage: incoming.isImage,
      payload,
    });

    res.status(200).json({ ok: true });
  } catch (e) {
    console.log("[WEBHOOK ERROR]", e?.message || e);
    res.status(200).json({ ok: true, error: true });
  }
});

app.get("/", (req, res) => res.status(200).send("DW bot online"));

app.get("/health", (req, res) => {
  res.status(200).json({
    ok: true,
    instanceId: !!ZAPI_INSTANCE_ID,
    instanceToken: !!ZAPI_INSTANCE_TOKEN,
    clientToken: !!ZAPI_CLIENT_TOKEN,
    time: new Date().toISOString(),
  });
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
