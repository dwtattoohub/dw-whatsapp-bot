// ============================================================
// DW WhatsApp Bot — Versão A (AGENTE COMPLETO GPT-4o) — FIX REAL
// ============================================================
// FIX PRINCIPAL: força JSON no OpenAI (response_format json_object)
// + retry se vier inválido
// + não contamina agentContext com resposta inválida
// + parseInbound robusto (Z-API varia payload)
// ============================================================

import express from "express";
import crypto from "crypto";
import OpenAI from "openai";
import fs from "fs/promises";
import fssync from "fs";
import path from "path";

const app = express();
app.use(express.json({ limit: "25mb" }));

// -------------------- ENV --------------------
const ENV = {
  PORT: Number(process.env.PORT || 10000),

  // Z-API
  ZAPI_INSTANCE_ID: process.env.ZAPI_INSTANCE_ID,
  ZAPI_INSTANCE_TOKEN: process.env.ZAPI_INSTANCE_TOKEN,
  ZAPI_CLIENT_TOKEN: process.env.ZAPI_CLIENT_TOKEN,

  // OWNER (handoff)
  OWNER_PHONE: "5544991373995",

  // OpenAI
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  OPENAI_MODEL: process.env.OPENAI_MODEL || "gpt-4o",

  // Persistência
  STORE_PATH: process.env.STORE_PATH || "./dw_store.json",
};

function missingEnvs() {
  const miss = [];
  if (!ENV.ZAPI_INSTANCE_ID) miss.push("ZAPI_INSTANCE_ID");
  if (!ENV.ZAPI_INSTANCE_TOKEN) miss.push("ZAPI_INSTANCE_TOKEN");
  if (!ENV.ZAPI_CLIENT_TOKEN) miss.push("ZAPI_CLIENT_TOKEN");
  if (!ENV.OPENAI_API_KEY) miss.push("OPENAI_API_KEY");
  return miss;
}

// -------------------- Store persistente --------------------
const STORE = { sessions: {} };

async function loadStore() {
  try {
    const raw = await fs.readFile(ENV.STORE_PATH, "utf8");
    const data = JSON.parse(raw);
    STORE.sessions = data.sessions || {};
  } catch {
    console.log("Primeira execução, sem store.");
  }
}

let saveTimer = null;
function scheduleSaveStore() {
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    try {
      const dir = path.dirname(ENV.STORE_PATH);
      if (dir && dir !== ".") await fs.mkdir(dir, { recursive: true }).catch(() => {});
      await fs.writeFile(
        ENV.STORE_PATH,
        JSON.stringify({ sessions: STORE.sessions }, null, 2),
        "utf8"
      );
    } catch (e) {
      console.error("[STORE SAVE ERROR]", e?.message || e);
    }
  }, 250);
}
function saveStore() {
  scheduleSaveStore();
}

// ------- RESET AUTOMÁTICO DO STORE NO BOOT (opcional) -------
// Se você NÃO quer resetar, comente esse bloco.
// OBS: Render free não mantém disco entre restarts (sem Persistent Disk).
try {
  fssync.writeFileSync(ENV.STORE_PATH, JSON.stringify({ sessions: {} }, null, 2));
  console.log("🔥 Store resetado automaticamente no boot");
} catch (e) {
  console.log("⚠ Não foi possível resetar o store:", e?.message);
}

// -------------------- Sessões --------------------
function newSession() {
  return {
    stage: "start",
    lastSentHash: "",
    agentContext: [],
    data: {
      name: "",
      reference: "",
      bodyPart: "",
      sizeCm: null,
      imageSummary: "",
      estHours: null,
      estTotal: null,
      lastScheduleOptions: [],
    },
  };
}
function getSession(phone) {
  if (!STORE.sessions[phone]) {
    STORE.sessions[phone] = newSession();
    saveStore();
  }
  return STORE.sessions[phone];
}
function resetSession(phone) {
  STORE.sessions[phone] = newSession();
  saveStore();
}

// -------------------- Util --------------------
function hash(t) {
  return crypto.createHash("md5").update(String(t)).digest("hex");
}
function antiRepeat(session, text) {
  const h = hash(text);
  if (session.lastSentHash === h) return true;
  session.lastSentHash = h;
  saveStore();
  return false;
}

// -------------------- Z-API Helpers --------------------
async function zapiFetch(apiPath, payload) {
  const url = `https://api.z-api.io/instances/${ENV.ZAPI_INSTANCE_ID}/token/${ENV.ZAPI_INSTANCE_TOKEN}${apiPath}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "client-token": ENV.ZAPI_CLIENT_TOKEN,
    },
    body: JSON.stringify(payload || {}),
  });

  const text = await resp.text().catch(() => "");
  if (!resp.ok) {
    throw new Error(`ZAPI ${resp.status}: ${text}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function sendText(phone, text) {
  await new Promise((r) => setTimeout(r, 900 + Math.random() * 600));
  return zapiFetch("/send-text", { phone, message: text });
}

async function sendButtons(phone, text, buttons) {
  await new Promise((r) => setTimeout(r, 900 + Math.random() * 600));

  // 1) button-list
  try {
    await zapiFetch("/send-button-list", {
      phone,
      message: text,
      buttonList: {
        title: "menu",
        buttons: buttons.map((b) => ({ id: b.id, label: b.title })),
      },
    });
    return;
  } catch {}

  // 2) buttons
  try {
    await zapiFetch("/send-buttons", {
      phone,
      message: text,
      buttons: buttons.map((b) => ({ id: b.id, title: b.title })),
    });
    return;
  } catch {}

  // 3) fallback texto
  let fallback = text + "\n";
  buttons.forEach((b, i) => {
    fallback += `${i + 1}) ${b.title}\n`;
  });
  await sendText(phone, fallback);
}

// -------------------- Horários aleatórios (4 botões) --------------------
function randomPick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function generateScheduleButtons() {
  const today = new Date();
  const weekdayNames = ["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"];

  function format(d, hour) {
    const dd = String(d.getDate()).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    return `${weekdayNames[d.getDay()]} — ${dd}/${mm} às ${hour}`;
  }

  // pós almoço (13-16)
  const d1 = new Date(today.getTime() + 86400000 * (1 + Math.floor(Math.random() * 4)));
  const h1 = randomPick(["13:00", "14:00", "15:00", "16:00"]);

  // noite (19-20)
  const d2 = new Date(today.getTime() + 86400000 * (2 + Math.floor(Math.random() * 6)));
  const h2 = randomPick(["19:00", "20:00"]);

  // fim de semana (próximo sab/dom)
  const d3 = new Date(today.getTime());
  for (let i = 0; i < 14; i++) {
    if (d3.getDay() === 0 || d3.getDay() === 6) break;
    d3.setDate(d3.getDate() + 1);
  }
  const h3 = randomPick(["14:00", "15:00", "16:00", "17:00", "18:00", "19:00"]);

  return [
    { id: "sched_opt1", title: format(d1, h1) },
    { id: "sched_opt2", title: format(d2, h2) },
    { id: "sched_opt3", title: format(d3, h3) },
    { id: "sched_other", title: "Outro horário (me diz qual)" },
  ];
}

// -------------------- OpenAI --------------------
const openai = new OpenAI({ apiKey: ENV.OPENAI_API_KEY });

// -------------------- AGENT SYSTEM --------------------
const AGENT_SYSTEM = `
Você é o DW Tattooer atendendo no WhatsApp.
Tom humano, profissional e direto. Nunca diga que é IA/bot/agente. Não assine.
Você trabalha apenas com realismo preto e cinza (black & grey) e whip shading.

REGRA CRÍTICA:
Responda SEMPRE em JSON válido (um único objeto). Sem texto fora do JSON.

Formato obrigatório:
{
  "text": "mensagem a enviar",
  "buttons": [{"id":"x","title":"y"}],
  "action": "NONE | HANDOFF_TO_OWNER | RESET_SESSION",
  "set": {"stage":"nome_stage"}
}

FLUXO:
- FIRST_CONTACT: saudação + botões: Orçamento novo / Outras dúvidas.
- Outras dúvidas => action HANDOFF_TO_OWNER (mensagem humana).
- NEW_BUDGET: pedir referência em imagem + local no corpo + tamanho em cm.
- IMAGE_RECEIVED: confirmar que recebeu e perguntar se quer ajustar algo (edit_yes/edit_no).
- EDIT_YES: pedir a ideia / o que quer adicionar ou remover.
- EDIT_NO: seguir para orçamento (explicar em 1–3 linhas e mostrar valores se existirem em session).
- Quando for hora de agendar, devolver 4 botões de agenda que vêm do backend em extra.scheduleButtons (use exatamente esses botões).

EVITAR:
- repetir "perfeito"
- frases robóticas
`;

// -------------------- Agent call (FORÇA JSON) --------------------
async function callAgentOnce(session, inboundMessage, extraPayload = {}) {
  const messages = [
    { role: "system", content: AGENT_SYSTEM },
    ...session.agentContext,
    {
      role: "user",
      content: JSON.stringify({
        message: inboundMessage,
        session: session.data,
        ...extraPayload,
      }),
    },
  ];

  const completion = await openai.chat.completions.create({
    model: ENV.OPENAI_MODEL,
    temperature: 0.1,
    messages,
    // ✅ ISSO É O QUE RESOLVE O “Tive um probleminha…”
    response_format: { type: "json_object" },
  });

  const raw = completion.choices?.[0]?.message?.content || "{}";
  return raw;
}

async function agentReply(session, inboundMessage, extraPayload = {}) {
  // tentativa 1
  let raw = await callAgentOnce(session, inboundMessage, extraPayload);

  // parse
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }

  // retry 1 (sem histórico, mais “limpo”)
  if (!parsed || typeof parsed !== "object") {
    const cleanSession = { ...session, agentContext: [] };
    raw = await callAgentOnce(cleanSession, inboundMessage, extraPayload);
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
  }

  // fallback seguro (JSON garantido) — SEM “probleminha”
  if (!parsed || typeof parsed !== "object") {
    return {
      text: "Me diz rapidinho o que você quer fazer: orçamento novo ou tirar uma dúvida?",
      buttons: [
        { id: "first_new_budget", title: "Orçamento novo" },
        { id: "first_other_doubts", title: "Outras dúvidas" },
      ],
      action: "NONE",
      set: { stage: session.stage || "start" },
    };
  }

  // normaliza campos
  parsed.text = typeof parsed.text === "string" ? parsed.text : "";
  parsed.buttons = Array.isArray(parsed.buttons) ? parsed.buttons : [];
  parsed.action = typeof parsed.action === "string" ? parsed.action : "NONE";
  parsed.set = typeof parsed.set === "object" && parsed.set ? parsed.set : {};

  // ✅ só salva no contexto se a resposta foi JSON válido
  session.agentContext.push({ role: "assistant", content: JSON.stringify(parsed) });
  saveStore();

  return parsed;
}

// -------------------- Apply Agent JSON --------------------
async function applyAgentAction(phone, session, agentJson) {
  const { text, buttons = [], action = "NONE", set = {} } = agentJson || {};

  if (set?.stage) {
    session.stage = set.stage;
    saveStore();
  }

  if (action === "HANDOFF_TO_OWNER") {
    await sendText(phone, text || "Certo. Me chama no meu Whats pessoal e eu te respondo direto.");
    await sendText(
      ENV.OWNER_PHONE,
      `📲 HANDOFF — Cliente pediu falar com você.\n\nNúmero: ${phone}\nStage: ${session.stage}\n\nÚltima msg ao cliente: ${text || "-"}`
    );
    return;
  }

  if (action === "RESET_SESSION") {
    resetSession(phone);
    await sendText(phone, text || "Beleza. Me manda sua ideia e uma referência em imagem.");
    return;
  }

  if (text && !antiRepeat(session, text)) {
    if (buttons.length > 0) await sendButtons(phone, text, buttons);
    else await sendText(phone, text);
  }
}

// -------------------- Inbound parse (ROBUSTO) --------------------
function getIncomingText(payload) {
  if (!payload) return "";
  if (typeof payload === "string") return payload;
  if (typeof payload === "object") {
    if (payload.buttonId) return payload.buttonTitle || payload.buttonId;
    const t = payload.text || payload?.message?.text || payload.msg || "";
    return typeof t === "string" ? t : JSON.stringify(t);
  }
  return String(payload || "");
}

function parseInbound(body) {
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

  const rawMessage =
    body?.message ||
    body?.text?.message ||
    body?.text ||
    body?.Body ||
    body?.data?.message ||
    body?.data?.text ||
    body?.data?.Body ||
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

  const fromMe = Boolean(body?.fromMe || body?.data?.fromMe);

  const bId =
    body?.buttonId ||
    body?.callback?.buttonId ||
    body?.data?.buttonId ||
    body?.message?.button?.id ||
    body?.message?.interactive?.button_reply?.id ||
    body?.message?.interactive?.list_reply?.id ||
    body?.message?.button_reply?.id ||
    body?.message?.buttonsResponseMessage?.selectedButtonId ||
    body?.message?.listResponseMessage?.singleSelectReply?.selectedRowId ||
    body?.listReply?.id ||
    body?.data?.listReply?.id ||
    null;

  const bTitle =
    body?.buttonTitle ||
    body?.callback?.buttonTitle ||
    body?.data?.buttonTitle ||
    body?.message?.button?.title ||
    body?.message?.interactive?.button_reply?.title ||
    body?.message?.interactive?.list_reply?.title ||
    body?.message?.button_reply?.title ||
    body?.message?.buttonsResponseMessage?.selectedDisplayText ||
    body?.message?.listResponseMessage?.title ||
    body?.listReply?.title ||
    null;

  const messageText = getIncomingText(rawMessage).trim();
  const finalMessage = (bTitle || bId || messageText || "").toString().trim();

  return {
    phone: phone ? String(phone) : null,
    message: finalMessage,
    buttonId: bId ? String(bId) : null,
    imageUrl: imageUrl ? String(imageUrl) : null,
    fromMe,
    raw: body,
  };
}

// -------------------- Main Flow --------------------
async function handleInbound(phone, inbound) {
  const session = getSession(phone);

  // FIRST CONTACT
  if (session.stage === "start") {
    const agentJson = await agentReply(session, "FIRST_CONTACT");
    return applyAgentAction(phone, session, agentJson);
  }

  // BUTTON ROUTES
  if (inbound.buttonId) {
    if (inbound.buttonId === "first_new_budget") {
      const agentJson = await agentReply(session, "NEW_BUDGET");
      return applyAgentAction(phone, session, agentJson);
    }

    if (inbound.buttonId === "first_other_doubts") {
      const agentJson = {
        text: "Certo — me chama no meu Whats pessoal e eu te respondo direto.",
        buttons: [],
        action: "HANDOFF_TO_OWNER",
        set: { stage: "handoff" },
      };
      return applyAgentAction(phone, session, agentJson);
    }

    if (inbound.buttonId === "edit_yes") {
      const agentJson = await agentReply(session, "EDIT_YES");
      return applyAgentAction(phone, session, agentJson);
    }

    if (inbound.buttonId === "edit_no") {
      const agentJson = await agentReply(session, "EDIT_NO");
      return applyAgentAction(phone, session, agentJson);
    }

    if (inbound.buttonId.startsWith("sched_opt")) {
      const agentJson = await agentReply(session, "SCHEDULE_SELECTED");
      return applyAgentAction(phone, session, agentJson);
    }

    if (inbound.buttonId === "sched_other") {
      const agentJson = await agentReply(session, "SCHEDULE_OTHER");
      return applyAgentAction(phone, session, agentJson);
    }
  }

  // IMAGE ROUTE
  if (inbound.imageUrl) {
    // aqui você pode plugar seu analisador de imagem depois
    const agentJson = await agentReply(session, "IMAGE_RECEIVED", { imageUrl: inbound.imageUrl });
    return applyAgentAction(phone, session, agentJson);
  }

  // TEXT ROUTE (inclui quando o cliente digita "quero orçamento")
  const agentJson = await agentReply(session, inbound.message || "MENSAGEM_VAZIA");
  return applyAgentAction(phone, session, agentJson);
}

// -------------------- Routes --------------------
app.get("/", (req, res) => res.status(200).send("DW Bot Online"));

app.get("/health", (req, res) => {
  const miss = missingEnvs();
  res.status(miss.length ? 500 : 200).json({
    ok: miss.length === 0,
    missing: miss,
    sessions: Object.keys(STORE.sessions).length,
    model: ENV.OPENAI_MODEL,
  });
});

// Webhook principal Z-API
app.post("/", async (req, res) => {
  res.status(200).json({ ok: true });

  try {
    const inbound = parseInbound(req.body || {});

    if (!inbound.phone) {
      console.log("[WEBHOOK] sem phone. keys:", Object.keys(req.body || {}));
      return;
    }
    if (inbound.fromMe) return;

    await handleInbound(inbound.phone, inbound);
  } catch (e) {
    console.error("[WEBHOOK ERROR]", e?.message || e);
  }
});

// -------------------- Boot --------------------
async function boot() {
  await loadStore();

  console.log("🚀 DW BOT (AGENTE GPT) ONLINE");
  console.log("Modelo:", ENV.OPENAI_MODEL);
  console.log("Sessions carregadas:", Object.keys(STORE.sessions).length);

  const miss = missingEnvs();
  if (miss.length) console.log("⚠ Missing ENV:", miss.join(", "));

  app.listen(ENV.PORT, () => {
    console.log("Servidor na porta:", ENV.PORT);
  });
}

boot().catch((e) => {
  console.error("❌ BOOT ERROR", e?.message || e);
  process.exit(1);
});
