/**
 * app.js — DW WhatsApp Bot (Render + Z-API + OpenAI)
 *
 * O que este bot faz:
 * - Recebe mensagens (texto/Imagem) via webhook /zapi
 * - Mantém estado por conversa (pra NÃO repetir perguntas)
 * - Quando receber imagem + região + (fiel/alterar) (+ tamanho opcional):
 *   -> descreve a referência (pra justificar valor)
 *   -> calcula investimento (sem citar horas/valor por hora pro cliente)
 *   -> informa formas de pagamento + retoque + sinal (R$50) + política 48h
 *   -> pergunta datas (horário comercial / pós-horário / data em mente)
 * - Se detectar “cobertura”: pede foto e já avisa que dificilmente pega
 * - Se detectar comprovante: notifica seu Whats pessoal (OWNER_PHONE)
 *
 * =========================
 * ENV VARS (Render)
 * =========================
 * PORT=10000 (Render define)
 *
 * ZAPI_BASE_URL=https://api.z-api.io (ou o host correto do seu painel)
 * ZAPI_INSTANCE_ID=SEU_ID_DA_INSTANCIA
 * ZAPI_INSTANCE_TOKEN=SEU_TOKEN_DA_INSTANCIA
 * ZAPI_CLIENT_TOKEN=SEU_CLIENT_TOKEN (se a Z-API exigir)
 *
 * OPENAI_API_KEY=sk-...
 * OPENAI_MODEL=gpt-4.1-mini (opcional; padrão abaixo)
 *
 * OWNER_PHONE=5544999999999   (seu Whats pessoal, com DDI/DDDs, só números)
 *
 * PIX_KEY=dwtooshoop@gmail.com (chave pix que aparece pro cliente)
 * DEPOSIT_VALUE=50
 *
 * =========================
 * OBS
 * =========================
 * - Se a Z-API mandar imagem com URL não pública, o OpenAI pode falhar.
 *   O bot tenta analisar mesmo assim; se não conseguir, pede reenvio.
 */

import express from "express";
import crypto from "crypto";

const app = express();
app.use(express.json({ limit: "25mb" }));

/* =========================
   Helpers ENV
========================= */
function getEnv(name, { optional = false, fallback = undefined } = {}) {
  const v = process.env[name];
  if ((v === undefined || v === null || String(v).trim() === "") && !optional) {
    throw new Error(`Missing env var: ${name}`);
  }
  return (v === undefined || v === null || String(v).trim() === "")
    ? fallback
    : String(v).trim();
}

const PORT = Number(process.env.PORT || 10000);

const ZAPI_BASE_URL = getEnv("ZAPI_BASE_URL", { fallback: "https://api.z-api.io", optional: true });
const ZAPI_INSTANCE_ID = getEnv("ZAPI_INSTANCE_ID");
const ZAPI_INSTANCE_TOKEN = getEnv("ZAPI_INSTANCE_TOKEN");
const ZAPI_CLIENT_TOKEN = getEnv("ZAPI_CLIENT_TOKEN", { optional: true });

const OPENAI_API_KEY = getEnv("OPENAI_API_KEY", { optional: true });
const OPENAI_MODEL = getEnv("OPENAI_MODEL", { optional: true, fallback: "gpt-4.1-mini" });

const OWNER_PHONE = getEnv("OWNER_PHONE", { optional: true }); // se não tiver, só não notifica
const PIX_KEY = getEnv("PIX_KEY", { optional: true, fallback: "" });
const DEPOSIT_VALUE = Number(getEnv("DEPOSIT_VALUE", { optional: true, fallback: "50" })) || 50;

/* =========================
   In-memory state
   (Render free pode reiniciar -> estado zera; ainda funciona)
========================= */
const sessions = new Map(); // phone -> state
const processedMessageIds = new Set(); // dedupe simples

function nowIso() {
  return new Date().toISOString();
}

function normPhone(p) {
  return String(p || "").replace(/\D/g, "");
}

function getState(phone) {
  const key = normPhone(phone);
  if (!sessions.has(key)) {
    sessions.set(key, {
      phone: key,
      createdAt: nowIso(),
      lastUpdatedAt: nowIso(),
      // dados do projeto:
      hasImage: false,
      imageUrl: null,
      imageBase64: null,
      region: null,
      sizeCm: null,
      fidelity: null, // "fiel" | "alterar"
      changesNote: null,
      // controle de fluxo:
      stage: "INIT", // INIT -> ASKING -> READY_TO_QUOTE -> QUOTED -> ASK_DATES
      lastQuestionKey: null,
      lastBotTextHash: null,
      lastUserTextHash: null,
      lastIncomingMessageId: null,
      quotedValue: null,
    });
  }
  return sessions.get(key);
}

function sha1(s) {
  return crypto.createHash("sha1").update(String(s || ""), "utf8").digest("hex");
}

/* =========================
   Z-API send
========================= */
function zapiHeaders() {
  const h = { "Content-Type": "application/json" };
  if (ZAPI_CLIENT_TOKEN) h["client-token"] = ZAPI_CLIENT_TOKEN;
  return h;
}

function zapiUrl(path) {
  // Alguns painéis usam /instances/{id}/token/{token}/...
  // Ajuste caso seu endpoint seja diferente.
  const base = ZAPI_BASE_URL.replace(/\/+$/, "");
  return `${base}/instances/${encodeURIComponent(ZAPI_INSTANCE_ID)}/token/${encodeURIComponent(ZAPI_INSTANCE_TOKEN)}${path}`;
}

async function sendText(phone, message) {
  const to = normPhone(phone);
  const url = zapiUrl(`/send-text`);
  const body = { phone: to, message };

  // Alguns ambientes exigem clientToken via query também:
  const finalUrl = ZAPI_CLIENT_TOKEN ? `${url}?clientToken=${encodeURIComponent(ZAPI_CLIENT_TOKEN)}` : url;

  const res = await fetch(finalUrl, {
    method: "POST",
    headers: zapiHeaders(),
    body: JSON.stringify(body),
  });

  const txt = await res.text().catch(() => "");
  if (!res.ok) {
    console.error("[ZAPI SEND FAIL]", res.status, txt);
    throw new Error(`ZAPI send failed: ${res.status}`);
  }
  return txt;
}

/* =========================
   Detect intent
========================= */
function looksLikePayment(text) {
  const t = (text || "").toLowerCase();
  return (
    t.includes("comprovante") ||
    t.includes("paguei") ||
    t.includes("pix") ||
    t.includes("pago") ||
    t.includes("transfer") ||
    t.includes("enviado o valor") ||
    t.includes("sinal")
  );
}

function looksLikeCoverup(text) {
  const t = (text || "").toLowerCase();
  return t.includes("cobertura") || t.includes("cobrir") || t.includes("cover up") || t.includes("coverup");
}

function parseRegion(text) {
  const t = (text || "").toLowerCase();

  const map = [
    { k: ["mão", "mao"], v: "mão" },
    { k: ["dedo", "dedos"], v: "mão" },
    { k: ["pé", "pe", "pés", "pes"], v: "pé" },
    { k: ["costela", "costelas"], v: "costela" },
    { k: ["pescoço", "pescoco", "nuca"], v: "pescoço" },
    { k: ["antebraço", "antebraco"], v: "antebraço" },
    { k: ["braço", "braco", "bíceps", "biceps", "tríceps", "triceps"], v: "braço" },
    { k: ["perna", "coxa", "panturrilha"], v: "perna" },
    { k: ["costas", "dorso"], v: "costas" },
    { k: ["peito", "tórax", "torax"], v: "peito" },
    { k: ["ombro"], v: "ombro" },
    { k: ["clavícula", "clavicula"], v: "clavícula" },
  ];

  for (const it of map) {
    if (it.k.some((kk) => t.includes(kk))) return it.v;
  }
  return null;
}

function parseFidelity(text) {
  const t = (text || "").toLowerCase();
  if (t.includes("fiel") || t.includes("igual") || t.includes("idêntic") || t.includes("identic")) return "fiel";
  if (t.includes("adapt") || t.includes("mudar") || t.includes("alter") || t.includes("tirar") || t.includes("colocar"))
    return "alterar";
  return null;
}

function parseSizeCm(text) {
  // pega padrões tipo "10cm", "10 cm", "15x8", "15 x 8"
  const t = (text || "").toLowerCase();
  const m1 = t.match(/(\d{1,2})\s*cm\b/);
  if (m1) return Number(m1[1]);

  const m2 = t.match(/(\d{1,2})\s*x\s*(\d{1,2})/);
  if (m2) {
    const a = Number(m2[1]);
    const b = Number(m2[2]);
    if (Number.isFinite(a) && Number.isFinite(b)) return Math.max(a, b); // pega maior como “tamanho”
  }
  return null;
}

/* =========================
   Pricing rules (interno)
========================= */
function isPremiumRegion(region) {
  // mão, pé, pescoço, costela = 150 primeira hora + 120 demais
  return ["mão", "pé", "pescoço", "costela"].includes(region || "");
}

function baseRates(region) {
  if (isPremiumRegion(region)) return { first: 150, other: 120 };
  return { first: 150, other: 100 };
}

function estimateHoursFallback({ region, sizeCm }) {
  // Heurística simples (sem mostrar pro cliente)
  // Ajuste fino: mão costuma 3h no seu padrão; antebraço retrato 6-7h; costas/perna maior.
  const r = region || "indefinido";

  const byRegion = {
    "mão": 3.0,
    "pé": 3.0,
    "pescoço": 3.5,
    "costela": 4.5,
    "antebraço": 6.0,
    "braço": 6.0,
    "perna": 6.5,
    "costas": 7.5,
    "peito": 7.0,
    "ombro": 5.0,
    "clavícula": 4.0,
    "indefinido": 6.0,
  };

  let h = byRegion[r] ?? 6.0;

  if (sizeCm && Number.isFinite(sizeCm)) {
    if (sizeCm <= 8) h -= 1.0;
    else if (sizeCm >= 18) h += 1.5;
    else if (sizeCm >= 25) h += 2.5;
  }

  // clamp
  h = Math.max(2.5, Math.min(12.0, h));
  // arredonda em 0.5h
  return Math.round(h * 2) / 2;
}

function splitIntoSessions(hours) {
  // cada sessão no máx 7h (regra interna)
  const sessions = [];
  let remaining = hours;
  while (remaining > 0) {
    const chunk = Math.min(7, remaining);
    sessions.push(chunk);
    remaining = Math.round((remaining - chunk) * 2) / 2;
    if (sessions.length > 5) break; // segurança
  }
  return sessions;
}

function computeInvestment({ region, estimatedHours }) {
  const rates = baseRates(region);
  const perSessionHours = splitIntoSessions(estimatedHours);

  let total = 0;
  for (const h of perSessionHours) {
    const hrs = Math.max(1, h);
    const cost = rates.first + Math.max(0, hrs - 1) * rates.other;
    total += cost;
  }

  // arredonda pra número inteiro
  total = Math.round(total);

  return { total, perSessionHours, rates };
}

/* =========================
   OpenAI (texto + visão)
========================= */
async function openaiDescribeAndEstimate({ imageUrl, imageBase64, region, fidelity, sizeCm }) {
  if (!OPENAI_API_KEY) {
    return {
      ok: false,
      description: null,
      suggestedHours: null,
      reason: "OPENAI_API_KEY not set",
    };
  }

  const userContext = `
Você é um tatuador profissional brasileiro. Sua resposta precisa ser humana, profissional e vendedora, sem parecer IA.
Você vai:
1) Descrever a referência enviada (elementos principais, sombras, transições, contraste, profundidade, pontos de atenção).
2) Estimar internamente um tempo (em horas) para execução (NÃO mencionar horas no texto final pro cliente).
3) Se a imagem estiver difícil/sem acesso, diga que não conseguiu abrir e peça pra reenviar.

Dados do pedido:
- Região: ${region || "não informado"}
- Tamanho aprox (cm): ${sizeCm || "não informado"}
- Preferência: ${fidelity === "fiel" ? "bem fiel à referência" : fidelity === "alterar" ? "com alterações" : "não informado"}
`;

  const input = [];
  input.push({
    role: "system",
    content: [
      {
        type: "text",
        text: `Você é um assistente de atendimento de tatuador. Seja objetivo e humano. Nunca fale "sou IA". Nunca use assinatura.`,
      },
    ],
  });

  const content = [{ type: "text", text: userContext }];

  if (imageUrl) {
    content.push({ type: "image_url", image_url: { url: imageUrl } });
  } else if (imageBase64) {
    // tenta data URL
    const dataUrl = imageBase64.startsWith("data:") ? imageBase64 : `data:image/jpeg;base64,${imageBase64}`;
    content.push({ type: "image_url", image_url: { url: dataUrl } });
  }

  input.push({ role: "user", content });

  const payload = {
    model: OPENAI_MODEL,
    input,
    // Pedimos JSON pra extrair fácil:
    text: {
      format: {
        type: "json_schema",
        json_schema: {
          name: "tattoo_eval",
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              canSee: { type: "boolean" },
              description: { type: "string" },
              suggestedHours: { type: "number" },
              notes: { type: "string" },
            },
            required: ["canSee", "description", "suggestedHours", "notes"],
          },
        },
      },
    },
  };

  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify(payload),
  });

  const raw = await res.text();
  if (!res.ok) {
    console.error("[OPENAI ERROR]", res.status, raw);
    return { ok: false, description: null, suggestedHours: null, reason: `OpenAI ${res.status}` };
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, description: null, suggestedHours: null, reason: "Invalid OpenAI JSON" };
  }

  // responses api: output_text costuma vir em output[0]...
  let outText = "";
  try {
    const o = data.output?.[0];
    const c = o?.content?.find((x) => x.type === "output_text");
    outText = c?.text || "";
  } catch {
    outText = "";
  }

  try {
    const parsed = JSON.parse(outText);
    return {
      ok: true,
      description: parsed.description,
      suggestedHours: Number(parsed.suggestedHours) || null,
      canSee: !!parsed.canSee,
      notes: parsed.notes || "",
    };
  } catch {
    return { ok: false, description: null, suggestedHours: null, reason: "Failed to parse model JSON" };
  }
}

/* =========================
   Message building
========================= */
function msgIntroAsk() {
  return (
    `Opa! Tudo certo?\n` +
    `Obrigado por me chamar e confiar no meu trampo.\n\n` +
    `Pra eu te passar um orçamento bem certinho, me manda:\n` +
    `1) a referência em *imagem*\n` +
    `2) a região do corpo (ex: mão, antebraço, costela, perna, costas)\n` +
    `3) se você quer *bem fiel* à referência ou se quer *alterar algo* (adicionar/remover/ajustar detalhes)\n` +
    `4) se souber, o tamanho aproximado em cm (se não souber, sem problema).`
  );
}

function msgAskMissing(state) {
  const needs = [];
  if (!state.hasImage) needs.push("a *referência em imagem*");
  if (!state.region) needs.push("a *região do corpo*");
  if (!state.fidelity) needs.push("se você quer *fiel* ou *com alterações*");
  // tamanho é opcional
  if (needs.length === 0) return null;

  return (
    `Show. Só pra eu fechar certinho aqui: me confirma ${needs.join(" + ")}.\n` +
    `Se não souber o tamanho em cm, tranquilo — eu estimo pela região.`
  );
}

function formatCurrencyBRL(n) {
  const v = Number(n) || 0;
  return v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function msgQuote({ description, total, perSessionHours, region, fidelity, hasOpenAiVision }) {
  const multiSession = perSessionHours.length > 1;

  const p1 =
    description?.trim()
      ? description.trim()
      : `Pelo que você me mandou, dá pra ver que é um trampo com construção de sombra e transições bem importantes pra manter profundidade e contraste, além de acabamento fino nos detalhes pra ficar forte e bem “limpo” na pele.`;

  const p2 = `Pra eu executar isso com esse nível de fidelidade e acabamento, o investimento fica em *${formatCurrencyBRL(total)}*.`;

  const payment =
    `Formas de pagamento:\n` +
    `• Pix\n` +
    `• Débito\n` +
    `• Crédito em até 12x *(com a taxa da maquininha conforme o número de parcelas)*`;

  const retouch = `O orçamento já inclui *1 sessão de retoque* (se necessário) entre *40 e 50 dias* após a cicatrização.`;

  // Não falar “7 horas”. Só dizer “1 sessão” ou “2+ sessões” quando precisar.
  const sessionsLine = multiSession
    ? `Pelo tamanho/nível de detalhe, eu recomendo fazer em *${perSessionHours.length} sessões* pra manter a qualidade do acabamento.`
    : `Esse projeto dá pra fazer em *uma sessão* mantendo o acabamento certinho.`;

  const deposit =
    `Pra reservar seu horário eu peço um sinal de *${formatCurrencyBRL(DEPOSIT_VALUE)}*.\n` +
    (PIX_KEY
      ? `Chave Pix: *${PIX_KEY}*\n`
      : `Chave Pix: *(me chama que eu te passo a chave certinho)*\n`) +
    `Assim que fizer, me manda o *comprovante* aqui.\n` +
    `Remarcação/alteração de data: aviso com *48h* de antecedência.`;

  const dates =
    `Pra eu já te encaixar direitinho: você prefere *horário comercial* ou *pós-horário*?\n` +
    `E tem alguma data em mente? Se preferir, eu te passo a *data mais próxima* que eu tiver livre.`;

  return [p1, sessionsLine, payment, retouch, p2, deposit, dates].join("\n\n");
}

function msgCoverupPolicy() {
  return (
    `Sobre *cobertura*: eu preciso analisar bem caso a caso.\n` +
    `Como meu estilo é mais delicado (transições e acabamento fino), *eu geralmente evito cobertura* — só pego quando dá pra garantir um resultado realmente bom.\n\n` +
    `Se você quiser, me manda uma foto nítida da tattoo atual (boa luz, sem filtro) e me diz a região/tamanho que eu avalio com sinceridade.`
  );
}

function msgPaymentReceivedAskDates() {
  return (
    `Perfeito — vi seu comprovante.\n\n` +
    `Agora me diz: você prefere *horário comercial* ou *pós-horário*?\n` +
    `E tem alguma data em mente? Se quiser, eu já te passo a *data mais próxima* que eu tiver livre.`
  );
}

/* =========================
   Dedup + repetition guard
========================= */
function shouldIgnoreDuplicate(state, incoming) {
  const id = incoming?.messageId || incoming?.id || null;
  if (id && processedMessageIds.has(id)) return true;
  if (id) {
    processedMessageIds.add(id);
    // limpa set pra não crescer infinito
    if (processedMessageIds.size > 5000) {
      // remove metade (simples)
      let i = 0;
      for (const k of processedMessageIds) {
        processedMessageIds.delete(k);
        i++;
        if (i > 2500) break;
      }
    }
  }
  return false;
}

function shouldSendSameTextAgain(state, text) {
  const h = sha1(text);
  if (state.lastBotTextHash === h) return false;
  state.lastBotTextHash = h;
  return true;
}

/* =========================
   Z-API payload parsing (robusto)
   (Adapte conforme sua Z-API)
========================= */
function extractIncoming(payload) {
  // Tentamos cobrir formatos comuns:
  // payload.phone / payload.data.phone
  // payload.text.message / payload.data.text.message
  // payload.isImage / payload.data.isImage
  // payload.image / payload.data.image (url/base64)
  const p = payload || {};
  const phone = normPhone(p.phone || p?.data?.phone || p?.sender?.phone || p?.from);
  const text =
    p?.text?.message ??
    p?.data?.text?.message ??
    p?.message ??
    p?.data?.message ??
    p?.body ??
    "";

  const isImage = Boolean(p?.isImage ?? p?.data?.isImage ?? p?.image ?? p?.data?.image ?? p?.media ?? false);

  const imageUrl =
    p?.image?.url ??
    p?.data?.image?.url ??
    p?.media?.url ??
    p?.data?.media?.url ??
    p?.imageUrl ??
    p?.data?.imageUrl ??
    null;

  const imageBase64 =
    p?.image?.base64 ??
    p?.data?.image?.base64 ??
    p?.media?.base64 ??
    p?.data?.media?.base64 ??
    p?.base64 ??
    null;

  const messageId = p?.messageId || p?.data?.messageId || p?.id || p?.data?.id || null;

  return { phone, text: String(text || ""), isImage, imageUrl, imageBase64, messageId };
}

/* =========================
   Main webhook
========================= */
app.get("/", (req, res) => res.status(200).send("OK"));
app.get("/health", (req, res) => res.status(200).json({ ok: true }));

app.post("/zapi", async (req, res) => {
  const payload = req.body;

  let inc;
  try {
    inc = extractIncoming(payload);
  } catch (e) {
    console.error("[ZAPI IN] parse fail", e);
    return res.status(200).json({ ok: true });
  }

  if (!inc.phone) {
    console.warn("[ZAPI IN] no phone");
    return res.status(200).json({ ok: true });
  }

  const state = getState(inc.phone);
  state.lastUpdatedAt = nowIso();

  if (shouldIgnoreDuplicate(state, inc)) {
    return res.status(200).json({ ok: true, dedup: true });
  }

  console.log("[ZAPI IN] phone:", inc.phone);
  console.log("[ZAPI IN] text:", inc.text ? { message: inc.text } : "");
  console.log("[ZAPI IN] isImage:", inc.isImage);

  // Atualiza estado com informações do usuário
  const userTextHash = sha1(inc.text || "");
  state.lastUserTextHash = userTextHash;

  // Se veio imagem
  if (inc.isImage || inc.imageUrl || inc.imageBase64) {
    state.hasImage = true;
    state.imageUrl = inc.imageUrl || state.imageUrl;
    state.imageBase64 = inc.imageBase64 || state.imageBase64;
  }

  // parse region / fidelity / size
  const region = parseRegion(inc.text);
  const fidelity = parseFidelity(inc.text);
  const sizeCm = parseSizeCm(inc.text);

  if (region && !state.region) state.region = region;
  if (fidelity && !state.fidelity) state.fidelity = fidelity;
  if (sizeCm && !state.sizeCm) state.sizeCm = sizeCm;

  // Cobertura
  if (looksLikeCoverup(inc.text)) {
    const text = msgCoverupPolicy();
    if (shouldSendSameTextAgain(state, text)) await sendText(state.phone, text);
    return res.status(200).json({ ok: true });
  }

  // Comprovante/pagamento
  const paymentSignal = looksLikePayment(inc.text) || (inc.isImage && state.stage === "ASK_DATES");
  if (paymentSignal && OWNER_PHONE) {
    // Notifica você no seu Whats pessoal
    const note =
      `📌 *Possível sinal/comprovante recebido*\n` +
      `Cliente: ${state.phone}\n` +
      `Região: ${state.region || "—"} | Fiel/Alterar: ${state.fidelity || "—"} | Tam: ${state.sizeCm || "—"}cm\n` +
      `Mensagem: ${inc.text ? inc.text.slice(0, 400) : "(imagem)"}\n`;
    try {
      await sendText(OWNER_PHONE, note);
    } catch (e) {
      console.error("[OWNER NOTIFY FAIL]", e?.message || e);
    }
  }

  // Fluxo principal:
  try {
    // 1) Se ainda não tem o básico, pede (sem repetir)
    const missingMsg = msgAskMissing(state);
    if (missingMsg) {
      state.stage = "ASKING";
      if (shouldSendSameTextAgain(state, missingMsg)) {
        await sendText(state.phone, missingMsg);
      }
      return res.status(200).json({ ok: true });
    }

    // 2) Se já tem imagem + região + fidelidade -> gerar orçamento/descrição
    if (state.hasImage && state.region && state.fidelity && state.stage !== "QUOTED") {
      state.stage = "READY_TO_QUOTE";

      // 2.1) tenta OpenAI (descrição + sugestão de horas)
      let desc = null;
      let suggestedHours = null;
      let canSee = false;

      const ai = await openaiDescribeAndEstimate({
        imageUrl: state.imageUrl,
        imageBase64: state.imageBase64,
        region: state.region,
        fidelity: state.fidelity,
        sizeCm: state.sizeCm,
      });

      if (ai.ok && ai.canSee) {
        desc = ai.description;
        suggestedHours = ai.suggestedHours;
        canSee = true;
      }

      // 2.2) fallback horas
      let estimatedHours = suggestedHours;
      if (!estimatedHours || !Number.isFinite(estimatedHours)) {
        estimatedHours = estimateHoursFallback({ region: state.region, sizeCm: state.sizeCm });
      }

      // garante no mínimo 2.5h e máx 12h
      estimatedHours = Math.max(2.5, Math.min(12, estimatedHours));

      const { total, perSessionHours } = computeInvestment({
        region: state.region,
        estimatedHours,
      });

      state.quotedValue = total;

      const text = msgQuote({
        description: desc,
        total,
        perSessionHours,
        region: state.region,
        fidelity: state.fidelity,
        hasOpenAiVision: canSee,
      });

      if (shouldSendSameTextAgain(state, text)) {
        await sendText(state.phone, text);
      }

      state.stage = "QUOTED";
      return res.status(200).json({ ok: true });
    }

    // 3) Se já orçou, e cliente manda comprovante -> pedir datas (sem voltar a perguntar região/tamanho)
    if (state.stage === "QUOTED" && (looksLikePayment(inc.text) || inc.isImage)) {
      const text = msgPaymentReceivedAskDates();
      if (shouldSendSameTextAgain(state, text)) await sendText(state.phone, text);
      state.stage = "ASK_DATES";
      return res.status(200).json({ ok: true });
    }

    // 4) Se não caiu em nada, manda intro só se for primeira interação
    if (state.stage === "INIT") {
      const text = msgIntroAsk();
      if (shouldSendSameTextAgain(state, text)) await sendText(state.phone, text);
      state.stage = "ASKING";
      return res.status(200).json({ ok: true });
    }

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error("[BOT ERROR]", e?.message || e);
    // resposta segura pro cliente (sem ficar repetindo)
    const safe =
      `Deu um erro aqui do meu lado pra processar essa mensagem.\n` +
      `Me manda de novo a *imagem* e a *região do corpo*, por favor, que eu já sigo.`;
    try {
      if (shouldSendSameTextAgain(state, safe)) await sendText(state.phone, safe);
    } catch {}
    return res.status(200).json({ ok: true });
  }
});

/* =========================
   Start
========================= */
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
