/**
 * DW WhatsApp Bot (Z-API + Render) — FIXED/ROBUST
 *
 * Objetivo: manter esse teu fluxo (o “JS legal”) mas com as correções do último:
 * - Envio Z-API robusto (headers certos + variações + fallback)
 * - Dedupe melhor (messageId + hash)
 * - Ignora mensagens “fromMe” (evita loop)
 * - Mensagens sem markdown (sem **, sem •) pra não ficar “seco/estranho”
 * - Leitura de imagem: tenta base64/URL; se não vier público, ainda funciona por heurística
 *
 * ENV (Render -> Environment):
 * - ZAPI_INSTANCE_ID
 * - ZAPI_INSTANCE_TOKEN
 * - ZAPI_CLIENT_TOKEN
 * - OPENAI_API_KEY
 * - OWNER_PHONE              (ex: 5544999999999)
 * - PIX_KEY                  (ex: dwtattooshop@gmail.com)
 * - MODEL                    (opcional, default: gpt-4.1-mini)
 * - SESSION_SPLIT_FEE        (opcional, default: 200)
 * - PORT                     (Render define automaticamente)
 *
 * Webhook "Ao receber" no Z-API:
 * - https://SEU-SERVICE.onrender.com/zapi
 */

import express from "express";
import crypto from "crypto";

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

/* -------------------- In-memory state (simples) -------------------- */
const state = new Map();
const seenMessageIds = new Map(); // messageId -> ts

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
  // se vier 10/11 dígitos (sem DDI), assume Brasil
  if (digits.length === 10 || digits.length === 11) return `55${digits}`;
  return digits;
}

function sha1(s) {
  return crypto.createHash("sha1").update(String(s || "")).digest("hex");
}

/* -------------------- Z-API send helpers (robusto) -------------------- */
function zapiHeaders() {
  // Z-API costuma exigir client-token. Alguns painéis aceitam só em lowercase.
  return {
    "Content-Type": "application/json",
    "client-token": ZAPI_CLIENT_TOKEN,
    "Client-Token": ZAPI_CLIENT_TOKEN,
    "CLIENT-TOKEN": ZAPI_CLIENT_TOKEN,
  };
}

function zapiUrlsFor(path) {
  // mantém teu padrão (INSTANCE_ID + INSTANCE_TOKEN na URL)
  const baseA = `https://api.z-api.io/instances/${ZAPI_INSTANCE_ID}/token/${ZAPI_INSTANCE_TOKEN}`;
  // fallback comum (alguns painéis confundem e “token” na URL precisa ser o client token)
  const baseB = `https://api.z-api.io/instances/${ZAPI_INSTANCE_ID}/token/${ZAPI_CLIENT_TOKEN}`;
  return [`${baseA}${path}`, `${baseB}${path}`];
}

async function zapiPost(path, payload) {
  const headers = zapiHeaders();
  const [urlA, urlB] = zapiUrlsFor(path);

  // tenta A, se falhar tenta B
  let lastErr = null;

  for (const url of [urlA, urlB]) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });

      const bodyText = await res.text().catch(() => "");
      if (!res.ok) {
        console.log("[ZAPI SEND] fail url:", url, "status:", res.status, "body:", bodyText);
        lastErr = new Error(`ZAPI_SEND_FAILED_${res.status}`);
        continue;
      }

      // às vezes vem JSON com erro mesmo em 200
      if (bodyText && bodyText.includes('"error"')) {
        console.log("[ZAPI SEND] error body url:", url, bodyText);
        lastErr = new Error("ZAPI_SEND_ERROR_BODY");
        continue;
      }

      return bodyText;
    } catch (e) {
      console.log("[ZAPI SEND] network error url:", url, e?.message || e);
      lastErr = e;
    }
  }

  throw lastErr || new Error("ZAPI_SEND_FAILED");
}

async function zapiSendTextSafe(phone, message) {
  try {
    const payload = { phone, message };
    return await zapiPost("/send-text", payload);
  } catch (e) {
    console.log("[ZAPI ERROR]", e?.message || e);
    return null;
  }
}

/* -------------------- OpenAI helpers (texto + visão) -------------------- */
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
        {
          type: "input_text",
          text: userText ? `Contexto do cliente: ${userText}` : "Sem texto, apenas imagem.",
        },
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

/* -------------------- Parsing de mensagens -------------------- */
const REGION_SPECIAL = ["mao", "mão", "pe", "pé", "pesco", "pescoço", "pescoco", "costela", "ribs"];

function parseRegion(text = "") {
  const t = text.toLowerCase();
  const candidates = [
    "mão",
    "mao",
    "pé",
    "pe",
    "pescoço",
    "pescoco",
    "costela",
    "antebraço",
    "antebraco",
    "braço",
    "braco",
    "perna",
    "costas",
    "coxa",
    "ombro",
    "tórax",
    "torax",
    "panturrilha",
    "nuca",
    "peito",
    "abdomen",
    "abdômen",
  ];
  for (const c of candidates) if (t.includes(c)) return c;
  return null;
}

function parseFidelity(text = "") {
  const t = text.toLowerCase();
  if (t.includes("fiel") || t.includes("igual") || t.includes("mesma") || t.includes("idêntic") || t.includes("identic"))
    return "fiel";
  if (t.includes("adapt") || t.includes("mudar") || t.includes("alter") || t.includes("adicion") || t.includes("remov"))
    return "adaptar";
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

/* -------------------- Cálculo interno (não expor horas) -------------------- */
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
  const mult = 0.85 + c * 0.1; // c=1 => 0.95, c=5 => 1.35
  return Math.round(hours * mult * 2) / 2; // 0.5
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

    if (sessionHours <= 1) total += rateFirst;
    else total += rateFirst + (sessionHours - 1) * rateOther;
  }

  total = Math.round(total / 10) * 10;

  return { hours, sessions, total, rateOther, special };
}

/* -------------------- Copy (mensagens) — SEM markdown/estrelinhas -------------------- */
function msgAskDetails() {
  return [
    "Perfeito, recebi sua referência. Esse projeto tem bastante potencial — os detalhes, sombras e a composição pedem um trabalho bem estruturado pra manter leitura forte na pele e um resultado realmente marcante.",
    "",
    "Só me confirma duas coisas pra eu te passar um orçamento justo e do jeito que você quer:",
    "",
    "1) Em qual região do corpo você pensa em fazer? (ex: antebraço, braço, perna, costas, costela, pescoço, mão)",
    "2) Você quer fiel à referência ou prefere alguma adaptação? (adicionar/remover elementos, ajustar composição, etc.)",
  ].join("\n");
}

function msgAnalysisToClient(description, region, fidelity) {
  const fidelityLine =
    fidelity === "adaptar"
      ? "Como você quer uma adaptação, eu já penso o desenho com encaixe e composição pra ficar mais harmônico e forte nessa região."
      : "Como você quer fiel à referência, eu mantenho a leitura e a identidade do desenho, ajustando somente o que for necessário pra encaixar bem na pele e ficar bem executado.";

  const descLine = description
    ? `Pelo que você enviou, o trabalho pede atenção a: ${description}`
    : "Pelo estilo e nível de detalhe, ele exige construção bem limpa de sombras, transições e contraste pra dar profundidade sem estourar o desenho.";

  return [
    "Fechado. Agora consigo te orientar certinho.",
    "",
    descLine,
    "",
    `Na região de ${region || "corpo"} isso fica bem forte quando a gente acerta encaixe, contraste e leitura.`,
    fidelityLine,
  ].join("\n");
}

function msgPaymentsAndRules() {
  return [
    "Formas de pagamento:",
    "- Pix",
    "- Débito",
    "- Crédito em até 12x (com a taxa da maquininha conforme o número de parcelas)",
    "",
    "O orçamento já inclui 1 sessão de retoque (se necessário) entre 40 e 50 dias após a cicatrização.",
    "",
    "Se ficar pesado pagar tudo de uma vez, dá pra fazer em sessões mensais (com ajuste no total, porque vira um atendimento em etapas).",
    "",
    "Pra garantir seu horário, eu peço um sinal de R$ 50.",
    `Chave Pix: ${PIX_KEY}`,
    "",
    "Remarcação/alteração de data: tranquilo, só peço aviso prévio de 48h.",
    "",
    "Assim que você enviar o comprovante aqui, eu já te passo as opções de datas.",
  ].join("\n");
}

function msgQuote(total, sessions) {
  const sessionLine =
    sessions <= 1
      ? "Pelo tamanho e complexidade, dá pra fazer em uma única sessão com acabamento bem limpo."
      : "Pelo tamanho e complexidade, é mais indicado dividir em duas sessões pra manter qualidade e leitura forte.";

  return [sessionLine, "", `O investimento fica em R$ ${total}.`].join("\n");
}

function msgSchedulingAsk() {
  return [
    "Perfeito. Pra eu te passar as melhores opções de agenda:",
    "",
    "Você prefere horário comercial ou pós-horário comercial?",
    "E tem algum dia em mente que seria melhor pra você?",
    "",
    "Se você não tiver preferência, eu te passo a data mais próxima que eu tenho livre.",
  ].join("\n");
}

/* -------------------- Dedupe (evitar repetição) -------------------- */
async function sendOnce(phone, session, message) {
  const h = sha1(message);
  if (session.lastBotHash === h) return;
  session.lastBotHash = h;
  await zapiSendTextSafe(phone, message);
}

function seenMessageId(id) {
  if (!id) return false;
  if (seenMessageIds.has(id)) return true;
  seenMessageIds.set(id, Date.now());
  // limpeza leve (30 min)
  const now = Date.now();
  for (const [k, ts] of seenMessageIds.entries()) {
    if (now - ts > 1000 * 60 * 30) seenMessageIds.delete(k);
  }
  return false;
}

/* -------------------- Extrair imagem do webhook -------------------- */
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
    p?.data?.image?.url ||
    p?.data?.media?.url ||
    p?.message?.image?.url ||
    p?.message?.media?.url ||
    null;

  const base64 =
    p.imageBase64 ||
    p.base64 ||
    p.mediaBase64 ||
    p?.data?.imageBase64 ||
    p?.data?.base64 ||
    null;

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
async function handleIncoming({ phone, text, isImage, payload, messageId, fromMe }) {
  const session = getSession(phone);

  // ignora mensagens que são do próprio bot/da instância
  if (fromMe) return;

  // dedupe por messageId (se existir)
  if (messageId && seenMessageId(messageId)) return;

  // dedupe por hash do evento
  const userKey = sha1(`${text || ""}|${isImage ? "img" : "txt"}|${messageId || ""}`);
  if (session.lastUserHash === userKey) return;
  session.lastUserHash = userKey;

  // atualiza dados se o cliente respondeu
  const t = (text || "").trim();
  const r = parseRegion(t);
  const f = parseFidelity(t);
  const s = parseSizeCm(t);

  if (r && !session.region) session.region = r;
  if (f && !session.fidelity) session.fidelity = f;
  if (s && !session.sizeCm) session.sizeCm = s;

  // Se for imagem, tenta analisar (referência vs comprovante)
  let ai = null;

  if (isImage) {
    try {
      const { img, base64 } = extractImageUrlOrBase64(payload);
      let dataUrl = null;

      if (base64 && String(base64).length > 200) {
        dataUrl = String(base64).startsWith("data:")
          ? String(base64)
          : `data:image/jpeg;base64,${base64}`;
      } else if (img && /^https?:\/\//i.test(String(img))) {
        dataUrl = await downloadToDataUrl(String(img));
      } else {
        dataUrl = null;
      }

      if (dataUrl) {
        ai = await analyzeImageForTattoo({ imageDataUrl: dataUrl, userText: t || "" });
        session.lastImageAnalysis = ai;
      } else {
        // sem URL/base64 público: segue com heurística
        ai = { kind: "unknown", description: "", complexity: 3, estimatedHours: baseHoursByRegion(session.region) };
        session.lastImageAnalysis = ai;
      }
    } catch (e) {
      console.log("[IMG ANALYZE ERROR]", e?.message || e);
      ai = { kind: "unknown", description: "", complexity: 3, estimatedHours: baseHoursByRegion(session.region) };
      session.lastImageAnalysis = ai;
    }
  }

  // Detecta comprovante (por IA ou por palavras)
  const receiptDetected = (ai && ai.kind === "receipt") || isClientSaysDepositSent(t);

  if (receiptDetected) {
    session.depositDetected = true;
    session.stage = "scheduling";

    // Notifica você no seu Whats pessoal
    await zapiSendTextSafe(
      OWNER_PHONE,
      ["⚠️ SINAL/COMPROVANTE RECEBIDO (bot)", `Cliente: ${phone}`, "A conversa entrou na etapa de agenda."].join("\n")
    );

    await sendOnce(phone, session, msgSchedulingAsk());
    return;
  }

  // Se é referência (imagem) e ainda falta dado, pede tudo de uma vez
  if (isImage && ai && ai.kind !== "receipt") {
    if (!session.region || !session.fidelity) {
      session.stage = "need_details";
      await sendOnce(phone, session, msgAskDetails());
      return;
    }

    // já tem dados -> manda análise + orçamento + regras
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

  // Texto normal: se ainda faltam dados essenciais, pede UMA vez
  if (!session.region || !session.fidelity) {
    session.stage = "need_details";
    await sendOnce(phone, session, msgAskDetails());
    return;
  }

  // Se pediu orçamento e ainda não teve referência analisada, pede imagem (sem ficar repetindo)
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

  // Sem imagem ainda: faz proposta por heurística
  const aiFallback = session.lastImageAnalysis || {
    description: "",
    complexity: 3,
    estimatedHours: baseHoursByRegion(session.region),
  };

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

/* -------------------- Normalização do webhook -------------------- */
function normalizeIncoming(payload) {
  const p = payload || {};

  const phone =
    p.phone ||
    p.from ||
    p.sender?.phone ||
    p.senderPhone ||
    p?.data?.phone ||
    p?.data?.from ||
    p?.data?.sender?.phone ||
    "";

  const messageId =
    p.messageId ||
    p.id ||
    p?.data?.messageId ||
    p?.data?.id ||
    p?.data?.key?.id ||
    "";

  const fromMe = Boolean(
    p.fromMe ??
      p?.data?.fromMe ??
      p?.data?.key?.fromMe ??
      false
  );

  const text =
    p?.text?.message ||
    p?.message?.text ||
    p?.message ||
    p?.body ||
    p?.text ||
    p?.data?.text?.message ||
    p?.data?.message?.text ||
    p?.data?.message ||
    p?.data?.body ||
    p?.data?.text ||
    "";

  const isImage =
    Boolean(p?.isImage) ||
    Boolean(p?.image) ||
    Boolean(p?.imageUrl) ||
    Boolean(p?.imageURL) ||
    Boolean(p?.image_url) ||
    Boolean(p?.imageBase64) ||
    Boolean(p?.mediaUrl) ||
    Boolean(p?.data?.image) ||
    Boolean(p?.data?.media) ||
    Boolean(p?.data?.imageBase64) ||
    p?.type === "image" ||
    p?.data?.type === "image" ||
    false;

  return {
    phone: normalizePhone(phone),
    messageId: String(messageId || ""),
    fromMe,
    text: typeof text === "string" ? text : "",
    isImage: !!isImage,
  };
}

/* -------------------- Routes -------------------- */
app.get("/", (req, res) => res.status(200).send("DW bot online"));

app.get("/health", (req, res) => {
  res.status(200).json({
    ok: true,
    env: {
      ZAPI_INSTANCE_ID: !!ZAPI_INSTANCE_ID,
      ZAPI_INSTANCE_TOKEN: !!ZAPI_INSTANCE_TOKEN,
      ZAPI_CLIENT_TOKEN: !!ZAPI_CLIENT_TOKEN,
      OPENAI_API_KEY: !!OPENAI_API_KEY,
      OWNER_PHONE: !!OWNER_PHONE,
      PIX_KEY: !!PIX_KEY,
      MODEL,
    },
    time: new Date().toISOString(),
  });
});

/* -------------------- Webhook endpoint -------------------- */
app.post("/zapi", async (req, res) => {
  try {
    const payload = req.body || {};
    const incoming = normalizeIncoming(payload);

    console.log("[ZAPI IN] phone:", incoming.phone);
    console.log("[ZAPI IN] text:", incoming.text ? incoming.text.slice(0, 200) : "");
    console.log("[ZAPI IN] isImage:", incoming.isImage);
    if (incoming.messageId) console.log("[ZAPI IN] messageId:", incoming.messageId);
    console.log("[ZAPI IN] fromMe:", incoming.fromMe);

    if (!incoming.phone) {
      res.status(200).json({ ok: true, ignored: true });
      return;
    }

    await handleIncoming({
      phone: incoming.phone,
      text: incoming.text,
      isImage: incoming.isImage,
      payload,
      messageId: incoming.messageId,
      fromMe: incoming.fromMe,
    });

    res.status(200).json({ ok: true });
  } catch (e) {
    console.log("[WEBHOOK ERROR]", e?.message || e);
    res.status(200).json({ ok: true, error: true });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
