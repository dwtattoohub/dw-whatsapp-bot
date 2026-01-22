import express from "express";
import OpenAI from "openai";

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Memória simples por número
const sessions = {};

// Helpers
function getSession(from) {
  if (!sessions[from]) {
    sessions[from] = {
      stage: "inicio",
      imageDataUrl: null,
      imageMime: null,
      gotReference: false,
      sizeLocationText: null,
    };
  }
  return sessions[from];
}

function extractSizeLocation(text) {
  const t = (text || "").trim();
  if (!t) return null;
  if (!/\d/.test(t)) return null;
  return t;
}

function parseZapiInbound(body) {
  const phone =
    body?.phone ||
    body?.from ||
    body?.sender ||
    body?.remoteJid ||
    body?.chatId ||
    null;

  const message =
    body?.message ||
    body?.text?.message ||
    body?.text ||
    body?.Body ||
    "";

  const image =
    body?.image ||
    body?.imageUrl ||
    body?.message?.image?.url ||
    body?.media?.url ||
    null;

  return {
    phone: phone ? String(phone) : null,
    message: String(message || "").trim(),
    image: image ? String(image) : null,
    raw: body,
  };
}

// ------------------------------------------------------------------------
//  ENVIO PARA Z-API — VERSÃO CERTA PARA SUA INSTÂNCIA (SEM client-token)
// ------------------------------------------------------------------------
async function sendZapiMessage(phone, message) {
  const instance = process.env.ZAPI_INSTANCE_ID;
  const token = process.env.ZAPI_TOKEN;

  if (!instance || !token) {
    throw new Error("Missing ZAPI_INSTANCE_ID / ZAPI_TOKEN");
  }

  const url = `https://api.z-api.io/instances/${instance}/token/${token}/send-text`;

  const payload = {
    phone: String(phone).replace(/\D/g, ""),
    message: String(message || ""),
  };

  console.log("[ZAPI OUT] sending:", payload);

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const body = await resp.text().catch(() => "");
  console.log("[ZAPI SEND] status:", resp.status, "body:", body);

  if (!resp.ok) throw new Error(`[ZAPI SEND FAILED] ${resp.status} ${body}`);
  if (body && body.includes('"error"'))
    throw new Error(`[ZAPI SEND ERROR BODY] ${body}`);

  return true;
}

// ------------------------------------------------------------------------
//  WEBHOOK /zapi — COLOCAR ESTE LINK NO “Ao receber”
// ------------------------------------------------------------------------
app.post("/zapi", async (req, res) => {
  try {
    console.log("[ZAPI IN] body:", req.body);

    const { phone, message, image } = parseZapiInbound(req.body);
    if (!phone) return res.status(400).json({ error: "missing phone" });

    const session = getSession(phone);
    let reply = "";

    // --- Chegou imagem
    if (image) {
      session.imageDataUrl = image;
      session.imageMime = "image/jpeg";
      session.gotReference = true;
    }

    // --- Fluxo de atendimento
    if (session.stage === "inicio") {
      reply =
        "Oi! Eu sou o Dhyeikow, tatuador. Obrigado por me procurar.\n\n" +
        "Me manda uma referência em *imagem* do que você quer tatuar.";
      session.stage = "aguardando_referencia";
      await sendZapiMessage(phone, reply);
      return res.json({ ok: true });
    }

    if (session.stage === "aguardando_referencia") {
      if (!session.gotReference) {
        await sendZapiMessage(phone, "Me envia a *referência em imagem*, por favor.");
        return res.json({ ok: true });
      }

      reply =
        "Boa! Referência recebida ✅\n\nAgora me diz o *tamanho (cm)* e *local do corpo*.\nEx: 25cm no ombro";
      session.stage = "aguardando_tamanho_local";
      await sendZapiMessage(phone, reply);
      return res.json({ ok: true });
    }

    if (session.stage === "aguardando_tamanho_local") {
      const size = extractSizeLocation(message);
      if (!size) {
        await sendZapiMessage(
          phone,
          'Me manda assim: "25cm no ombro" ou "15cm antebraço interno".'
        );
        return res.json({ ok: true });
      }

      session.sizeLocationText = size;
      session.stage = "orcamento";
    }

    if (session.stage === "orcamento") {
      if (!session.imageDataUrl) {
        session.stage = "aguardando_referencia";
        await sendZapiMessage(phone, "Me envia a *imagem* novamente.");
        return res.json({ ok: true });
      }

      const systemPrompt =
        process.env.SYSTEM_PROMPT ||
        "Você é Dhyeikow, tatuador. Seja direto, humano e profissional.";

      const userMsg = `Tamanho/local: ${session.sizeLocationText}.
Analise a imagem e gere um orçamento fechado.`;

      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: systemPrompt },
          {
            role: "user",
            content: [
              { type: "text", text: userMsg },
              { type: "image_url", image_url: { url: session.imageDataUrl } },
            ],
          },
        ],
      });

      reply =
        completion?.choices?.[0]?.message?.content?.trim() ||
        "Me envia o tamanho e o local certinho novamente.";

      session.stage = "pos_orcamento";
      await sendZapiMessage(phone, reply);
      return res.json({ ok: true });
    }

    if (session.stage === "pos_orcamento") {
      if (image) {
        session.stage = "aguardando_tamanho_local";
        await sendZapiMessage(
          phone,
          "Referência nova recebida! Agora me diz o tamanho e local."
        );
        return res.json({ ok: true });
      }

      const lower = message.toLowerCase();
      if (lower.includes("cm")) {
        session.sizeLocationText = message;
        session.stage = "orcamento";
        await sendZapiMessage(phone, "Perfeito, recalculando…");
        return res.json({ ok: true });
      }

      await sendZapiMessage(
        phone,
        "Perfeito. Quer confirmar tamanho/local e horário comercial/pós-comercial?"
      );
      return res.json({ ok: true });
    }

    // fallback
    await sendZapiMessage(phone, "Me manda a referência e o tamanho/local pra eu ajudar.");
    return res.json({ ok: true });
  } catch (err) {
    console.error("[ZAPI ERROR]:", err);
    return res.status(200).json({ ok: false });
  }
});

// Porta Render
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("Servidor rodando na porta", PORT));
