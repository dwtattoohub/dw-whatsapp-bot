/**
 * ============================
 *  DW WhatsApp Bot (FULL)
 * ============================
 * Z-API + Render + Node/Express
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

const ZAPI_INSTANCE_ID =
  (process.env.ZAPI_INSTANCE_ID || process.env.ZAPI_INSTANCE_TOKEN || "").trim();

const ZAPI_TOKEN = (process.env.ZAPI_TOKEN || "").trim();
const ZAPI_CLIENT_TOKEN = getEnv("ZAPI_CLIENT_TOKEN").trim();

const OWNER_PHONE = getEnv("OWNER_PHONE", { optional: true, fallback: "" }).trim();
const PIX_KEY = getEnv("PIX_KEY", { optional: true, fallback: "dwtattooshop@gmail.com" }).trim();
const BOT_NAME = getEnv("BOT_NAME", { optional: true, fallback: "Dhy Tattoo" }).trim();

const PORT = Number(process.env.PORT || 10000);

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
const state = Object.create(null);
const TTL_MS = 1000 * 60 * 60 * 24; // 24h

function getSession(phone) {
  if (!state[phone]) {
    state[phone] = {
      step: "INIT",
      data: {},
      asked: {},
      lastBotHash: null,
      lastSeenAt: nowMs(),
      seenMessageIds: new Set(),
      // ✅ Agora é Map(hash -> lastTimestamp), não trava pra sempre
      seenUserHashes: new Map(),
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
// DEDUPE (anti-repetição) — corrigido
// --------------------------------------------------
function hashText(s) {
  return crypto.createHash("sha1").update(String(s || "")).digest("hex");
}

// ✅ só ignora repetido por texto se repetir em X segundos
const DEDUPE_WINDOW_MS = 20_000;

function shouldIgnoreUserMessage(session, { messageId, text, isImage }) {
  // dedupe por messageId (quando existe)
  if (messageId) {
    if (session.seenMessageIds.has(messageId)) return true;
    session.seenMessageIds.add(messageId);
    if (session.seenMessageIds.size > 400) {
      session.seenMessageIds = new Set(Array.from(session.seenMessageIds).slice(-200));
    }
  }

  // dedupe por hash com janela de tempo (quando não existe messageId confiável)
  const base = `${isImage ? "[IMG]" : "[TXT]"}:${text || ""}`.trim();
  const h = hashText(base);

  const now = nowMs();
  const last = session.seenUserHashes.get(h);

  // se repetiu dentro da janela, ignora
  if (last && now - last < DEDUPE_WINDOW_MS) return true;

  // atualiza timestamp
  session.seenUserHashes.set(h, now);

  // limpeza básica do Map (remove entradas antigas)
  if (session.seenUserHashes.size > 500) {
    for (const [k, ts] of session.seenUserHashes.entries()) {
      if (now - ts > 5 * 60_000) session.seenUserHashes.delete(k); // 5 min
    }
    // se ainda grande, poda
    if (session.seenUserHashes.size > 500) {
      const entries = Array.from(session.seenUserHashes.entries()).sort((a, b) => a[1] - b[1]);
      for (let i = 0; i < 200; i++) session.seenUserHashes.delete(entries[i]?.[0]);
    }
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
// Z-API SEND
// --------------------------------------------------
function zapiHeaders() {
  return {
    "client-token": ZAPI_CLIENT_TOKEN,
    "Client-Token": ZAPI_CLIENT_TOKEN,
    "CLIENT-TOKEN": ZAPI_CLIENT_TOKEN,
    "Content-Type": "application/json",
  };
}

function buildZapiUrls(path) {
  const base = "https://api.z-api.io";
  const urls = [];
  if (ZAPI_INSTANCE_ID && ZAPI_TOKEN) {
    urls.push(`${base}/instances/${encodeURIComponent(ZAPI_INSTANCE_ID)}/token/${encodeURIComponent(ZAPI_TOKEN)}${path}`);
  }
  if (ZAPI_INSTANCE_ID) {
    urls.push(`${base}/instances/${encodeURIComponent(ZAPI_INSTANCE_ID)}${path}`);
  }
  return urls;
}

async function zapiPostWithFallback(path, payload) {
  const headers = zapiHeaders();
  const urls = buildZapiUrls(path);

  if (!urls.length) throw new Error("Missing ZAPI_INSTANCE_ID. Check Render envs.");

  let lastErr = null;
  for (const url of urls) {
    try {
      return await axios.post(url, payload, { headers, timeout: 30000 });
    } catch (e) {
      lastErr = e?.response?.data || e.message;
      logErr("[ZAPI] fail:", url, lastErr);
      await sleep(250);
    }
  }
  throw new Error(typeof lastErr === "string" ? lastErr : JSON.stringify(lastErr));
}

async function sendText(phone, message) {
  if (!phone) return false;

  const s = getSession(phone);
  if (!shouldSendBotMessage(s, message)) return true;

  try {
    await zapiPostWithFallback("/send-text", { phone, message });
    log("[ZAPI OUT] sent to", phone);
    return true;
  } catch (e) {
    logErr("[ZAPI OUT] SEND FAIL", e?.message || e);
    return false;
  }
}

async function notifyOwner(text) {
  if (!OWNER_PHONE) return false;
  return sendText(OWNER_PHONE, text);
}

// --------------------------------------------------
// PARSERS
// --------------------------------------------------
function extractRegion(text) {
  const t = safeLower(text);
  const regions = [
    "antebraço","antebraco","braco","braço","costas","perna","coxa","panturrilha","peito","ombro",
    "pescoço","pescoco","mão","mao","pé","pe","costela","barriga","abdômen","abdomen",
  ];
  for (const r of regions) if (t.includes(r)) return r;
  return null;
}

function extractSizeHint(text) {
  const t = safeLower(text);
  const m = t.match(/(\d{1,3})\s*(cm|cent[ií]metros?)/i);
  if (m) return `${m[1]}cm`;
  if (t.includes("metade do antebraço")) return "metade do antebraço";
  if (t.includes("antebraço todo") || t.includes("antebraco todo")) return "antebraço todo";
  if (t.includes("pequeno")) return "pequeno";
  if (t.includes("médio") || t.includes("medio")) return "médio";
  if (t.includes("grande")) return "grande";
  return null;
}

function extractFidelity(text) {
  const t = safeLower(text);
  const wantsFiel = t.includes("fiel") || t.includes("igual") || t.includes("idêntic") || t.includes("identic");
  const wantsChange = t.includes("mudar") || t.includes("alterar") || t.includes("adicionar") || t.includes("remover") || t.includes("adaptar") || t.includes("encaixe") || t.includes("ajustar");
  if (wantsFiel && !wantsChange) return "FIEL";
  if (wantsChange && !wantsFiel) return "AJUSTAR";
  if (wantsFiel && wantsChange) return "MISTO";
  return null;
}

function looksLikePixProof(text) {
  const t = safeLower(text);
  return t.includes("comprovante") || t.includes("pix feito") || t.includes("paguei") || t.includes("pago") || t.includes("transferi") || t.includes("recebedor") || t.includes("transação") || t.includes("transacao");
}

function extractTimePreference(text) {
  const t = safeLower(text);
  const commercial = t.includes("comercial") || t.includes("horário comercial") || t.includes("horario comercial") || t.includes("manhã") || t.includes("manha") || t.includes("tarde");
  const after = t.includes("pós") || t.includes("pos") || t.includes("pós-expediente") || t.includes("pos expediente") || t.includes("noite") || t.includes("depois do trabalho");
  if (commercial && !after) return "COMERCIAL";
  if (after && !commercial) return "POS";
  if (commercial && after) return "TANTO_FAZ";
  return null;
}

function clientAsksMonthly(text) {
  const t = safeLower(text);
  return t.includes("mensal") || t.includes("por mês") || t.includes("por mes") || t.includes("em sessões") || t.includes("em sessoes") || t.includes("dividir em") || t.includes("parcelar em sessões") || t.includes("parcelar em sessoes");
}

// --------------------------------------------------
// HORAS + PREÇO
// --------------------------------------------------
function regionRate(region) {
  const r = safeLower(region || "");
  const special = r.includes("mão") || r.includes("mao") || r.includes("pé") || r.includes("pe") || r.includes("pescoço") || r.includes("pescoco") || r.includes("costela");
  if (special) return { firstHour: 150, otherHours: 120 };
  return { firstHour: 150, otherHours: 100 };
}

function estimateHours({ region, sizeHint, fidelity, hasImage }) {
  let h = 3.0;
  const r = safeLower(region || "");
  const s = safeLower(sizeHint || "");

  if (r.includes("costas") || r.includes("peito")) h += 2.0;
  if (r.includes("antebraço") || r.includes("antebraco")) h += 1.0;
  if (r.includes("perna") || r.includes("coxa") || r.includes("panturrilha")) h += 1.5;
  if (r.includes("mão") || r.includes("mao") || r.includes("pé") || r.includes("pe") || r.includes("pescoço") || r.includes("pescoco") || r.includes("costela")) h += 0.5;

  if (s.includes("10cm")) h -= 0.5;
  if (s.includes("15cm")) h += 0.5;
  if (s.includes("20cm")) h += 1.2;
  if (s.includes("metade do antebraço")) h += 1.5;
  if (s.includes("antebraço todo") || s.includes("antebraco todo")) h += 2.5;
  if (s.includes("pequeno")) h -= 0.3;
  if (s.includes("médio") || s.includes("medio")) h += 0.4;
  if (s.includes("grande")) h += 1.5;

  if (fidelity === "FIEL") h += 0.8;
  if (fidelity === "AJUSTAR") h += 1.0;
  if (fidelity === "MISTO") h += 1.2;

  if (hasImage) h += 0.3;

  if (h < 2.0) h = 2.0;
  if (h > 12.0) h = 12.0;

  return Math.round(h * 2) / 2;
}

function calcOneSessionValue(hours, region) {
  const { firstHour, otherHours } = regionRate(region);
  if (hours <= 1) return firstHour;
  return firstHour + (hours - 1) * otherHours;
}

function calcProjectPrice(hours, region) {
  if (hours <= 7) {
    return { sessions: 1, total: Math.round(calcOneSessionValue(hours, region)) };
  }
  const s1 = 7;
  const s2 = Math.max(1, hours - 7);
  const v1 = calcOneSessionValue(s1, region);
  const v2 = calcOneSessionValue(s2, region);
  return { sessions: 2, total: Math.round(v1 + v2) };
}

function applyMonthlySessionSurcharge(baseTotal, sessionsWanted) {
  if (!sessionsWanted || sessionsWanted <= 1) return baseTotal;
  return Math.round(baseTotal + (sessionsWanted - 1) * 150);
}

// --------------------------------------------------
// MENSAGENS
// --------------------------------------------------
function msgIntro() {
  return (
    `Olá! Tudo certo?\n` +
    `Obrigado por me chamar e confiar no meu trabalho.\n\n` +
    `Pra eu te passar um orçamento justo, me manda:\n` +
    `1) A referência em *imagem*\n` +
    `2) A *região do corpo* (ex: antebraço, perna, costas, mão)\n` +
    `3) Se você quer *fiel à referência* ou se quer *alterar algo* (adicionar/remover/ajustar)\n\n` +
    `Com isso eu te devolvo uma proposta bem certinha.`
  );
}

function msgAskRegionAndFidelity() {
  return (
    `Perfeito, recebi a referência.\n\n` +
    `Só me confirma:\n` +
    `• Qual região do corpo?\n` +
    `• Você quer *bem fiel à referência* ou quer *alterar algo* (adicionar/remover/ajustar)?`
  );
}

function msgAskSize() {
  return (
    `Show.\n\n` +
    `Me diz o *tamanho aproximado* (em cm se souber).\n` +
    `Se não souber, sem problema — eu calculo pela região e pela referência.`
  );
}

function msgCoveragePolicy() {
  return (
    `Sobre *cobertura*: eu preciso analisar por foto.\n\n` +
    `Mas já te adianto que eu *raramente pego cobertura*, porque meu estilo (whip shading/realismo delicado) depende de controle de contraste e leitura limpa na pele.\n\n` +
    `Se você quiser, me manda uma foto bem nítida da tattoo atual que eu te digo com sinceridade se dá pra fazer com qualidade.`
  );
}

function msgAnalysis({ region, fidelity, sizeHint }) {
  return (
    `Análise do seu projeto:\n` +
    `• Região: *${region || "a confirmar"}*\n` +
    `• Direção: *${fidelity || "a confirmar"}*\n` +
    `• Tamanho: *${sizeHint || "estimado pela referência"}*\n\n` +
    `O que pesa no valor:\n` +
    `• Sombras e transições suaves (whip shading) com controle fino\n` +
    `• Contraste e profundidade pra tattoo “ler bem” na pele\n` +
    `• Encaixe harmônico na região (durabilidade e acabamento)`
  );
}

function msgPaymentAndRules() {
  return (
    `Formas de pagamento:\n` +
    `• Pix\n` +
    `• Débito\n` +
    `• Crédito em até 12x (com taxa da maquininha conforme o número de parcelas)\n\n` +
    `Sinal para reservar horário: *R$ 50*\n` +
    `Chave Pix: ${PIX_KEY}\n\n` +
    `Remarcação: pode ajustar a data com *48h de aviso prévio*.`
  );
}

function msgMonthlyOption(baseTotal) {
  const ex2 = applyMonthlySessionSurcharge(baseTotal, 2);
  const ex3 = applyMonthlySessionSurcharge(baseTotal, 3);

  return (
    `Se ficar pesado pagar tudo de uma vez, dá pra organizar em *sessões mensais*.\n` +
    `Nesse formato existe um ajuste no total: *cada sessão extra adiciona +R$150*.\n\n` +
    `Exemplo:\n` +
    `• Em 2 sessões: R$ ${ex2}\n` +
    `• Em 3 sessões: R$ ${ex3}`
  );
}

function msgProposal({ region, fidelity, sizeHint, hours, sessions, total }) {
  const sessionLine = sessions === 1
    ? `✅ Esse projeto fica em *1 sessão*.`
    : `✅ Pra manter padrão de acabamento, esse projeto fica melhor em *2 sessões*.`;

  return (
    `${msgAnalysis({ region, fidelity, sizeHint })}\n\n` +
    `${sessionLine}\n` +
    `Estimativa: *~${hours}h*\n` +
    `Investimento: *R$ ${total}*\n\n` +
    `${msgPaymentAndRules()}\n\n` +
    `Assim que fizer o Pix do sinal, me manda o *comprovante* por aqui.`
  );
}

function msgAskSchedulePreference() {
  return (
    `Pra eu te passar as opções de agenda:\n` +
    `• Você prefere *horário comercial* ou *pós-expediente*?\n` +
    `• Tem alguma *data/semana em mente*?\n\n` +
    `Se preferir, eu te passo a *data mais próxima disponível* e você só confirma.`
  );
}

function msgAfterProof() {
  return (
    `Perfeito — comprovante recebido ✅\n\n` +
    `Agora me diz: você prefere *horário comercial* ou *pós-expediente*? E qual data fica melhor pra você?`
  );
}

// --------------------------------------------------
// FLOW
// --------------------------------------------------
async function handleFlow(phone, text, isImage) {
  const s = getSession(phone);
  const t = safeLower(text);

  if (t === "reset" || t === "/reset") {
    resetSession(phone);
    await sendText(phone, "Conversa resetada ✅ Pode me mandar a referência (imagem) e a região do corpo.");
    return;
  }

  if (t.includes("cobertura") || t.includes("cobrir")) {
    await sendText(phone, msgCoveragePolicy());
    return;
  }

  if (s.step === "INIT") {
    s.step = "WAIT_REF";
    await sendText(phone, msgIntro());
    return;
  }

  if (looksLikePixProof(text) && (s.step === "WAIT_PROOF" || s.step === "SENT_PROPOSAL" || s.step === "WAIT_SCHEDULE_PREF")) {
    await notifyOwner(`✅ POSSÍVEL PIX/COMPROVANTE (texto)\nCliente: ${phone}\nMensagem: ${text || "-"}`);
    s.step = "WAIT_SCHEDULE_PREF";
    await sendText(phone, msgAfterProof());
    return;
  }

  if (s.step === "WAIT_REF") {
    if (isImage) {
      s.data.hasImage = true;
      s.step = "WAIT_REGION_FIDELITY";
      await sendText(phone, msgAskRegionAndFidelity());
      return;
    }

    const region = extractRegion(text);
    const fidelity = extractFidelity(text);
    if (region) s.data.region = region;
    if (fidelity) s.data.fidelity = fidelity;

    await sendText(phone, `Show.\n\nAgora me manda a *referência em imagem* pra eu analisar certinho e fechar o orçamento.`);
    return;
  }

  if (s.step === "WAIT_REGION_FIDELITY") {
    if (isImage) {
      s.data.hasImage = true;
      await sendText(phone, "Perfeito. Me confirma a *região do corpo* e se quer *fiel* ou *alterar* algo.");
      return;
    }

    const region = extractRegion(text);
    const fidelity = extractFidelity(text);
    if (region) s.data.region = region;
    if (fidelity) s.data.fidelity = fidelity;

    if (!s.data.region || !s.data.fidelity) {
      await sendText(phone, msgAskRegionAndFidelity());
      return;
    }

    s.step = "WAIT_SIZE";
    await sendText(phone, msgAskSize());
    return;
  }

  if (s.step === "WAIT_SIZE") {
    if (isImage) {
      s.data.hasImage = true;
      await sendText(phone, "Perfeito. Me diz só o *tamanho aproximado* (cm se souber).");
      return;
    }

    s.data.sizeHint = extractSizeHint(text) || null;

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
    await sendText(phone, msgProposal({ region: s.data.region, fidelity: s.data.fidelity, sizeHint: s.data.sizeHint, hours, sessions, total }));
    s.step = "WAIT_PROOF";
    return;
  }

  if (s.step === "SENT_PROPOSAL" || s.step === "WAIT_PROOF") {
    if (isImage) {
      await notifyOwner(`✅ POSSÍVEL COMPROVANTE/PIX (imagem)\nCliente: ${phone}\nSugestão: conferir e marcar agenda manualmente.`);
      s.step = "WAIT_SCHEDULE_PREF";
      await sendText(phone, msgAfterProof());
      return;
    }

    if (clientAsksMonthly(text)) {
      const baseTotal = s.data?.total || 0;
      if (baseTotal > 0) await sendText(phone, msgMonthlyOption(baseTotal));
      return;
    }

    if (t.includes("horário") || t.includes("horario") || t.includes("agenda") || t.includes("data") || t.includes("dia")) {
      s.step = "WAIT_SCHEDULE_PREF";
      await sendText(phone, msgAskSchedulePreference());
      return;
    }

    if (!s.asked.proofOnce) {
      s.asked.proofOnce = true;
      await sendText(phone, `Perfeito.\n\nQuando fizer o Pix do *sinal de R$ 50*, me manda o *comprovante* aqui pra eu reservar seu horário.`);
    }
    return;
  }

  if (s.step === "WAIT_SCHEDULE_PREF") {
    if (isImage) {
      await sendText(phone, "Perfeito. Me diz só se prefere *horário comercial* ou *pós-expediente*, e uma *data/semana* em mente.");
      return;
    }

    const pref = extractTimePreference(text);
    if (pref) s.data.timePref = pref;

    await notifyOwner(
      `📅 PEDIDO DE AGENDA\nCliente: ${phone}\nPreferência: ${s.data.timePref || "não definida"}\nMensagem: ${text}\n\nDados:\nRegião: ${s.data.region || "-"}\nTamanho: ${s.data.sizeHint || "estimado"}\nDireção: ${s.data.fidelity || "-"}\nHoras: ${s.data.hours || "-"}\nTotal: R$ ${s.data.total || "-"}\nSinal: R$50 | Remarcação 48h`
    );

    s.step = "DONE";
    await sendText(phone, `Fechado ✅\n\nVou conferir minha agenda e já te mando as opções mais próximas.\nSe preferir, me diga 2 ou 3 datas que ficam boas pra você que eu encaixo da melhor forma.`);
    return;
  }

  await sendText(phone, "Show. Se você quiser, me manda mais detalhes (região/tamanho/referência) que eu refino o orçamento.");
}

// --------------------------------------------------
// WEBHOOK NORMALIZATION
// --------------------------------------------------
function normalizeWebhook(body) {
  const phone = body?.phone || body?.from || body?.sender || null;
  const text = body?.text?.message ?? body?.message?.text ?? body?.message ?? body?.text ?? "";
  const isImage = !!(body?.image || body?.imageMessage || body?.message?.image || body?.message?.imageMessage);
  const messageId = body?.messageId || body?.id || body?.message?.id || body?.data?.id || null;
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

app.get("/reset", (req, res) => {
  for (const k of Object.keys(state)) delete state[k];
  res.send("OK – reset geral.");
});

app.get("/reset/:phone", (req, res) => {
  resetSession(req.params.phone);
  res.send(`OK – reset ${req.params.phone}`);
});

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

    // ✅ reset precisa passar antes do dedupe
    const lower = safeLower(text);
    if (lower === "reset" || lower === "/reset") {
      resetSession(phone);
      await sendText(phone, "Conversa resetada ✅ Pode me mandar a referência (imagem) e a região do corpo.");
      res.send("OK (reset)");
      return;
    }

    const s = getSession(phone);
    if (shouldIgnoreUserMessage(s, { messageId, text, isImage })) {
      log("[DEDUP] ignored", phone);
      res.send("OK (dedup)");
      return;
    }

    await handleFlow(phone, text, isImage);
    res.send("OK");
  } catch (e) {
    logErr("[WEBHOOK ERROR]", e?.message || e);
    res.status(200).send("OK");
  }
});

// --------------------------------------------------
// START
// --------------------------------------------------
app.listen(PORT, () => {
  log(`Server running on port ${PORT}`);
  log(
    `[ENV] instanceId=${ZAPI_INSTANCE_ID ? "OK" : "MISSING"} token=${ZAPI_TOKEN ? "OK" : "MISSING"} clientToken=${ZAPI_CLIENT_TOKEN ? "OK" : "MISSING"}`
  );
});
