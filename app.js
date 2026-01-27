// ============================================================
// DW WhatsApp Bot — Versão A (AGENTE COMPLETO GPT-4o)
// ============================================================
// O agente GPT controla 100% das respostas via JSON.
// O backend APENAS executa: enviar texto, enviar botões,
// atualizar sessão, gerar horários e repassar tudo.
// ============================================================

import express from "express";
import crypto from "crypto";
import OpenAI from "openai";
import fsPromise from "fs/promises";
import path from "path";
import fs from "fs";

// ------- RESET AUTOMÁTICO DO STORE NO BOOT -------
try {
  fs.writeFileSync("./dw_store.json", JSON.stringify({ sessions: {} }, null, 2));
  console.log("🔥 Store resetado automaticamente no boot");
} catch (e) {
  console.log("⚠ Não foi possível resetar o store:", e?.message);
}

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
  OPENAI_MODEL: "gpt-4o",

  // Persistência
  STORE_PATH: "./dw_store.json",
};

// -------------------- Store persistente --------------------
const STORE = {
  sessions: {},
};

async function loadStore() {
  try {
    const raw = await fs.readFile(ENV.STORE_PATH, "utf8");
    const data = JSON.parse(raw);
    STORE.sessions = data.sessions || {};
  } catch {
    console.log("Primeira execução, sem store.");
  }
}

function saveStore() {
  fs.writeFile(
    ENV.STORE_PATH,
    JSON.stringify({ sessions: STORE.sessions }, null, 2),
    "utf8"
  ).catch(() => {});
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
async function zapiFetch(path, payload) {
  const url = `https://api.z-api.io/instances/${ENV.ZAPI_INSTANCE_ID}/token/${ENV.ZAPI_INSTANCE_TOKEN}${path}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "client-token": ENV.ZAPI_CLIENT_TOKEN,
    },
    body: JSON.stringify(payload),
  });

  const text = await resp.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function sendText(phone, text) {
  await new Promise(r => setTimeout(r, 1000 + Math.random()*600));
  return zapiFetch("/send-text", { phone, message: text });
}

async function sendButtons(phone, text, buttons) {
  await new Promise(r => setTimeout(r, 1000 + Math.random()*600));

  try {
    await zapiFetch("/send-button-list", {
      phone,
      message: text,
      buttonList: {
        title: "menu",
        buttons: buttons.map(b => ({ id: b.id, label: b.title })),
      },
    });
    return;
  } catch {}

  try {
    await zapiFetch("/send-buttons", {
      phone,
      message: text,
      buttons: buttons.map(b => ({ id: b.id, title: b.title })),
    });
    return;
  } catch {}

  let fallback = text + "\n";
  buttons.forEach((b, i) => {
    fallback += `${i+1}) ${b.title}\n`;
  });
  await sendText(phone, fallback);
}

// -------------------- Horários aleatórios --------------------
function randomPick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function generateScheduleButtons() {
  const today = new Date();
  const weekdayNames = ["Domingo","Segunda","Terça","Quarta","Quinta","Sexta","Sábado"];

  function format(d, hour) {
    return `${weekdayNames[d.getDay()]} — ${d.getDate()}/${d.getMonth()+1} às ${hour}`;
  }

  // comercial pós almoço
  const d1 = new Date(today.getTime() + 86400000 * (1 + Math.floor(Math.random()*3)));
  const h1 = randomPick(["13:00","14:00","15:00","16:00"]);

  // pós comercial
  const d2 = new Date(today.getTime() + 86400000 * (2 + Math.floor(Math.random()*4)));
  const h2 = randomPick(["18:00","19:00","20:00"]);

  // fim de semana
  const d3 = new Date(today.getTime());
  while (d3.getDay() !== 0 && d3.getDay() !== 6) {
    d3.setDate(d3.getDate()+1);
  }
  const h3 = randomPick(["14:00","15:00","16:00","17:00","18:00","19:00"]);

  return [
    { id: "sched_opt1", title: format(d1,h1) },
    { id: "sched_opt2", title: format(d2,h2) },
    { id: "sched_opt3", title: format(d3,h3) },
    { id: "sched_other", title: "Outro horário" },
  ];
}

// -------------------- OpenAI (AGENTE COMPLETO) --------------------
const openai = new OpenAI({ apiKey: ENV.OPENAI_API_KEY });

// -------------------- AGENT SYSTEM (DW TATTOOER) --------------------
const AGENT_SYSTEM = `
###############################################
### AGENT SYSTEM — DW TATTOOER (VERSÃO FINAL)
###############################################

IDENTIDADE
Você é o DW Tattooer atendendo no WhatsApp.
Tom humano, direto, profissional, seguro e simpático — sem ser robótico.
Nunca diga que é IA, bot, agente, modelo, sistema ou automação.
Não assine mensagens.
Você sempre soa como um tatuador real falando com o cliente.

ESPECIALIDADE
Você trabalha exclusivamente com:
• Realismo preto e cinza (black & grey)
• Whip shading
• Criação autoral fiel à referência
• Encaixe real no corpo
• Técnica para envelhecimento perfeito

REGRAS ABSOLUTAS
1. Nunca use palavras repetidas como “perfeito” em excesso.
2. Seja humano e profissional, sem puxar saco.
3. Sempre responda EXCLUSIVAMENTE em JSON com esta estrutura:

{
  "text": "mensagem a enviar",
  "buttons": [
    {"id":"id_do_botao","title":"Título do botão"},
    ...
  ],
  "action": "NONE | HANDOFF_TO_OWNER | RESET_SESSION",
  "set": {
    "stage": "nome_do_stage",
    "handoff": true/false
  }
}

4. Não gere texto fora do JSON.
5. Se faltar qualquer informação do cliente, pergunte de forma direta.

SAUDAÇÃO INICIAL
Quando receber um cliente novo:
"text":
  "Oi, aqui é o DW Tattooer — especialista em realismo preto e cinza e whip shading. Valeu por chegar e confiar no meu trampo. Como posso te ajudar hoje?"

Botões:
1) {"id":"first_new_budget","title":"Orçamento novo"}
2) {"id":"first_other_doubts","title":"Outras dúvidas"}

→ Se o cliente escolher “Outras dúvidas”, retorne:
{
  "action":"HANDOFF_TO_OWNER",
  "text":"Claro, me chama aqui e eu te ajudo direto."
}

FLUXO ORÇAMENTO NOVO
Quando o cliente clicar “Orçamento novo”:
Peça:
• referência em imagem
• local no corpo
• tamanho em cm

Após receber a referência:
Analise a descrição técnica (o backend envia o resumo em session.data.imageSummary)
E retorne botões:
1) {"id":"edit_yes","title":"Quero ajustar algo"}
2) {"id":"edit_no","title":"Pode seguir"}

Se clicar SIM:
Peça a ideia/ref nova.

Se clicar NÃO:
Vá para ORÇAMENTO.

ORÇAMENTO
Antes de mostrar o preço:
Explique em 1–3 linhas:
• criação autoral fiel
• técnica black & grey + whip shading
• encaixe real
• durabilidade

Depois apresente:
• R$ session.data.estTotal
• session.data.estHours horas estimadas

Pergunte:
"Quer que eu te mande opções de datas e horários?"

AGENDAMENTO
Você deve mandar 4 botões (sempre):

1) Horário comercial (pós-almoço)
2) Pós comercial
3) Fim de semana
4) Outro horário

Esses botões virão do backend e você deve apenas enviar no JSON.

SINAL
Quando o cliente escolher um horário:
Explique:
• Sinal R$ 50
• 4 horas para enviar comprovante
• Linguagem humana

COMPROVANTE RECEBIDO
Agradeça e mande cuidados pré tattoo:
• beber água
• evitar álcool no dia anterior
• comer bem
• hidratar pele
• evitar sol forte

PRÓXIMOS CONTATOS
Se o cliente mandar:
“quero outra tattoo”, “quero orçamento”, “quero fazer outra”
→ Reinicie o fluxo de orçamento.

Se mandar:
“tenho dúvida”, “quero falar contigo”, “me chama”
→ HANDOFF_TO_OWNER

NUNCA FAZER
• não mencionar IA
• não sugerir desconto
• não usar frases robóticas
• não usar “perfeito” repetidamente
• não inventar instruções fora do JSON

###############################################
### FIM DO AGENT SYSTEM
###############################################
`;

// -------------------- Função: chamar o agente GPT --------------------
async function agentReply(session, inboundMessage, extraPayload = {}) {
  const messages = [
    { role: "system", content: AGENT_SYSTEM },
    ...session.agentContext,
    {
      role: "user",
      content: JSON.stringify({
        message: inboundMessage,
        session: session.data,
        ...extraPayload
      })
    }
  ];

  const completion = await openai.chat.completions.create({
    model: ENV.OPENAI_MODEL,
    temperature: 0.2,
    messages
  });

  const raw = completion.choices[0].message.content;
  let parsed;

  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    parsed = {
      text: "Tive um probleminha pra entender. Pode repetir pra mim?",
      buttons: [],
      action: "NONE",
      set: { stage: session.stage }
    };
  }

  session.agentContext.push({ role: "assistant", content: raw });
  saveStore();
  return parsed;
}

// -------------------- Interpretar JSON do agente --------------------
async function applyAgentAction(phone, session, agentJson) {
  const { text, buttons = [], action = "NONE", set = {} } = agentJson;

  // Atualizar stage
  if (set.stage) {
    session.stage = set.stage;
    saveStore();
  }

  // HANDOFF para seu número pessoal
  if (action === "HANDOFF_TO_OWNER") {
    await sendText(phone, text || "Beleza, vou te ajudar por aqui.");
    await sendText(
      ENV.OWNER_PHONE,
      `📲 Handoff automático — Cliente pediu falar com você.\n\nNúmero: ${phone}\nStage: ${session.stage}\n\nMensagem: ${text}`
    );
    return;
  }

  // RESET
  if (action === "RESET_SESSION") {
    resetSession(phone);
    await sendText(phone, text || "Vamos começar de novo, me manda sua ideia.");
    return;
  }

  // Normal: enviar texto + botões
  if (text && !antiRepeat(session, text)) {
    if (buttons.length > 0) {
      await sendButtons(phone, text, buttons);
    } else {
      await sendText(phone, text);
    }
  }
}

// -------------------- Normalização de inbound --------------------
function parseInbound(body) {
  const phone =
    body?.phone ||
    body?.from ||
    body?.sender ||
    body?.chatId ||
    body?.data?.from ||
    null;

  const msg =
    body?.message ||
    body?.text ||
    body?.Body ||
    body?.data?.message ||
    "";

  const imageUrl =
    body?.image?.imageUrl ||
    body?.image?.url ||
    body?.data?.imageUrl ||
    null;

  const buttonId =
    body?.buttonId ||
    body?.data?.buttonId ||
    body?.message?.interactive?.button_reply?.id ||
    null;

  const buttonTitle =
    body?.buttonTitle ||
    body?.data?.buttonTitle ||
    body?.message?.interactive?.button_reply?.title ||
    null;

  return {
    phone: phone ? String(phone) : null,
    message: (buttonTitle || msg || "").toString().trim(),
    buttonId: buttonId ? String(buttonId) : null,
    imageUrl,
  };
}

// -------------------- Lógica principal --------------------
async function handleInbound(phone, inbound) {
  const session = getSession(phone);

  // 1) Se for primeira mensagem → Saudação do agente
  if (session.stage === "start") {
    const agentJson = await agentReply(session, "FIRST_CONTACT");
    return applyAgentAction(phone, session, agentJson);
  }

  // 2) Cliente clicou botões padrão
  if (inbound.buttonId) {
    // Fluxo ORÇAMENTO NOVO
    if (inbound.buttonId === "first_new_budget") {
      const agentJson = await agentReply(session, "NEW_BUDGET");
      return applyAgentAction(phone, session, agentJson);
    }

    // Outras dúvidas → handoff
    if (inbound.buttonId === "first_other_doubts") {
      const agentJson = {
        text: "Claro, pode falar comigo aqui direto.",
        buttons: [],
        action: "HANDOFF_TO_OWNER",
        set: { stage: "handoff" }
      };
      return applyAgentAction(phone, session, agentJson);
    }

    // Ajustes na arte
    if (inbound.buttonId === "edit_yes") {
      const agentJson = await agentReply(session, "EDIT_YES");
      return applyAgentAction(phone, session, agentJson);
    }
    if (inbound.buttonId === "edit_no") {
      const agentJson = await agentReply(session, "EDIT_NO");
      return applyAgentAction(phone, session, agentJson);
    }

    // Agendamento — cliente clicou em uma opção
    if (inbound.buttonId.startsWith("sched_opt")) {
      const agentJson = await agentReply(session, "SCHEDULE_SELECTED");
      return applyAgentAction(phone, session, agentJson);
    }

    if (inbound.buttonId === "sched_other") {
      const agentJson = await agentReply(session, "SCHEDULE_OTHER");
      return applyAgentAction(phone, session, agentJson);
    }
  }

  // 3) Se o cliente mandou imagem → mandar para o agente com resumo
  if (inbound.imageUrl) {
    const agentJson = await agentReply(session, "IMAGE_RECEIVED", {
      imageUrl: inbound.imageUrl
    });
    return applyAgentAction(phone, session, agentJson);
  }

  // 4) Mensagem normal → mandar para o agente interpretar
  const agentJson = await agentReply(session, inbound.message);
  return applyAgentAction(phone, session, agentJson);
}

// -------------------- Rotas --------------------
app.get("/", (req, res) => {
  res.status(200).send("DW Bot Online");
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    sessions: Object.keys(STORE.sessions).length,
    model: ENV.OPENAI_MODEL,
  });
});

// Webhook principal Z-API
app.post("/", async (req, res) => {
  res.status(200).json({ ok: true });

  try {
    const inbound = parseInbound(req.body || {});
    if (!inbound.phone) return;

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

  app.listen(ENV.PORT, () => {
    console.log("Servidor na porta:", ENV.PORT);
  });
}

boot().catch((e) => {
  console.error("❌ BOOT ERROR", e?.message || e);
  process.exit(1);
});
