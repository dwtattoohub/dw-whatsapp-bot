/**
 * DW WhatsApp Bot (Z-API + OpenAI)
 * Fluxo: atendimento humano/profissional + orçamento + sinal + confirmação de agenda (manual)
 *
 * ✅ NÃO integra Google Agenda (opção 1). Em vez disso:
 *    - Quando detectar comprovante/sinal → pergunta preferência de datas/horários
 *    - Envia NOTIFICAÇÃO pro seu WhatsApp pessoal com resumo + o que falta
 *
 * ✅ Evita repetição:
 *    - Mantém estado por contato (memória simples em RAM)
 *    - Só pergunta o que ainda falta
 *
 * ✅ Regras de preço (interno, não mostra por hora):
 *    - Regiões especiais: mão, pescoço, pé, costela → 150 1ª hora + 120 demais
 *    - Outras (antebraço, braço, perna, costas etc.) → 150 1ª hora + 100 demais
 *    - Sessão máxima: 7h. Se passar, divide em 2+ sessões.
 *
 * ✅ Pagamento:
 *    - Pix / Débito / Crédito até 12x
 *    - 1 sessão de retoque inclusa (se necessário) entre 40–50 dias
 *    - Sinal: R$100 (se total > R$1000 pode ser 10% OU R$100 — aqui usei: R$100 padrão, e 10% se quiser ativar)
 *
 * ✅ Cobertura:
 *    - Pede foto pra avaliar, mas já avisa que normalmente não pega cobertura (rip/whip shading é delicado)
 *
 * 🔧 ENV VARS (Render):
 *   ZAPI_INSTANCE_ID         (ex: 3ED9....)
 *   ZAPI_INSTANCE_TOKEN      (token da instância, ex: B5BBE....)
 *   ZAPI_CLIENT_TOKEN        (token de segurança da conta, se habilitado; se não tiver, deixe vazio e o bot não usa)
 *   OPENAI_API_KEY
 *   PIX_KEY                  (chave pix)
 *   OWNER_PHONE              (seu whats pessoal com DDI+DDD+numero, ex: 5544999999999)
 *   PUBLIC_BASE_URL          (opcional; ex: https://dw-whatsapp-bot.onrender.com)
 */

import express from "express";
import axios from "axios";
import crypto from "crypto";

const app = express();
app.use(express.json({ limit: "10mb" }));

// ------------------ ENV ------------------
function getEnv(name, optional = false) {
  const v = process.env[name];
  if (!v && !optional) throw new Error(`Missing env var: ${name}`);
  return v;
}

const ZAPI_INSTANCE_ID = getEnv("ZAPI_INSTANCE_ID");
const ZAPI_INSTANCE_TOKEN = getEnv("ZAPI_INSTANCE_TOKEN");
const ZAPI_CLIENT_TOKEN = getEnv("ZAPI_CLIENT_TOKEN", true) || ""; // pode estar vazio
const OPENAI_API_KEY = getEnv("OPENAI_API_KEY");
const PIX_KEY = getEnv("PIX_KEY");
const OWNER_PHONE = getEnv("OWNER_PHONE");
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || "";

// Z-API base
const ZAPI_BASE = `https://api.z-api.io/instances/${ZAPI_INSTANCE_ID}/token/${ZAPI_INSTANCE_TOKEN}`;

// ------------------ SIMPLE MEMORY (RAM) ------------------
/**
 * state per phone:
 * {
 *   stage: 'start'|'collecting'|'quoted'|'awaiting_deposit'|'awaiting_schedule'|'done',
 *   name?: string,
 *   region?: string,
 *   sizeCm?: string,
 *   fidelity?: 'fiel'|'adaptar'|null,
 *   references: { hasImage: boolean, lastImageUrl?: string },
 *   lastUserMsgAt?: number,
 *   lastBotMsgHash?: string,
 *   quotedValue?: number,
 *   hoursEstimate?: number,
 *   sessions?: number,
 *   depositReceived?: boolean,
 *   schedulePrefs?: { period?: 'comercial'|'pos'|'tanto_faz', dates?: string },
 * }
 */
const memory = new Map();

// anti-spam: prevent double-processing same incoming message id
const seenMessageIds = new Set();
function rememberMessageId(id) {
  if (!id) return false;
  if (seenMessageIds.has(id)) return true;
  seenMessageIds.add(id);
  // prevent unbounded growth
  if (seenMessageIds.size > 5000) {
    const arr = Array.from(seenMessageIds);
    arr.slice(0, 2000).forEach((x) => seenMessageIds.delete(x));
  }
  return false;
}

// ------------------ HELPERS ------------------
function normPhone(phone) {
  return String(phone || "").replace(/\D/g, "");
}

function getState(phone) {
  const p = normPhone(phone);
  if (!memory.has(p)) {
    memory.set(p, {
      stage: "start",
      references: { hasImage: false },
      depositReceived: false,
    });
  }
  return memory.get(p);
}

function setState(phone, patch) {
  const st = getState(phone);
  Object.assign(st, patch);
  return st;
}

function hashText(t) {
  return crypto.createHash("sha1").update(String(t)).digest("hex");
}

function shouldSend(phone, text) {
  const st = getState(phone);
  const h = hashText(text);
  if (st.lastBotMsgHash === h) return false;
  st.lastBotMsgHash = h;
  return true;
}

function isGreeting(text) {
  const t = (text || "").toLowerCase().trim();
  return ["oi", "ola", "olá", "bom dia", "boa tarde", "boa noite"].some((x) =>
    t.startsWith(x)
  );
}

function looksLikeDepositProof(text) {
  const t = (text || "").toLowerCase();
  return (
    t.includes("comprovante") ||
    t.includes("paguei") ||
    t.includes("pago") ||
    t.includes("pix feito") ||
    t.includes("enviei o pix") ||
    t.includes("transferi") ||
    t.includes("sinal") ||
    t.includes("pgto") ||
    t.includes("pagamento")
  );
}

function isCoverageQuestion(text) {
  const t = (text || "").toLowerCase();
  return t.includes("cobertura") || t.includes("cover") || t.includes("tapar");
}

function extractRegion(text) {
  const t = (text || "").toLowerCase();
  const regions = [
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
    "costas",
    "perna",
    "panturrilha",
    "coxa",
    "ombro",
    "peito",
    "barriga",
    "clavícula",
    "clavicula",
    "nuca",
  ];
  const found = regions.find((r) => t.includes(r));
  if (!found) return null;

  // normalize
  const map = {
    mao: "mão",
    pe: "pé",
    pescoco: "pescoço",
    antebraco: "antebraço",
    braco: "braço",
    clavicula: "clavícula",
  };
  return map[found] || found;
}

function extractSize(text) {
  // match "10cm", "10 cm", "10x15", "10 x 15 cm"
  const t = (text || "").toLowerCase();
  const m1 = t.match(/(\d{1,2})\s*(x|×)\s*(\d{1,2})\s*(cm)?/);
  if (m1) return `${m1[1]}x${m1[3]} cm`;
  const m2 = t.match(/(\d{1,2})\s*(cm)\b/);
  if (m2) return `${m2[1]} cm`;
  return null;
}

function regionIsSpecial(region) {
  if (!region) return false;
  const r = region.toLowerCase();
  return ["mão", "pescoço", "pé", "costela"].includes(r);
}

function defaultHoursByRegion(region) {
  // heurística base (ajustável)
  if (!region) return 5;
  const r = region.toLowerCase();
  if (r === "mão") return 3;
  if (r === "pescoço") return 3;
  if (r === "pé") return 3;
  if (r === "costela") return 5;
  if (r === "antebraço") return 5;
  if (r === "braço") return 6;
  if (r === "perna" || r === "coxa" || r === "panturrilha") return 6;
  if (r === "costas") return 7;
  return 5;
}

function sessionsFromHours(hours) {
  // max 7h por sessão
  if (!hours || hours <= 7) return 1;
  return Math.ceil(hours / 7);
}

function calcPriceInternal(region, hours) {
  const h = Math.max(1, Math.round(hours || 1));
  const first = 150;
  const extraRate = regionIsSpecial(region) ? 120 : 100;
  if (h === 1) return first;
  return first + (h - 1) * extraRate;
}

// ------------------ Z-API SEND ------------------
async function zapiSendText(phone, message) {
  const url = `${ZAPI_BASE}/send-text`;
  const headers = {};
  if (ZAPI_CLIENT_TOKEN) headers["Client-Token"] = ZAPI_CLIENT_TOKEN;

  const payload = { phone, message };

  const res = await axios.post(url, payload, { headers }).catch((e) => {
    const status = e?.response?.status;
    const data = e?.response?.data;
    console.error("[ZAPI SEND FAIL]", status, data || e.message);
    throw e;
  });
  return res.data;
}

async function notifyOwner(summary) {
  const msg =
    `📌 *DW BOT — AÇÃO PRA VOCÊ*\n\n` +
    summary +
    `\n\n(Agenda é manual. Se quiser, responda o cliente direto.)`;

  await zapiSendText(OWNER_PHONE, msg);
}

// ------------------ OPENAI (TEXT) ------------------
async function openaiChat(system, user) {
  const url = "https://api.openai.com/v1/chat/completions";
  const headers = {
    Authorization: `Bearer ${OPENAI_API_KEY}`,
    "Content-Type": "application/json",
  };

  const body = {
    model: "gpt-4o-mini",
    temperature: 0.4,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  };

  const res = await axios.post(url, body, { headers });
  return res.data.choices?.[0]?.message?.content?.trim() || "";
}

// ------------------ IMAGE NORMALIZATION (Z-API incoming) ------------------
function extractImageUrlFromWebhook(payload) {
  // Z-API webhooks variam. Tentamos vários caminhos comuns.
  // Você mostrou log: imageType:'unknown' imageMime:null e "could not normalize image".
  // Então aqui a gente tenta pegar qualquer URL que venha no payload.
  const p = payload || {};
  const possible = [
    p?.message?.image?.imageUrl,
    p?.message?.image?.url,
    p?.message?.imageUrl,
    p?.message?.url,
    p?.media?.url,
    p?.image?.url,
    p?.image?.imageUrl,
    p?.data?.url,
  ].filter(Boolean);

  if (possible.length) return String(possible[0]);

  // às vezes vem base64 ou id
  const possibleId = [
    p?.message?.image?.id,
    p?.message?.media?.id,
    p?.media?.id,
    p?.image?.id,
  ].filter(Boolean);

  if (possibleId.length) return `id:${possibleId[0]}`;
  return null;
}

function isImageWebhook(payload) {
  const p = payload || {};
  // tenta sinais comuns
  const t =
    p?.type ||
    p?.message?.type ||
    p?.messageType ||
    p?.message?.messageType ||
    "";
  const type = String(t).toLowerCase();
  if (type.includes("image") || type.includes("photo")) return true;

  // fallback: se tiver URL de imagem
  const img = extractImageUrlFromWebhook(payload);
  return !!img && !String(img).startsWith("id:");
}

// ------------------ PROMPT & COPY (BOT VOICE) ------------------
function professionalIntro() {
  return (
    `Opa! Tudo certo?\n` +
    `Obrigado por me chamar e confiar no meu trabalho.\n\n` +
    `Pra eu te passar um orçamento justo e alinhado com o que você quer, eu gosto de entender bem a ideia antes de falar de valor.`
  );
}

function askReferenceIfMissing() {
  return `Me manda a referência em *imagem* (pode ser print também) pra eu avaliar certinho.`;
}

function askRegionIfMissing() {
  return `E em qual região do corpo você pretende fazer? (ex: mão, antebraço, costela, perna, costas)`;
}

function askSizeIfMissing() {
  return `Você tem uma noção de tamanho aproximado em cm? Se não souber, sem problema — me diz só a região que eu consigo te orientar pelo encaixe.`;
}

function askFidelityIfMissing() {
  return `Você quer essa ideia bem fiel à referência, ou prefere que eu adapte pro seu corpo (encaixe e composição) mantendo o estilo?`;
}

function describeProcessAndPayment() {
  return (
    `Como eu trabalho:\n` +
    `• Eu desenvolvo o projeto pensando em encaixe e leitura na pele, pra ficar forte e bem executado.\n` +
    `• Sessões com no máximo *7 horas* (passando disso eu separo em 2+ sessões pra manter qualidade).\n\n` +
    `Pagamento:\n` +
    `• Pix\n` +
    `• Débito\n` +
    `• Crédito em até 12x\n\n` +
    `O orçamento já inclui *1 sessão de retoque* (se necessário) entre *40 e 50 dias* após cicatrização.`
  );
}

function depositMessage(value) {
  // regra do sinal: R$100 padrão (como você pediu)
  const deposit = 100;

  return (
    `Pelo tamanho e complexidade do que você me pediu, o investimento fica em *R$ ${value}*.\n\n` +
    `Pra reservar seu horário, eu peço um sinal de *R$ ${deposit}*.\n` +
    `Chave Pix: ${PIX_KEY}\n\n` +
    `Assim que confirmar o Pix, me manda o comprovante aqui que eu já sigo com as datas.`
  );
}

function scheduleQuestions() {
  return (
    `Perfeito — recebendo o sinal eu já separo um horário pra você.\n\n` +
    `Me diz só:\n` +
    `1) Você prefere *horário comercial* ou *pós-horário comercial*?\n` +
    `2) Você tem alguma data em mente? (ou semana melhor pra você)\n` +
    `Se preferir, eu posso te passar a *data mais próxima disponível* também.`
  );
}

function coverageReply() {
  return (
    `Cobertura eu preciso avaliar caso a caso.\n` +
    `Como eu trabalho com *whip/rip shading* (bem delicado e com transição suave), eu evito pegar coberturas — na maioria das vezes não compensa pro resultado ficar no meu padrão.\n\n` +
    `Se você quiser, me manda uma foto bem nítida do local (de frente, boa luz) que eu te digo com sinceridade se dá ou se é melhor outro caminho.`
  );
}

// ------------------ CORE LOGIC ------------------
async function handleIncoming({ phone, text, isImage, imageUrl, messageId }) {
  phone = normPhone(phone);
  const st = getState(phone);

  if (rememberMessageId(messageId)) {
    console.log("[SKIP] duplicate messageId:", messageId);
    return;
  }

  // basic parsing
  const region = extractRegion(text);
  const size = extractSize(text);

  if (region && !st.region) st.region = region;
  if (size && !st.sizeCm) st.sizeCm = size;

  if (isImage) {
    st.references.hasImage = true;
    if (imageUrl) st.references.lastImageUrl = imageUrl;
  }

  // COVERAGE
  if (isCoverageQuestion(text)) {
    const msg = coverageReply();
    if (shouldSend(phone, msg)) await zapiSendText(phone, msg);
    return;
  }

  // DEPOSIT / PROOF
  // Se o cliente manda comprovante OU manda imagem depois que já foi pedido sinal.
  const depositSignal =
    looksLikeDepositProof(text) ||
    (isImage && st.stage === "awaiting_deposit");

  if (depositSignal && st.stage !== "done") {
    st.depositReceived = true;
    st.stage = "awaiting_schedule";

    const msg = scheduleQuestions();
    if (shouldSend(phone, msg)) await zapiSendText(phone, msg);

    // notifica você com resumo do que tem
    const summary =
      `Cliente: +${phone}\n` +
      `Status: *Sinal/Comprovante recebido*\n` +
      `Projeto: ${st.references.hasImage ? "✅ tem referência" : "⚠️ sem referência"}\n` +
      `Região: ${st.region || "não informado"}\n` +
      `Tamanho: ${st.sizeCm || "não informado"}\n` +
      `Preferência (fidelidade): ${st.fidelity || "não informado"}\n` +
      `Ação: *Definir data/horário e anotar na agenda*`;

    await notifyOwner(summary);
    return;
  }

  // SCHEDULE PREFS HANDLING
  if (st.stage === "awaiting_schedule") {
    // tenta capturar preferência comercial/pós e datas
    const t = (text || "").toLowerCase();

    let period = st.schedulePrefs?.period;
    if (!period) {
      if (t.includes("comercial")) period = "comercial";
      if (t.includes("pós") || t.includes("pos") || t.includes("noite"))
        period = "pos";
      if (t.includes("tanto faz") || t.includes("qualquer"))
        period = "tanto_faz";
    }

    const dates = st.schedulePrefs?.dates || (text && text.length > 2 ? text : "");

    st.schedulePrefs = { period: period || st.schedulePrefs?.period, dates };

    // resposta pro cliente confirmando que você vai sugerir datas
    const msg =
      `Fechado. Vou organizar aqui e te mando as opções de horário certinhas.\n` +
      `Se eu precisar confirmar algum detalhe rapidinho, eu te chamo por aqui.`;

    if (shouldSend(phone, msg)) await zapiSendText(phone, msg);

    // notifica você com o que o cliente respondeu
    const summary =
      `Cliente: +${phone}\n` +
      `Status: *Definindo agenda*\n` +
      `Preferência: ${st.schedulePrefs.period || "não claro"}\n` +
      `Datas/observações: ${st.schedulePrefs.dates || "não informado"}\n` +
      `Ação: *Responder com 2–3 horários e lançar na Google Agenda*`;

    await notifyOwner(summary);

    st.stage = "done";
    return;
  }

  // FIRST CONTACT / COLLECT INFO
  const missing = [];
  if (!st.references.hasImage) missing.push("ref");
  if (!st.region) missing.push("region");
  // tamanho é opcional
  if (!st.fidelity) missing.push("fidelity");

  // greeting
  if (st.stage === "start") {
    st.stage = "collecting";
    const intro = professionalIntro();
    if (shouldSend(phone, intro)) await zapiSendText(phone, intro);
  }

  // ask next missing (one at a time, to avoid spam)
  if (missing.includes("ref")) {
    const msg = askReferenceIfMissing();
    if (shouldSend(phone, msg)) await zapiSendText(phone, msg);
    return;
  }

  if (missing.includes("region")) {
    const msg = askRegionIfMissing();
    if (shouldSend(phone, msg)) await zapiSendText(phone, msg);
    return;
  }

  if (missing.includes("fidelity")) {
    // detect fidelity from text
    const t = (text || "").toLowerCase();
    if (t.includes("fiel")) st.fidelity = "fiel";
    if (t.includes("adapt") || t.includes("encaixe")) st.fidelity = "adaptar";

    if (!st.fidelity) {
      const msg = askFidelityIfMissing();
      if (shouldSend(phone, msg)) await zapiSendText(phone, msg);
      return;
    }
  }

  // If client asked size explicitly, we can ask. Otherwise skip.
  if (!st.sizeCm && (text || "").toLowerCase().includes("tamanho")) {
    const msg = askSizeIfMissing();
    if (shouldSend(phone, msg)) await zapiSendText(phone, msg);
    return;
  }

  // READY TO QUOTE:
  // 1) explicar complexidade antes de preço
  // 2) calcular internamente horas e valor
  // 3) mandar forma de sessão/pagamento/retoke
  // 4) mandar preço e sinal (pix)
  if (st.stage !== "awaiting_deposit" && st.stage !== "quoted") {
    // Heurística de horas:
    // - Base por região
    // - Se tiver tamanho 2D maior, sobe
    let hours = defaultHoursByRegion(st.region);

    if (st.sizeCm) {
      const m = st.sizeCm.match(/(\d{1,2})x(\d{1,2})/);
      if (m) {
        const a = Number(m[1]);
        const b = Number(m[2]);
        const area = a * b;
        if (area >= 180) hours += 2; // ex: 12x15+
        else if (area >= 120) hours += 1; // ex: 10x12
      } else {
        const m1 = st.sizeCm.match(/(\d{1,2})/);
        if (m1 && Number(m1[1]) >= 15) hours += 1;
      }
    }

    // Sessões
    const sessions = sessionsFromHours(hours);

    // Valor
    const value = calcPriceInternal(st.region, hours);

    st.hoursEstimate = hours;
    st.sessions = sessions;
    st.quotedValue = value;
    st.stage = "awaiting_deposit";

    // descrição técnica (sem falar horas nem valor por hora)
    const system =
      `Você é um tatuador profissional, linguagem humana e objetiva, sem emojis em excesso. ` +
      `Antes de falar preço, descreva rapidamente por que o projeto é complexo (sombras, transições, profundidade, detalhes, contraste, encaixe). ` +
      `NÃO fale horas e NÃO fale valor por hora. ` +
      `Fale que sessões passam no máximo 7h e pode dividir. ` +
      `Depois, informe as formas de pagamento e retoque incluso. ` +
      `Seja direto e profissional.`;

    const user =
      `Cliente mandou referência (tem imagem), região: ${st.region}, tamanho: ${
        st.sizeCm || "não informado"
      }, preferência: ${st.fidelity}. ` +
      `Escreva a explicação do trabalho (complexidade) + processo (max 7h/sessão; pode dividir em ${sessions} sessão(ões) se precisar) + pagamento (pix/débito/crédito 12x) + retoque 40-50 dias.`;

    const preface = await openaiChat(system, user);

    const block = describeProcessAndPayment();
    const price = depositMessage(value);

    const finalMsg = `${preface}\n\n${block}\n\n${price}`;

    if (shouldSend(phone, finalMsg)) await zapiSendText(phone, finalMsg);

    // Notifica você com resumo do orçamento
    const summary =
      `Cliente: +${phone}\n` +
      `Status: *Orçamento enviado (aguardando sinal)*\n` +
      `Região: ${st.region || "não informado"}\n` +
      `Tamanho: ${st.sizeCm || "não informado"}\n` +
      `Fidelidade: ${st.fidelity || "não informado"}\n` +
      `Estimativa interna: ${st.hoursEstimate}h / ${st.sessions} sessão(ões)\n` +
      `Valor enviado: R$ ${st.quotedValue}\n` +
      `Ação: Aguardar comprovante`;

    await notifyOwner(summary);

    return;
  }

  // If already quoted and client keeps talking, be helpful but don't repeat the same asks.
  // If they ask "valor?" and we already quoted → remind deposit flow briefly.
  const t = (text || "").toLowerCase();
  if (st.stage === "awaiting_deposit") {
    if (t.includes("valor") || t.includes("preço") || t.includes("orc") || t.includes("orç")) {
      const msg =
        `Pra reservar, é só fazer o sinal de *R$ 100* no Pix (${PIX_KEY}) e me mandar o comprovante aqui. Aí eu já te passo as opções de data/horário.`;
      if (shouldSend(phone, msg)) await zapiSendText(phone, msg);
      return;
    }
  }

  // fallback: short helpful
  if (isGreeting(text)) {
    const msg = `Tudo certo! Me diz como você quer seguir que eu te ajudo por aqui.`;
    if (shouldSend(phone, msg)) await zapiSendText(phone, msg);
  }
}

// ------------------ WEBHOOK ENDPOINT ------------------
app.post("/zapi", async (req, res) => {
  try {
    const payload = req.body;

    // Ajuste conforme o webhook real da Z-API (pode variar):
    const phone =
      payload?.phone ||
      payload?.from ||
      payload?.data?.phone ||
      payload?.data?.from ||
      payload?.message?.phone ||
      payload?.message?.from;

    const text =
      payload?.text?.message ||
      payload?.message?.text ||
      payload?.message ||
      payload?.data?.text ||
      payload?.data?.message ||
      "";

    const messageId =
      payload?.messageId ||
      payload?.data?.messageId ||
      payload?.id ||
      payload?.data?.id ||
      payload?.message?.id ||
      null;

    const isImage = isImageWebhook(payload);
    const imageUrl = isImage ? extractImageUrlFromWebhook(payload) : null;

    console.log("[ZAPI IN] phone:", phone);
    console.log("[ZAPI IN] text:", typeof text === "string" ? { message: text } : text);
    console.log("[ZAPI IN] isImage:", isImage);
    if (isImage) console.log("[ZAPI IN] imageUrl:", imageUrl);

    if (!phone) {
      res.status(200).json({ ok: true, ignored: "no phone" });
      return;
    }

    await handleIncoming({
      phone,
      text: typeof text === "string" ? text : JSON.stringify(text),
      isImage,
      imageUrl,
      messageId,
    });

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("[WEBHOOK ERROR]", err?.message);
    res.status(200).json({ ok: false, error: err?.message });
  }
});

// health
app.get("/", (req, res) => {
  res.status(200).send("OK");
});
app.get("/health", (req, res) => {
  res.status(200).json({ ok: true });
});

// ------------------ START ------------------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Webhook: ${PUBLIC_BASE_URL ? PUBLIC_BASE_URL : ""}/zapi`);
});
