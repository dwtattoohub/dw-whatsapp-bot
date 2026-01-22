/**
 * DW WhatsApp Bot (Z-API + OpenAI) — app.js (COMPLETO)
 * - Webhook: POST /zapi
 * - Reset via navegador: GET /reset?phone=55...
 * - Reset via WhatsApp: cliente/you envia "reset" ou "cancelar"
 * - Evita perguntas repetidas (estado por telefone)
 * - Lê imagem quando possível (baixa e manda como dataURL pro OpenAI)
 * - Orçamento: não mostra horas nem valor/hora pro cliente (cálculo é interno)
 * - Sinal: R$ 50 (PIX)
 * - Pagamento: Pix / Débito / Crédito até 12x (com taxa conforme parcelas)
 * - Retoque: incluso se necessário (40–50 dias)
 * - Remarcação: aviso mínimo 48h
 * - Sessão > 7h: divide em 2+ sessões (só menciona se precisar)
 * - Notifica OWNER_PHONE quando detectar comprovante
 */

import express from "express";
import axios from "axios";
import crypto from "crypto";

const app = express();
app.use(express.json({ limit: "20mb" }));

/* =========================
   ENV (Render -> Environment)
========================= */
function getEnv(name, { optional = false } = {}) {
  const v = process.env[name];
  if (!v && !optional) throw new Error(`Missing env var: ${name}`);
  return v;
}

const PORT = process.env.PORT || 10000;

// Z-API
const ZAPI_INSTANCE_ID = getEnv("ZAPI_INSTANCE_ID");          // ID da instância (campo "ID da instância")
const ZAPI_INSTANCE_TOKEN = getEnv("ZAPI_INSTANCE_TOKEN");    // token da instância (token exibido na instância)
const ZAPI_BASE_URL = getEnv("ZAPI_BASE_URL", { optional: true }) || "https://api.z-api.io";

// OPENAI
const OPENAI_API_KEY = getEnv("OPENAI_API_KEY");
const OPENAI_MODEL = getEnv("OPENAI_MODEL", { optional: true }) || "gpt-4o-mini";

// Negócio
const OWNER_PHONE = getEnv("OWNER_PHONE"); // seu WhatsApp pessoal p/ notificação (formato 55DDDNÚMERO)
const PIX_KEY = getEnv("PIX_KEY");         // sua chave pix
const STUDIO_CITY = process.env.STUDIO_CITY || "Maringá";
const DEPOSIT_VALUE = Number(process.env.DEPOSIT_VALUE || 50);

// Regras internas de precificação
const RATE_FIRST_HOUR = Number(process.env.RATE_FIRST_HOUR || 150);
const RATE_DEFAULT_NEXT = Number(process.env.RATE_DEFAULT_NEXT || 100);
const RATE_SPECIAL_NEXT = Number(process.env.RATE_SPECIAL_NEXT || 120);

// regiões “especiais” (mão/pé/pescoço/costela) = 150 + 120
const SPECIAL_REGIONS = new Set(["mao", "mão", "pe", "pé", "pés", "pescoco", "pescoço", "costela", "costelas"]);

// Ajuste se o cliente quiser “mensal” (parcelar em sessões mensais)
// Ex.: 1.000 em 2 meses => 1.200 (ajuste de +200 por mês extra)
const MONTHLY_SPLIT_SURCHARGE_PER_EXTRA_MONTH = Number(
  process.env.MONTHLY_SPLIT_SURCHARGE_PER_EXTRA_MONTH || 200
);

// Limite por sessão
const MAX_SESSION_HOURS = Number(process.env.MAX_SESSION_HOURS || 7);

/* =========================
   ESTADO (anti-repetição)
========================= */
const sessions = new Map(); // phone -> state

function now() { return Date.now(); }

function getState(phone) {
  if (!sessions.has(phone)) {
    sessions.set(phone, {
      createdAt: now(),
      updatedAt: now(),

      // dados do projeto
      bodyRegion: null,        // "antebraço", etc.
      sizeCm: null,            // número (se houver)
      fidelity: null,          // "fiel" | "adaptar" | null
      wantsChanges: null,      // boolean | null
      hasReferenceImage: false,
      lastImageDataUrl: null,  // dataURL para visão

      // orçamento / fluxo
      analysisText: null,      // texto de análise (p/ explicar valor)
      internalHours: null,     // número
      internalSessions: null,  // número
      quoteValue: null,        // número final
      quoteSent: false,

      // sinal / agendamento
      waitingDepositProof: false,
      depositConfirmed: false,
      schedulingAsked: false,

      // anti-dup
      lastUserFingerprint: null,
      lastBotFingerprint: null,
      lastBotAt: 0,
      lastUserAt: 0,
    });
  }
  return sessions.get(phone);
}

function resetState(phone) {
  sessions.delete(phone);
  return getState(phone);
}

function fingerprint(obj) {
  const s = typeof obj === "string" ? obj : JSON.stringify(obj);
  return crypto.createHash("sha1").update(s).digest("hex");
}

function normalizePhone(p) {
  return String(p || "").replace(/\D/g, "");
}

/* =========================
   Z-API helpers
========================= */
function zapiUrl(path) {
  // padrão Z-API: /instances/{id}/token/{token}/...
  return `${ZAPI_BASE_URL}/instances/${ZAPI_INSTANCE_ID}/token/${ZAPI_INSTANCE_TOKEN}${path}`;
}

async function zapiSendText(phone, message) {
  const url = zapiUrl("/send-text");
  const payload = { phone, message };
  try {
    await axios.post(url, payload, { timeout: 30000 });
    return true;
  } catch (e) {
    console.error("[ZAPI SEND FAIL]", e?.response?.data || e.message);
    return false;
  }
}

// opcional: se sua Z-API usa outra rota, ajuste acima.
// (Mas não mexe no resto do bot.)

/* =========================
   OPENAI (Responses API via fetch)
========================= */
async function openaiAnalyze({ text, imageDataUrl }) {
  const system = `
Você é um atendente profissional de estúdio de tatuagem (voz humana, direta, educada e persuasiva).
Regras:
- Nunca diga horas de trabalho, nem valor por hora.
- Antes de falar preço, descreva a complexidade do projeto (sombras, transições, encaixe na região, detalhes finos, contraste).
- Use parágrafos curtos.
- Sem assinatura no final.
- Sem excesso de formalidade robótica.
- Se faltar dado essencial, faça no máximo 1 pergunta curta e objetiva juntando tudo (região + fiel/adaptação + tamanho se souber).
- Se houver imagem, descreva o que vê de forma técnica (sem inventar).
`;

  // Pedimos 2 saídas: (1) análise técnica p/ cliente (2) estimativa interna de horas (número)
  const userPrompt = `
Entrada do cliente (texto): ${text || "(sem texto)"}

Tarefa:
1) Gere um parágrafo de "análise técnica" (para o cliente entender o valor) baseado na referência.
2) Gere "ESTIMATIVA_HORAS" como um número plausível (ex: 3.5, 6, 7) com base em complexidade e região. Se não tiver imagem, use o texto.
3) Gere "PERGUNTA_UNICA" apenas se estiver faltando região ou se o cliente quer fiel/adaptar e isso for necessário.
Formato de resposta (obrigatório):
ANALISE: ...
ESTIMATIVA_HORAS: X
PERGUNTA_UNICA: ... (ou vazio)
`;

  const input = imageDataUrl
    ? [
        {
          role: "user",
          content: [
            { type: "input_text", text: userPrompt },
            { type: "input_image", image_url: imageDataUrl },
          ],
        },
      ]
    : [
        {
          role: "user",
          content: [{ type: "input_text", text: userPrompt }],
        },
      ];

  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      input,
      max_output_tokens: 450,
      temperature: 0.6,
    }),
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`OpenAI error: ${res.status} ${t}`);
  }

  const data = await res.json();
  const out = (data.output_text || "").trim();

  const parsed = { analysis: "", hours: null, question: "" };
  for (const line of out.split("\n")) {
    const l = line.trim();
    if (l.startsWith("ANALISE:")) parsed.analysis = l.replace("ANALISE:", "").trim();
    if (l.startsWith("ESTIMATIVA_HORAS:")) {
      const v = l.replace("ESTIMATIVA_HORAS:", "").trim().replace(",", ".");
      const n = Number(v);
      parsed.hours = Number.isFinite(n) ? n : null;
    }
    if (l.startsWith("PERGUNTA_UNICA:")) parsed.question = l.replace("PERGUNTA_UNICA:", "").trim();
  }

  return parsed;
}

/* =========================
   Imagem -> DataURL (para visão)
   (tenta URL, tenta base64)
========================= */
async function toDataUrlFromUrl(url) {
  const r = await axios.get(url, { responseType: "arraybuffer", timeout: 30000 });
  const contentType = r.headers["content-type"] || "image/jpeg";
  const b64 = Buffer.from(r.data, "binary").toString("base64");
  return `data:${contentType};base64,${b64}`;
}

function toDataUrlFromBase64(b64, mime = "image/jpeg") {
  const clean = String(b64).replace(/^data:.*;base64,/, "");
  return `data:${mime};base64,${clean}`;
}

async function extractImageDataUrl(body) {
  // Variações comuns de payload
  const imageUrl =
    body?.image?.imageUrl ||
    body?.image?.url ||
    body?.imageUrl ||
    body?.url;

  const imageBase64 =
    body?.image?.base64 ||
    body?.base64;

  const mime =
    body?.image?.mimeType ||
    body?.image?.mime ||
    body?.mimeType ||
    body?.mime ||
    "image/jpeg";

  if (imageBase64) return toDataUrlFromBase64(imageBase64, mime);
  if (imageUrl) return await toDataUrlFromUrl(imageUrl);

  return null;
}

/* =========================
   Regras internas: orçamento
========================= */
function calcQuote({ hours, bodyRegion }) {
  const regionKey = (bodyRegion || "").toLowerCase();
  const isSpecial = [...SPECIAL_REGIONS].some((r) => regionKey.includes(r));

  const nextRate = isSpecial ? RATE_SPECIAL_NEXT : RATE_DEFAULT_NEXT;

  // sessões por limite de 7h
  const sessionsNeeded = Math.max(1, Math.ceil(hours / MAX_SESSION_HOURS));

  // distribui horas por sessão (para cálculo interno correto)
  let remaining = hours;
  let total = 0;

  for (let s = 0; s < sessionsNeeded; s++) {
    const hThis = Math.min(MAX_SESSION_HOURS, remaining);
    remaining -= hThis;

    // cada sessão reinicia: 1ª hora 150, restantes nextRate
    if (hThis <= 1) {
      total += RATE_FIRST_HOUR * hThis; // se for fracionado
    } else {
      total += RATE_FIRST_HOUR;
      total += (hThis - 1) * nextRate;
    }
  }

  // arredonda para número “limpo”
  // (ajuste simples: arredonda para múltiplos de 10)
  const rounded = Math.round(total / 10) * 10;

  return { total: rounded, sessionsNeeded, isSpecial, nextRate };
}

/* =========================
   Detecção de comprovante
========================= */
function looksLikeReceipt({ text, isImage }) {
  const t = (text || "").toLowerCase();
  if (isImage && (t.includes("pix") || t.includes("comprov") || t.includes("recibo"))) return true;
  if (isImage) return true; // se mandou imagem enquanto aguardando sinal, assume comprovante
  if (t.includes("comprovante") || t.includes("paguei") || t.includes("pago") || t.includes("pix feito")) return true;
  return false;
}

/* =========================
   Mensagens (templates)
========================= */
function buildQuestionCombined() {
  return (
    "Pra eu te passar um orçamento certinho, me diz duas coisas numa mensagem só:\n" +
    "1) Em qual região do corpo você quer fazer?\n" +
    "2) Você quer bem fiel à referência ou quer que eu adapte/ajuste (adicionar/remover algum detalhe)?\n" +
    "Se souber o tamanho aproximado em cm, melhor — mas se não souber, sem problema."
  );
}

function buildPaymentParagraphs({ quoteValue, sessionsNeeded }) {
  const base =
    `Pelo projeto e pelo nível de detalhe, o investimento fica em R$ ${quoteValue}.\n\n` +
    `Pagamento: Pix, débito ou crédito em até 12x (no cartão tem a taxa conforme o número de parcelas).\n\n` +
    `O orçamento já inclui 1 sessão de retoque (se necessário) entre 40 e 50 dias após a cicatrização.\n\n` +
    `Pra reservar seu horário, o sinal é de R$ ${DEPOSIT_VALUE}. Chave Pix: ${PIX_KEY}\n` +
    `Assim que confirmar, me manda o comprovante aqui.\n\n` +
    `Remarcação: com aviso mínimo de 48h.`;

  // Só menciona “dividir em sessões” se realmente for >7h
  const sessionsNote =
    sessionsNeeded > 1
      ? `\n\nPelo tamanho/complexidade, essa peça fica melhor dividida em ${sessionsNeeded} sessões pra manter qualidade e acabamento.`
      : "";

  // Opção “mensal” (se o cliente pedir) — não empurra aqui; só avisa que existe
  const monthly =
    `\n\nSe ficar pesado pagar tudo de uma vez, dá pra organizar em sessões mensais (com ajuste no total).`;

  return base + sessionsNote + monthly;
}

function buildScheduleQuestion() {
  return (
    "Show. Pra eu te encaixar direitinho:\n" +
    "Você prefere horário comercial ou pós-horário?\n" +
    "Tem alguma data em mente? Se não tiver, eu te passo o horário mais próximo que eu tiver livre."
  );
}

/* =========================
   Web routes
========================= */
app.get("/health", (req, res) => res.status(200).send("ok"));

/**
 * RESET via navegador:
 * GET /reset?phone=5544...
 */
app.get("/reset", async (req, res) => {
  const phone = normalizePhone(req.query.phone);
  if (!phone) return res.status(400).send("missing ?phone=55...");
  resetState(phone);
  res.status(200).send(`reset ok for ${phone}`);
});

/**
 * RESET via POST (opcional)
 */
app.post("/reset", async (req, res) => {
  const phone = normalizePhone(req.body?.phone);
  if (!phone) return res.status(400).json({ ok: false, error: "missing phone" });
  resetState(phone);
  res.json({ ok: true, phone });
});

/**
 * WEBHOOK principal (Z-API)
 */
app.post("/zapi", async (req, res) => {
  res.status(200).json({ ok: true }); // responde rápido pro webhook

  try {
    const body = req.body || {};

    const phone = normalizePhone(body.phone || body.from || body?.sender?.phone);
    if (!phone) return;

    const text =
      body?.text?.message ??
      body?.message ??
      body?.body ??
      body?.text ??
      "";

    const isImage = Boolean(body?.isImage) || Boolean(body?.image) || Boolean(body?.media);
    const state = getState(phone);

    // Anti-duplicação (mesma entrada repetida do provedor)
    const userFp = fingerprint({ phone, text: String(text).slice(0, 200), isImage });
    const tooSoon = now() - state.lastUserAt < 1200;
    if (state.lastUserFingerprint === userFp && tooSoon) {
      return;
    }
    state.lastUserFingerprint = userFp;
    state.lastUserAt = now();
    state.updatedAt = now();

    console.log("[ZAPI IN] phone:", phone);
    console.log("[ZAPI IN] text:", text ? { message: text } : "(no text)");
    console.log("[ZAPI IN] isImage:", isImage);

    // Comando reset/cancelar via WhatsApp (você ou cliente)
    const t = String(text || "").trim().toLowerCase();
    if (t === "reset" || t === "cancelar" || t === "cancela") {
      resetState(phone);
      await zapiSendText(phone, "Beleza. Zerei aqui pra gente começar do zero. Me manda a referência e me diz a região do corpo.");
      return;
    }

    // Se estiver aguardando comprovante
    if (state.waitingDepositProof && !state.depositConfirmed) {
      if (looksLikeReceipt({ text, isImage })) {
        state.depositConfirmed = true;
        state.waitingDepositProof = false;

        // Notifica você
        await zapiSendText(
          OWNER_PHONE,
          `✅ SINAL/COMPROVANTE RECEBIDO\nCliente: ${phone}\nMensagem: ${String(text || "").slice(0, 200) || "(imagem)"}`
        );

        // Confirma pro cliente e pergunta sobre datas (não volta pra “região”)
        await zapiSendText(phone, "Perfeito, comprovante recebido. Agora vamos marcar seu horário.");
        await zapiSendText(phone, buildScheduleQuestion());
        state.schedulingAsked = true;
        return;
      }

      // Se mandou qualquer coisa e ainda não é comprovante
      await zapiSendText(
        phone,
        `Show. Quando você conseguir, me manda o comprovante do sinal (R$ ${DEPOSIT_VALUE}) pra eu reservar seu horário pra você.`
      );
      return;
    }

    // Captura imagem (se tiver)
    if (isImage) {
      try {
        const dataUrl = await extractImageDataUrl(body);
        if (dataUrl) {
          state.hasReferenceImage = true;
          state.lastImageDataUrl = dataUrl;
        } else {
          state.hasReferenceImage = true;
          state.lastImageDataUrl = null; // não conseguiu baixar
        }
      } catch (e) {
        console.log("[IMG] could not normalize image:", e.message);
        state.hasReferenceImage = true;
        state.lastImageDataUrl = null;
      }
    }

    // Extrai informações do texto (região / tamanho / fiel/adaptação)
    // Região
    const lower = String(text || "").toLowerCase();
    const regionHints = ["antebra", "braco", "braço", "costela", "perna", "coxa", "panturrilha", "pe", "pé", "mao", "mão", "pesco", "pescoço", "costas", "nuca", "ombro"];
    if (!state.bodyRegion) {
      const found = regionHints.find((h) => lower.includes(h));
      if (found) state.bodyRegion = found;
    }

    // Tamanho em cm (pega primeiro número seguido de cm)
    if (!state.sizeCm) {
      const m = lower.match(/(\d{1,2})(?:\s*)cm/);
      if (m) state.sizeCm = Number(m[1]);
    }

    // Fiel/adaptar
    if (!state.fidelity) {
      if (lower.includes("fiel")) state.fidelity = "fiel";
      if (lower.includes("adapt") || lower.includes("encaix") || lower.includes("mudar") || lower.includes("alter")) state.fidelity = "adaptar";
    }

    // Quer mudanças?
    if (state.wantsChanges === null) {
      if (lower.includes("sem mudar") || lower.includes("igual") || lower.includes("fiel")) state.wantsChanges = false;
      if (lower.includes("adicion") || lower.includes("remov") || lower.includes("mudar") || lower.includes("alter")) state.wantsChanges = true;
    }

    // Se não temos o básico, pergunta 1 vez (juntando tudo)
    const hasEnoughToQuote =
      (state.hasReferenceImage || (text && text.length > 3)) &&
      Boolean(state.bodyRegion) &&
      Boolean(state.fidelity || state.wantsChanges !== null);

    if (!hasEnoughToQuote && !state.quoteSent) {
      // anti-spam de repetição de bot
      const msg = buildQuestionCombined();
      const botFp = fingerprint(msg);
      if (state.lastBotFingerprint !== botFp || now() - state.lastBotAt > 8000) {
        await zapiSendText(phone, msg);
        state.lastBotFingerprint = botFp;
        state.lastBotAt = now();
      }
      return;
    }

    // Já foi cotado e o cliente volta falando qualquer coisa sem contexto:
    // (não re-pergunta “região” se já tem)
    // Se já cotou e não está aguardando comprovante, guie para próximo passo:
    if (state.quoteSent && !state.depositConfirmed && !state.waitingDepositProof) {
      // Se cliente pergunta “pra quando tem horário”
      if (lower.includes("hor") || lower.includes("data") || lower.includes("agenda")) {
        await zapiSendText(phone, `Pra eu reservar certinho, preciso só do sinal de R$ ${DEPOSIT_VALUE}. Chave Pix: ${PIX_KEY}\nMe manda o comprovante aqui que eu já te passo as opções de data.`);
        state.waitingDepositProof = true;
        return;
      }
    }

    // Gera análise + horas via OpenAI
    // (se não houver imagem legível, ainda assim usa texto)
    const analysisResult = await openaiAnalyze({
      text: text || "",
      imageDataUrl: state.lastImageDataUrl || null,
    });

    // Se OpenAI pediu “pergunta única” e ainda falta algo essencial
    if (!hasEnoughToQuote && analysisResult.question && !state.quoteSent) {
      const msg = analysisResult.question;
      const botFp = fingerprint(msg);
      if (state.lastBotFingerprint !== botFp || now() - state.lastBotAt > 8000) {
        await zapiSendText(phone, msg);
        state.lastBotFingerprint = botFp;
        state.lastBotAt = now();
      }
      return;
    }

    // Define horas internas (fallback se OpenAI não retornar)
    const hours = analysisResult.hours ?? (state.sizeCm ? Math.min(7, Math.max(2, state.sizeCm / 6)) : 4);
    state.internalHours = hours;

    // Calcula orçamento interno
    const { total, sessionsNeeded } = calcQuote({ hours, bodyRegion: state.bodyRegion });
    state.internalSessions = sessionsNeeded;
    state.quoteValue = total;

    // Monta mensagem final (análise -> valor -> pagamentos -> sinal)
    // (Sem falar horas, nem 150/100)
    const analysisParagraph = analysisResult.analysis
      ? analysisResult.analysis
      : "Pelo que você me mandou, dá pra ver um nível de detalhe que exige bastante controle de sombra, transição e acabamento pra ficar com profundidade e leitura limpa na pele.";

    const msg =
      `${analysisParagraph}\n\n` +
      buildPaymentParagraphs({ quoteValue: total, sessionsNeeded });

    // anti-repetição do bot
    const botFp = fingerprint(msg);
    if (state.lastBotFingerprint !== botFp || now() - state.lastBotAt > 8000) {
      await zapiSendText(phone, msg);
      state.lastBotFingerprint = botFp;
      state.lastBotAt = now();
    }

    state.quoteSent = true;
    state.waitingDepositProof = true; // após enviar orçamento, próximo passo é comprovante

    return;
  } catch (e) {
    console.error("[WEBHOOK ERROR]", e.message);
  }
});

/* =========================
   START
========================= */
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log("==> Your service is live 🎉");
});
