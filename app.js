import express from "express";
import OpenAI from "openai";
import twilio from "twilio";

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Memória simples por número (em RAM)
const sessions = {};

// ---------- Helpers ----------
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

// EX-TWILIO FUNÇÕES AQUI EMBAIXO (mantidas para futuro, mas não usadas na Z-API)
function twilioBasicAuthHeader() {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) return null;
  const b64 = Buffer.from(`${sid}:${token}`).toString("base64");
  return `Basic ${b64}`;
}

async function downloadTwilioMediaAsDataUrl(mediaUrl) {
  const auth = twilioBasicAuthHeader();
  if (!auth) throw new Error("Missing TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN");

  const resp = await fetch(mediaUrl, {
    headers: { Authorization: auth },
  });

  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw new Error(`Failed to fetch Twilio media: ${resp.status} ${t}`);
  }

  const contentType = resp.headers.get("content-type") || "image/jpeg";
  const arrayBuffer = await resp.arrayBuffer();
  const base64 = Buffer.from(arrayBuffer).toString("base64");
  return { dataUrl: `data:${contentType};base64,${base64}`, mime: contentType };
}

function extractSizeLocation(text) {
  const t = (text || "").trim();
  if (!t) return null;
  const hasNumber = /\d/.test(t);
  if (!hasNumber) return null;
  return t;
}

// ------------------------------------------------------------------------
//  ⚡ NOVO ENDPOINT Z-API /zapi
// ------------------------------------------------------------------------
app.post("/zapi", async (req, res) => {
  try {
    console.log("[ZAPI IN] body:", req.body);

    const { phone, message, image } = req.body;

    if (!phone) {
      console.log("[ZAPI ERROR] missing phone");
      return res.status(400).json({ error: "missing phone" });
    }

    const session = getSession(phone);

    // --------------------------------------------------------------
    // Lógica igual ao fluxo antigo /whatsapp
    // --------------------------------------------------------------
    let reply = "";

    if (session.stage === "inicio") {
      reply =
        "Oi! Eu sou o Dhyeikow, tatuador. Obrigado por me procurar e confiar no meu trabalho.\n\n" +
        "Me manda uma referência em *imagem* do que você quer tatuar (pode ser foto/print).";

      session.stage = "aguardando_referencia";

      await sendZapiMessage(phone, reply);
      return res.json({ ok: true });
    }

    if (image && !session.gotReference) {
      session.imageDataUrl = image;
      session.imageMime = "image/jpeg";
      session.gotReference = true;

      reply =
        "Perfeito, referência recebida! Agora me diz *tamanho (cm)* e *local do corpo*.\nEx: 25cm no ombro";

      session.stage = "aguardando_tamanho_local";
      await sendZapiMessage(phone, reply);
      return res.json({ ok: true });
    }

    if (session.stage === "aguardando_referencia") {
      reply = "Pra eu avaliar certinho, me envia a *referência em imagem* 😊";
      await sendZapiMessage(phone, reply);
      return res.json({ ok: true });
    }

    if (session.stage === "aguardando_tamanho_local") {
      const size = extractSizeLocation(message);

      if (!size) {
        reply = "Manda só assim:\nEx: 25cm no ombro\nou 15cm antebraço interno.";
        await sendZapiMessage(phone, reply);
        return res.json({ ok: true });
      }

      session.sizeLocationText = size;
      session.stage = "orcamento";
    }

    if (session.stage === "orcamento") {
      if (!session.gotReference || !session.imageDataUrl) {
        session.stage = "aguardando_referencia";
        reply = "Me envia a referência em *imagem* de novo, por favor.";
        await sendZapiMessage(phone, reply);
        return res.json({ ok: true });
      }

      const systemPrompt =
        process.env.SYSTEM_PROMPT ||
        "Você é Dhyeikow, tatuador. Seja humano, direto e profissional.";

      const userMsg = `Tamanho/local: ${session.sizeLocationText}. Analise a imagem e gere o orçamento.`;

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
        "Me manda o tamanho/local certinho de novo";

      session.stage = "pos_orcamento";

      await sendZapiMessage(phone, reply);
      return res.json({ ok: true });
    }

    if (session.stage === "pos_orcamento") {
      if (image) {
        session.stage = "aguardando_tamanho_local";
        await sendZapiMessage(
          phone,
          "Nova referência recebida! Me manda o tamanho/local."
        );
        return res.json({ ok: true });
      }

      if (message.toLowerCase().includes("cm")) {
        session.sizeLocationText = message;
        session.stage = "orcamento";
        await sendZapiMessage(phone, "Beleza! Vou recalcular certinho.");
        return res.json({ ok: true });
      }

      await sendZapiMessage(
        phone,
        "Perfeito. Quer confirmar:\n1) Tamanho/local\n2) Horário\nAí já te passo datas e sinal."
      );
      return res.json({ ok: true });
    }

    await sendZapiMessage(
      phone,
      "Me manda a referência em imagem e o tamanho/local pra eu te atender certinho."
    );
    return res.json({ ok: true });
  } catch (err) {
    console.error("[ZAPI ERROR]:", err);
    return res.status(500).json({ error: "internal error" });
  }
});

// ------------------------------------------------------------------------
// ENVIO PARA Z-API + LOG COMPLETO
// ------------------------------------------------------------------------
async function sendZapiMessage(phone, message) {
  const instance = process.env.ZAPI_INSTANCE_ID;
  const token = process.env.ZAPI_TOKEN;

  const url = `https://api.z-api.io/instances/${instance}/token/${token}/send-message`;

  const payload = {
    phone: phone.replace(/\D/g, ""),
    message,
  };

  console.log("[ZAPI OUT] sending:", payload);

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const body = await resp.text().catch(() => "");
  console.log("[ZAPI SEND] status:", resp.status, "body:", body);

  if (!resp.ok) {
    throw new Error(`[ZAPI SEND FAILED] ${resp.status} ${body}`);
  }

  return true;
}

// ------------------------------------------------------
//  Porta Render
// ------------------------------------------------------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("Servidor rodando na porta", PORT));
