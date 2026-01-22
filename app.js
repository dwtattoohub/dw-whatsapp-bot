/**
 * ============================
 *  DW WhatsApp Bot (FULL)
 * ============================
 * Z-API + Render + Node/Express
 *
 * ENV (preferencial):
 *  - ZAPI_INSTANCE_ID
 *  - ZAPI_TOKEN
 *  - ZAPI_CLIENT_TOKEN
 *
 * Compat (legado):
 *  - ZAPI_INSTANCE_TOKEN (assumido como INSTANCE_ID)
 *  - ZAPI_CLIENT_TOKEN
 *
 * Outros:
 *  - OWNER_PHONE (seu número com DDI, ex: 5544999999999)
 *  - PIX_KEY (ex: dwtattooshop@gmail.com)
 *  - PORT (Render geralmente injeta; fallback 10000)
 *
 * Opcional:
 *  - BOT_NAME (ex: "Dhy Tattoo")
 */

import express from "express";
import axios from "axios";
import crypto from "crypto";

const app = express();
app.use(express.json({ limit: "10mb" }));

// --------------------------------------------------
// ENV + HELPERS
// --------------------------------------------------
function getEnv(name, { optional = false, fallback = null } = {}) {
  const v = process.env[name];
  if (!v && !optional && fallback == null) {
    throw new Error(`Missing env var: ${name}`);
  }
  return v || fallback;
}

// Credenciais (compatíveis com tua confusão ID vs TOKEN)
const ZAPI_INSTANCE_ID =
  process.env.ZAPI_INSTANCE_ID ||
  process.env.ZAPI_INSTANCE_TOKEN || // legado: você chamou de "token", mas é o ID da instância no painel
  "";

const ZAPI_TOKEN =
  process.env.ZAPI_TOKEN || // token da instância (quando a URL exige)
  process.env.ZAPI_CLIENT_TOKEN || // fallback (não ideal)
  "";

const ZAPI_CLIENT_TOKEN = getEnv("ZAPI_CLIENT_TOKEN");
const OWNER_PHONE = getEnv("OWNER_PHONE");
const PIX_KEY = getEnv("PIX_KEY", { optional: true, fallback: "dwtattooshop@gmail.com" });
const BOT_NAME = getEnv("BOT_NAME", { optional: true, fallback: "Dhy Tattoo" });

const PORT = Number(process.env.PORT || 10000);

// Normaliza formato de URL Z-API (existem duas variações comuns):
// 1) /instances/{INSTANCE_ID}/token/{TOKEN}/send-text  + header client-token
// 2) /instances/{INSTANCE_ID}/token/{CLIENT_TOKEN}/send-text + header client-token (alguns painéis confundem)
// Para não travar, tentamos com ZAPI_TOKEN e se falhar, tentamos com CLIENT_TOKEN.
function buildZapiUrls(path) {
  const base = "https://api.z-api.io";
  const a = `${base}/instances/${ZAPI_INSTANCE_ID}/token/${ZAPI_TOKEN}${path}`;
  const b = `${base}/instances/${ZAPI_INSTANCE_ID}/token/${ZAPI_CLIENT_TOKEN}${path}`;
  return [a, b];
}

function nowMs() {
  return Date.now();
}

function safeLower(s) {
  return String(s || "").trim().toLowerCase();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// --------------------------------------------------
// LOGGING
// --------------------------------------------------
function log(...args) {
  console.log(new Date().toISOString(), ...args);
}
function logErr(...args) {
  console.error(new Date().toISOString(), ...args);
}

// --------------------------------------------------
// STATE (memória em RAM)
// --------------------------------------------------
// state[phone] = { step, data, asked, lastBotHash, lastUserHash, lastSeenAt, seenMessageIds:Set, ... }
const state = Object.create(null);

// TTL para limpeza
const TTL_MS = 1000 * 60 * 60 * 24; // 24h

function getSession(phone) {
  if (!state[phone]) {
    state[phone] = {
      step: "INIT",
      data: {},
      asked: {},
      lastBotHash: null,
      lastUserHash: null,
      lastSeenAt: nowMs(),
      seenMessageIds: new Set(),
      seenUserHashes: new Set(),
      createdAt: nowMs(),
    };
  }
  state[phone].lastSeenAt = nowMs();
  return state[phone];
}

function resetSession(phone) {
  delete state[phone];
}

function cleanupOldSessions() {
  const t = nowMs();
  for (const p of Object.keys(state)) {
    const s = state[p];
    if (t - (s.lastSeenAt || s.createdAt) > TTL_MS) delete state[p];
  }
}
setInterval(cleanupOldSessions, 1000 * 60 * 10);

// --------------------------------------------------
// DEDUPE (anti-repetição)
// --------------------------------------------------
function hashText(s) {
  return crypto.createHash("sha1").update(String(s || "")).digest("hex");
}

function shouldIgnoreUserMessage(session, { messageId, text, isImage }) {
  // dedupe por ID (quando existe)
  if (messageId) {
    if (session.seenMessageIds.has(messageId)) return true;
    session.seenMessageIds.add(messageId);
    if (session.seenMessageIds.size > 200) {
      // poda
      session.seenMessageIds = new Set(Array.from(session.seenMessageIds).slice(-100));
    }
  }

  // dedupe por hash (quando não existe)
  const base = `${isImage ? "[IMG]" : "[TXT]"}:${text || ""}`.trim();
  const h = hashText(base);
  if (session.seenUserHashes.has(h)) return true;
  session.seenUserHashes.add(h);
  if (session.seenUserHashes.size > 200) {
    session.seenUserHashes = new Set(Array.from(session.seenUserHashes).slice(-100));
  }

  return false;
}

function shouldSendBotMessage(session, message) {
  const h = hashText(message);
  if (session.lastBotHash === h) return false;
  session.lastBotHash = h;
  return true;
}

// --------------------------------------------------
// Z-API SEND (corrige "client-token not configured")
// --------------------------------------------------
function zapiHeaders() {
  // Alguns ambientes aceitam client-token somente em header.
  // Para ser à prova de variações, mandamos as variações de casing:
  return {
    "client-token": ZAPI_CLIENT_TOKEN,
    "Client-Token": ZAPI_CLIENT_TOKEN,
    "CLIENT-TOKEN": ZAPI_CLIENT_TOKEN,
    "Content-Type": "application/json",
  };
}

async function zapiPostWithFallback(path, payload) {
  const headers = zapiHeaders();
  const [urlA, urlB] = buildZapiUrls(path);

  // tenta A, se falhar tenta B
  try {
    return await axios.post(urlA, payload, { headers, timeout: 30000 });
  } catch (e1) {
    const data1 = e1?.response?.data;
    logErr("[ZAPI] fail A:", urlA, data1 || e1.message);

    try {
      await sleep(300);
      return await axios.post(urlB, payload, { headers, timeout: 30000 });
    } catch (e2) {
      const data2 = e2?.response?.data;
      logErr("[ZAPI] fail B:", urlB, data2 || e2.message);
      throw e2;
    }
  }
}

async function sendText(phone, message) {
  if (!phone) return false;
  // evita spam duplicado
  const s = getSession(phone);
  if (!shouldSendBotMessage(s, message)) return true;

  const payload = { phone, message };

  try {
    await zapiPostWithFallback("/send-text", payload);
    log("[ZAPI OUT] sent to", phone);
    return true;
  } catch (e) {
    logErr("[ZAPI OUT] SEND FAIL", e?.response?.data || e.message);
    return false;
  }
}

// Notificação no seu Whats pessoal
async function notifyOwner(text) {
  return sendText(OWNER_PHONE, text);
}

// --------------------------------------------------
// PARSERS (texto do cliente)
// --------------------------------------------------
function extractRegion(text) {
  const t = safeLower(text);

  const regions = [
    "antebraço",
    "braco",
    "braço",
    "costas",
    "perna",
    "coxa",
    "panturrilha",
    "peito",
    "ombro",
    "pescoço",
    "mão",
    "mao",
    "pé",
    "pe",
    "costela",
    "barriga",
    "abdômen",
    "abdomen",
  ];

  for (const r of regions) {
    if (t.includes(r)) return r;
  }
  return null;
}

function extractSizeHint(text) {
  const t = safeLower(text);
  // pega algo como "10cm", "15 cm", "20cm"
  const m = t.match(/(\d{1,3})\s*(cm|cent[ií]metros?)/i);
  if (m) return `${m[1]}cm`;

  // heurísticas
  if (t.includes("metade do antebraço")) return "metade do antebraço";
  if (t.includes("antebraço todo")) return "antebraço todo";
  if (t.includes("pequeno")) return "pequeno";
  if (t.includes("médio") || t.includes("medio")) return "médio";
  if (t.includes("grande")) return "grande";

  return null;
}

function extractFidelity(text) {
  const t = safeLower(text);
  const wantsFiel =
    t.includes("fiel") ||
    t.includes("igual") ||
    t.includes("idêntic") ||
    t.includes("identic");

  const wantsChange =
    t.includes("mudar") ||
    t.includes("alterar") ||
    t.includes("adicionar") ||
    t.includes("remover") ||
    t.includes("adaptar") ||
    t.includes("encaixe");

  if (wantsFiel && !wantsChange) return "FIEL";
  if (wantsChange && !wantsFiel) return "AJUSTAR";
  if (wantsFiel && wantsChange) return "MISTO";

  return null;
}

function looksLikePixProof(text) {
  const t = safeLower(text);
  return (
    t.includes("comprovante") ||
    t.includes("pix feito") ||
    t.includes("paguei") ||
    t.includes("pago") ||
    t.includes("transferi") ||
    t.includes("recebedor") ||
    t.includes("transação") ||
    t.includes("transacao")
  );
}

function extractDateIntent(text) {
  const t = safeLower(text);
  const has = t.includes("data") || t.includes("dia") || t.includes("horário") || t.includes("horario") || t.includes("agenda");
  return has;
}

function extractTimePreference(text) {
  const t = safeLower(text);
  const commercial =
    t.includes("comercial") ||
    t.includes("horário comercial") ||
    t.includes("horario comercial") ||
    t.includes("manhã") ||
    t.includes("manha") ||
    t.includes("tarde");

  const after =
    t.includes("pós") ||
    t.includes("pos") ||
    t.includes("pós-expediente") ||
    t.includes("pos expediente") ||
    t.includes("noite") ||
    t.includes("depois do trabalho");

  if (commercial && !after) return "COMERCIAL";
  if (after && !commercial) return "POS";
  if (commercial && after) return "TANTO_FAZ";
  return null;
}

// --------------------------------------------------
// HORAS + PREÇO (suas regras)
// --------------------------------------------------
function regionRate(region) {
  const r = safeLower(region || "");

  // mão, pé, pescoço, costela: 150 + 120
  const special =
    r.includes("mão") || r.includes("mao") || r.includes("pé") || r.includes("pe") || r.includes("pescoço") || r.includes("costela");

  if (special) return { firstHour: 150, otherHours: 120 };

  // antebraço, costas, perna etc: 150 + 100
  return { firstHour: 150, otherHours: 100 };
}

// Heurística mínima: sem IA.
// Você ajusta manualmente a estimativa com base na tua leitura.
// (A ideia aqui é não errar grotesiro nem subestimar.)
function estimateHours({ region, sizeHint, fidelity, hasImage }) {
  let h = 3.0; // base

  const r = safeLower(region || "");
  const s = safeLower(sizeHint || "");

  // região influencia esforço (encaixe e área)
  if (r.includes("costas") || r.includes("peito")) h += 2.0;
  if (r.includes("antebraço")) h += 1.0;
  if (r.includes("perna") || r.includes("coxa") || r.includes("panturrilha")) h += 1.5;
  if (r.includes("mão") || r.includes("mao") || r.includes("pé") || r.includes("pe") || r.includes("pescoço") || r.includes("costela")) h += 0.5;

  // tamanho
  if (s.includes("10cm")) h -= 0.5;
  if (s.includes("15cm")) h += 0.5;
  if (s.includes("20cm")) h += 1.2;
  if (s.includes("metade do antebraço")) h += 1.5;
  if (s.includes("antebraço todo")) h += 2.5;
  if (s.includes("pequeno")) h -= 0.3;
  if (s.includes("médio") || s.includes("medio")) h += 0.4;
  if (s.includes("grande")) h += 1.5;

  // fidelidade (fiel costuma demandar mais precisão)
  if (fidelity === "FIEL") h += 0.8;
  if (fidelity === "AJUSTAR") h += 1.0;
  if (fidelity === "MISTO") h += 1.2;

  // se veio imagem: melhora precisão (assume melhor briefing)
  if (hasImage) h += 0.3;

  // limita
  if (h < 2.0) h = 2.0;
  if (h > 12.0) h = 12.0;

  // arredonda pra 0.5
  return Math.round(h * 2) / 2;
}

function calcOneSessionValue(hours, region) {
  const { firstHour, otherHours } = regionRate(region);
  if (hours <= 1) return firstHour;
  return firstHour + (hours - 1) * otherHours;
}

/**
 * Regra de sessão:
 * - Se <= 7h: 1 sessão
 * - Se > 7h: 2 sessões
 *
 * Preço:
 * - Cada sessão reinicia em 150 (primeira hora)
 * - Horas restantes seguem (100 ou 120) dentro da sessão
 */
function calcProjectPrice(hours, region) {
  if (hours <= 7) {
    return { sessions: 1, total: Math.round(calcOneSessionValue(hours, region)) };
  }

  // divide em duas sessões "balanceadas"
  const s1 = 7;
  const s2 = Math.max(1, hours - 7);

  const v1 = calcOneSessionValue(s1, region);
  const v2 = calcOneSessionValue(s2, region);
  return { sessions: 2, total: Math.round(v1 + v2) };
}

/**
 * Parcelar em sessões mensais (você definiu):
 * - cada sessão extra: +R$150 no total
 * Ex: 1000 em 2 sessões => 1150? Você citou 1200; e depois falou +100 e +150.
 * Você concluiu: "cada sessão a gente vai subir 150 BRL a mais" (regra final).
 * Então usamos +150 por sessão extra.
 */
function applyMonthlySessionSurcharge(baseTotal, sessionsWanted) {
  if (!sessionsWanted || sessionsWanted <= 1) return baseTotal;
  const extraSessions = sessionsWanted - 1;
  return baseTotal + extraSessions * 150;
}

// --------------------------------------------------
// MENSAGENS (profissional + parágrafos + gatilhos)
// --------------------------------------------------
function msgIntro() {
  return (
    `Olá! Tudo certo?\n` +
    `Obrigado por me chamar e confiar no meu trabalho.\n\n` +
    `Para eu te passar um orçamento justo, me manda:\n` +
    `1) A referência em **imagem**\n` +
    `2) A **região do corpo** (ex: antebraço, perna, costas, mão)\n` +
    `3) Se você quer **fiel à referência** ou se quer **alterar algo** (adicionar/remover/ajustar)\n\n` +
    `A partir disso eu te devolvo uma proposta bem certinha.`
  );
}

function msgAskRegionAndFidelity() {
  return (
    `Perfeito, recebi a referência.\n\n` +
    `Agora me confirma, por favor:\n` +
    `• Qual região do corpo?\n` +
    `• Você quer **fiel à referência** ou quer **alterar algo** (adicionar/remover/ajustar)?`
  );
}

function msgAskSize() {
  return (
    `Show.\n\n` +
    `Me diz também o **tamanho aproximado** (em cm se souber). Se não souber, tudo bem — eu calculo pela região e pela referência.`
  );
}

function msgProposal({ region, fidelity, sizeHint, hours, sessions, total }) {
  const sTxt =
    sessions === 1
      ? `Pelo nível de detalhe e encaixe, esse projeto fica em **1 sessão**.`
      : `Pelo nível de detalhe e encaixe, pra manter o padrão de acabamento, esse projeto fica melhor em **2 sessões**.`;

  const pay =
    `Formas de pagamento:\n` +
    `• Pix\n` +
    `• Débito\n` +
    `• Crédito em até 12x (com taxa da maquininha, conforme o número de parcelas)\n\n` +
    `Sinal para reservar o horário: **R$ 50**.\n` +
    `Chave Pix: ${PIX_KEY}\n\n` +
    `Remarcação: pode ajustar a data com **48h de aviso prévio**.`;

  const monthly =
    `\n\nSe ficar pesado pagar tudo de uma vez, dá pra fazer em sessões mensais.\n` +
    `Nesse formato existe um ajuste no total (cada sessão extra adiciona **R$150**).`;

  // gatilhos: clareza + autoridade + segurança
  return (
    `Análise do seu projeto:\n` +
    `• Região: **${region || "não informada"}**\n` +
    `• Direção: **${fidelity || "não informada"}**\n` +
    `• Tamanho: **${sizeHint || "estimado pela referência"}**\n\n` +
    `O que pesa no valor:\n` +
    `• Construção de sombras e transições (whip shading) com controle fino\n` +
    `• Contraste e profundidade para a tattoo “ler bem” na pele\n` +
    `• Ajuste de encaixe pra essa região (pra ficar harmoniosa e durável)\n\n` +
    `${sTxt}\n\n` +
    `Estimativa: **~${hours}h**\n` +
    `Investimento: **R$ ${total}**\n\n` +
    `${pay}` +
    monthly
  );
}

function msgAskSchedulePreference() {
  return (
    `Perfeito.\n\n` +
    `Você prefere:\n` +
    `• **Horário comercial** ou **pós-expediente**?\n\n` +
    `E você tem alguma **data em mente**?\n` +
    `Se não tiver, eu te passo a **data mais próxima disponível**.`
  );
}

function msgAfterProof() {
  return (
    `Perfeito — recebendo o sinal eu já seguro seu horário.\n\n` +
    `Agora me diz: você prefere **horário comercial** ou **pós-expediente**? E qual data fica melhor pra você?`
  );
}

function msgCoveragePolicy() {
  return (
    `Sobre **cobertura**: eu preciso analisar por foto.\n\n` +
    `Mas já te adianto que eu **raramente pego cobertura**, porque meu estilo (whip shading/realismo delicado) exige controle de contraste e pele “respirando”.\n\n` +
    `Se você quiser, me manda uma foto bem nítida da tattoo atual que eu te digo com sinceridade se dá pra fazer com qualidade.`
  );
}

// --------------------------------------------------
// FLOW (máquina de estados)
// --------------------------------------------------
/**
 * Steps:
 * INIT -> WAIT_REF (texto ou imagem)
 * WAIT_REGION_FIDELITY -> WAIT_SIZE -> SENT_PROPOSAL
 * WAIT_SCHEDULE_PREF -> WAIT_PROOF? (depende) -> DONE
 */
async function handleFlow(phone, text, isImage, raw) {
  const s = getSession(phone);

  // comandos manuais úteis
  const t = safeLower(text);
  if (t === "reset" || t === "/reset") {
    resetSession(phone);
    await sendText(phone, "Conversa resetada. Pode me mandar a referência e a região do corpo.");
    return;
  }

  // se o cliente perguntou cobertura em qualquer etapa
  if (t.includes("cobertura") || t.includes("cobrir")) {
    await sendText(phone, msgCoveragePolicy());
    return;
  }

  // PIX comprovante (em qualquer etapa)
  if (looksLikePixProof(text) || (isImage && s.step === "SENT_PROPOSAL")) {
    // notifica você
    await notifyOwner(`✅ POSSÍVEL COMPROVANTE/PIX\nCliente: ${phone}\nEtapa: ${s.step}\nMensagem: ${text || "(imagem)"}\n\nSugestão: conferir e marcar agenda manualmente.`);
    // guia o cliente pro agendamento
    await sendText(phone, msgAfterProof());
    // coloca etapa de agenda
    s.step = "WAIT_SCHEDULE_PREF";
    return;
  }

  // INIT
  if (s.step === "INIT") {
    s.step = "WAIT_REF";
    await sendText(phone, msgIntro());
    return;
  }

  // WAIT_REF
  if (s.step === "WAIT_REF") {
    if (isImage) {
      s.data.hasImage = true;
      s.step = "WAIT_REGION_FIDELITY";
      await sendText(phone, msgAskRegionAndFidelity());
      return;
    }

    // se veio texto, tenta pegar região e fidelidade juntos pra não repetir
    const region = extractRegion(text);
    const fidelity = extractFidelity(text);

    if (region) s.data.region = region;
    if (fidelity) s.data.fidelity = fidelity;

    if (!s.data.hasImage) {
      // precisa da imagem ainda
      await sendText(
        phone,
        `Show.\n\nAgora me manda **a referência em imagem** pra eu analisar certinho e fechar o orçamento.`
      );
      return;
    }
  }

  // WAIT_REGION_FIDELITY
  if (s.step === "WAIT_REGION_FIDELITY") {
    if (isImage) {
      // se o cliente mandou outra imagem, mantém
      s.data.hasImage = true;
      await sendText(phone, "Perfeito. Agora só me confirma a **região do corpo** e se quer **fiel** ou **alterar** algo.");
      return;
    }

    const region = extractRegion(text) || text;
    const fidelity = extractFidelity(text);

    // salva região sempre (mesmo se ele escreveu “antebraço 15cm fiel”)
    s.data.region = region;

    // se fidelidade não veio, tenta pegar do texto
    if (fidelity) s.data.fidelity = fidelity;

    // se ainda não tem fidelidade, pergunta (mas só se ainda não perguntou)
    if (!s.data.fidelity) {
      if (!s.asked.fidelity) {
        s.asked.fidelity = true;
        await sendText(
          phone,
          `Perfeito.\n\nVocê quer **fiel à referência** ou quer **alterar algo** (adicionar/remover/ajustar)?`
        );
        return;
      }
    }

    s.step = "WAIT_SIZE";
    await sendText(phone, msgAskSize());
    return;
  }

  // WAIT_SIZE
  if (s.step === "WAIT_SIZE") {
    if (isImage) {
      // cliente mandou comprovante/imagem; acima já tratamos
      await sendText(phone, "Perfeito. Me diz só o tamanho aproximado ou se prefere que eu estime pela região.");
      return;
    }

    // salva size
    s.data.sizeHint = extractSizeHint(text) || text;

    // se fidelidade ainda não definida, tenta de novo
    if (!s.data.fidelity) {
      s.data.fidelity = extractFidelity(text) || "FIEL";
    }

    // calcula
    const hours = estimateHours({
      region: s.data.region,
      sizeHint: s.data.sizeHint,
      fidelity: s.data.fidelity,
      hasImage: !!s.data.hasImage,
    });

    const { sessions, total } = calcProjectPrice(hours, s.data.region);

    s.data.hours = hours;
    s.data.sessions = sessions;
    s.data.total = total;

    s.step = "SENT_PROPOSAL";
    await sendText(
      phone,
      msgProposal({
        region: s.data.region,
        fidelity: s.data.fidelity,
        sizeHint: s.data.sizeHint,
        hours,
        sessions,
        total,
      })
    );

    // em seguida já puxa agenda (sem ficar repetindo)
    await sendText(phone, msgAskSchedulePreference());
    s.step = "WAIT_SCHEDULE_PREF";
    return;
  }

  // WAIT_SCHEDULE_PREF
  if (s.step === "WAIT_SCHEDULE_PREF") {
    if (isImage) {
      await sendText(phone, "Perfeito. Me diz só se prefere horário comercial ou pós-expediente, e alguma data em mente.");
      return;
    }

    const pref = extractTimePreference(text);
    if (pref) s.data.timePref = pref;

    // notifica você com as infos coletadas
    await notifyOwner(
      `📌 PEDIDO DE AGENDA\nCliente: ${phone}\nPreferência: ${s.data.timePref || "não definida"}\nMensagem: ${text}\n\nDados:\nRegião: ${s.data.region || "-"}\nTamanho: ${s.data.sizeHint || "-"}\nFidelidade: ${s.data.fidelity || "-"}\nHoras: ${s.data.hours || "-"}\nTotal: R$ ${s.data.total || "-"}\nSinal: R$50 | Remarcação 48h`
    );

    s.step = "DONE";
    await sendText(
      phone,
      `Fechado.\n\nVou conferir minha agenda e já te mando as opções mais próximas.\nSe preferir, me diga 2 ou 3 datas que ficam boas pra você que eu encaixo da melhor forma.`
    );
    return;
  }

  // DONE
  await sendText(phone, "Show! Me manda só mais detalhes se quiser que eu refine o orçamento/tamanho.");
}

// --------------------------------------------------
// WEBHOOK NORMALIZATION
// --------------------------------------------------
function normalizeWebhook(body) {
  // Z-API geralmente:
  // { phone: '55...', text: { message: '...' }, image: { ... }, messageId: '...' }
  const phone = body?.phone || body?.from || body?.sender || null;

  const text =
    body?.text?.message ??
    body?.message?.text ??
    body?.message ??
    body?.text ??
    "";

  // isImage: pode vir em "image" ou "imageMessage" etc
  const isImage = !!(body?.image || body?.imageMessage || body?.message?.image || body?.message?.imageMessage);

  const messageId =
    body?.messageId ||
    body?.id ||
    body?.message?.id ||
    body?.data?.id ||
    null;

  return { phone, text: String(text || ""), isImage, messageId };
}

// --------------------------------------------------
// ROUTES
// --------------------------------------------------
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    bot: BOT_NAME,
    instanceId: ZAPI_INSTANCE_ID ? "set" : "missing",
    token: ZAPI_TOKEN ? "set" : "missing",
    clientToken: ZAPI_CLIENT_TOKEN ? "set" : "missing",
    ownerPhone: OWNER_PHONE ? "set" : "missing",
    time: new Date().toISOString(),
  });
});

// reseta tudo
app.get("/reset", (req, res) => {
  for (const k of Object.keys(state)) delete state[k];
  res.send("OK – reset geral.");
});

// reseta um número
app.get("/reset/:phone", (req, res) => {
  resetSession(req.params.phone);
  res.send(`OK – reset ${req.params.phone}`);
});

// webhook
app.post("/zapi", async (req, res) => {
  try {
    const body = req.body || {};
    const { phone, text, isImage, messageId } = normalizeWebhook(body);

    log("[ZAPI IN] phone:", phone);
    log("[ZAPI IN] text:", text ? text.slice(0, 160) : "");
    log("[ZAPI IN] isImage:", isImage);
    if (messageId) log("[ZAPI IN] messageId:", messageId);

    if (!phone) {
      res.send("OK (no phone)");
      return;
    }

    const s = getSession(phone);
    if (shouldIgnoreUserMessage(s, { messageId, text, isImage })) {
      log("[DEDUP] ignored", phone);
      res.send("OK (dedup)");
      return;
    }

    await handleFlow(phone, text, isImage, body);
    res.send("OK");
  } catch (e) {
    logErr("[WEBHOOK ERROR]", e.message);
    res.status(200).send("OK");
  }
});

// --------------------------------------------------
// START
// --------------------------------------------------
app.listen(PORT, () => {
  log(`Server running on port ${PORT}`);
  log(`[ENV] instanceId=${ZAPI_INSTANCE_ID ? "OK" : "MISSING"} token=${ZAPI_TOKEN ? "OK" : "MISSING"} clientToken=${ZAPI_CLIENT_TOKEN ? "OK" : "MISSING"}`);
});
