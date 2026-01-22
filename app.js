// app.js
import express from "express";
import axios from "axios";

const app = express();
app.use(express.json({ limit: "25mb" })); // imagens/base64 podem ser grandes

// -------- ENV helpers (não derruba deploy) --------
function pickEnv(keys) {
  for (const k of keys) {
    const v = process.env[k];
    if (v && String(v).trim() !== "") return v.trim();
  }
  return "";
}

const ENV = {
  PORT: pickEnv(["PORT"]) || "10000",

  // Z-API (aceita nomes alternativos pra evitar quebra)
  ZAPI_INSTANCE_ID: pickEnv(["ZAPI_INSTANCE_ID", "ZAPI_ID", "ZAPI_INSTANCE"]),
  ZAPI_INSTANCE_TOKEN: pickEnv(["ZAPI_INSTANCE_TOKEN", "ZAPI_TOKEN", "ZAPI_INST_TOKEN"]),
  ZAPI_CLIENT_TOKEN: pickEnv(["ZAPI_CLIENT_TOKEN", "CLIENT_TOKEN", "ZAPI_ACCOUNT_TOKEN"]),

  // OpenAI
  OPENAI_API_KEY: pickEnv(["OPENAI_API_KEY", "OPENAI_KEY"]),
};

function missingEnvs() {
  const required = [
    "ZAPI_INSTANCE_ID",
    "ZAPI_INSTANCE_TOKEN",
    "ZAPI_CLIENT_TOKEN",
    "OPENAI_API_KEY",
  ];
  return required.filter((k) => !ENV[k]);
}

function logEnvStatus() {
  const miss = missingEnvs();
  if (miss.length) {
    console.warn("[BOOT] Missing ENV(s):", miss.join(", "));
    console.warn("[BOOT] O serviço vai subir, mas algumas funções podem falhar até corrigir ENV.");
  } else {
    console.log("[BOOT] All required ENV(s) present.");
  }
}

// -------- Z-API send helpers --------
function zapiBase() {
  return `https://api.z-api.io/instances/${ENV.ZAPI_INSTANCE_ID}/token/${ENV.ZAPI_INSTANCE_TOKEN}`;
}

async function zapiSendText(phone, message) {
  if (!ENV.ZAPI_INSTANCE_ID || !ENV.ZAPI_INSTANCE_TOKEN || !ENV.ZAPI_CLIENT_TOKEN) {
    throw new Error("ZAPI envs missing. Check /health");
  }

  const url = `${zapiBase()}/send-text`;
  const payload = { phone, message };

  const headers = {
    "Content-Type": "application/json",
    // Z-API costuma aceitar client-token em header
    "client-token": ENV.ZAPI_CLIENT_TOKEN,
  };

  const res = await axios.post(url, payload, { headers });
  return res.data;
}

// -------- Routes --------
app.get("/", (_req, res) => res.status(200).send("OK"));
app.get("/zapi", (_req, res) => res.status(200).send("ZAPI webhook endpoint is up."));
app.get("/health", (_req, res) => {
  const miss = missingEnvs();
  res.status(miss.length ? 500 : 200).json({
    ok: miss.length === 0,
    missing: miss,
    have: {
      ZAPI_INSTANCE_ID: !!ENV.ZAPI_INSTANCE_ID,
      ZAPI_INSTANCE_TOKEN: !!ENV.ZAPI_INSTANCE_TOKEN,
      ZAPI_CLIENT_TOKEN: !!ENV.ZAPI_CLIENT_TOKEN,
      OPENAI_API_KEY: !!ENV.OPENAI_API_KEY,
    },
  });
});

// Webhook Z-API
app.post("/zapi", async (req, res) => {
  try {
    const body = req.body || {};
    // Ajuste conforme seu payload real:
    const phone =
      body.phone ||
      body.from ||
      body?.message?.phone ||
      body?.message?.from ||
      "";

    const text =
      body.message ||
      body.text ||
      body?.message?.text ||
      body?.message?.body ||
      body?.messagePreview ||
      "";

    const isImage =
      Boolean(body.image) ||
      Boolean(body.imageUrl) ||
      Boolean(body?.message?.image) ||
      Boolean(body?.message?.imageUrl) ||
      Boolean(body?.message?.mediaUrl) ||
      Boolean(body?.message?.base64);

    console.log("[ZAPI IN] phone:", phone);
    console.log("[ZAPI IN] text:", text);
    console.log("[ZAPI IN] isImage:", isImage);

    // Responder rápido pro webhook não reenviar
    res.status(200).json({ ok: true });

    // Se não tem phone, não tem como responder
    if (!phone) return;

    // Se faltam envs, manda uma msg avisando que tá em ajuste (sem parecer robô demais)
    const miss = missingEnvs();
    if (miss.length) {
      await zapiSendText(
        phone,
        "Opa! Vi sua mensagem aqui. Só um segundo que estou ajustando meu sistema de atendimento e já te respondo certinho. 🙏"
      ).catch((e) => console.error("[ZAPI SEND FAIL]", e?.response?.data || e.message));
      return;
    }

    // Mensagem mais humana (sem falar de IA, sem falar de horas, sem assinatura)
    if (isImage) {
      await zapiSendText(
        phone,
        "Perfeito, recebi a referência. 🙏\nMe diz só: você quer essa ideia bem fiel ou prefere que eu adapte pro seu corpo (encaixe e composição) mantendo o estilo?"
      ).catch((e) => console.error("[ZAPI SEND FAIL]", e?.response?.data || e.message));
      return;
    }

    // Sem imagem ainda
    await zapiSendText(
      phone,
      "Opa! Tudo certo?\nObrigado por me chamar e confiar no meu trampo.\nPra eu te passar um orçamento justo, me manda a referência em *imagem* e me diz *onde no corpo* você quer fazer (e o tamanho aproximado)."
    ).catch((e) => console.error("[ZAPI SEND FAIL]", e?.response?.data || e.message));
  } catch (err) {
    console.error("[WEBHOOK ERROR]", err?.response?.data || err.message);
    // webhook já respondeu 200 acima, então aqui só loga
  }
});

// -------- Boot --------
logEnvStatus();

app.listen(Number(ENV.PORT), () => {
  console.log(`Server running on port ${ENV.PORT}`);
});
