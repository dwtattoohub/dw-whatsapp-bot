import express from "express";
import OpenAI from "openai";

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
      imageDataUrl: null, // pode ser URL ou base64 (dataUrl)
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

/**
 * Normaliza o payload que chega do Z-API.
 * No teu log, chega algo tipo:
 * { phone: '5544...', message: { text: 'Oi' }, fromMe: false, ... }
 */
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
    body?.message?.text ||
    body?.text?.message ||
    body?.text ||
    body?.Body ||
    "";

  // Imagem (pode variar conforme evento/assinatura)
  const image =
    body?.image ||
    body?.imageUrl ||
    body?.message?.image?.url ||
    body?.media?.url ||
    body?.message?.imageUrl ||
    null;

  const fromMe = Boolean(body?.fromMe);

  return {
    phone: phone ? String(phone) : null,
    message: String(message || "").trim(),
    image: image ? String(image) : null,
    fromMe,
    raw: body,
  };
}

// ------------------------------------------------------------------------
// ENVIO PARA Z-API (ATUALIZADO: sem client-token; usa token na URL)
// ------------------------------------------------------------------------
async function sendZapiMessage(phone, message) {
  const instance = process.env.ZAPI_INSTANCE_ID;
  const token = process.env.ZAPI_TOKEN;

  if (!instance || !token) {
    throw new Error("Missing ZAPI_INSTANCE_ID / ZAPI_TOKEN");
  }

  // ✅ Endpoint do teu plano (o que você mesmo testou):
  // https://api.z-api.io/instances/{instance}/token/{token}/send-text
  const url = `https://api.z-api.io/instances/${instance}/token/${token}/send-text`;

  const payload = {
    phone: String(phone).replace(/\D/g, ""), // só números
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

  if (!resp.ok) {
    throw new Error(`[ZAPI SEND FAILED] ${resp.status} ${body}`);
  }

  // Às vezes vem erro em JSON mesmo com 200 (depende do plano)
  if (body && body.includes('"error"')) {
    throw new Error(`[ZAPI SEND ERROR BODY] ${body}`);
  }

  return true;
}

// ------------------------------------------------------------------------
//  ENDPOINT DO WEBHOOK (APONTAR NO "Ao receber" do Z-API)
//  URL: https://dw-whatsapp-bot.onrender.com/zapi
// ------------------------------------------------------------------------
app.post("/zapi", async (req, res) => {
  try {
    console.log("[ZAPI IN] body:", req.body);

    const { phone, message, image, fromMe } = parseZapiInbound(req.body);

    // Evita loop: se o evento for de mensagem enviada por você/instância
    if (fromMe) return res.status(200).json({ ok: true });

    if (!phone) {
      console.log("[ZAPI ERROR] missing phone");
      return res.status(400).json({ error: "missing phone" });
    }

    const session = getSession(phone);

    // 0) Se chegou imagem, guarda
    if (image) {
      session.imageDataUrl = image; // pode ser URL (ou base64 se vier assim)
      session.imageMime = "image/jpeg";
      session.gotReference = true;
    }

    let reply = "";

    // 1) INÍCIO
    if (session.stage === "inicio") {
      reply =
        "Oi! Eu sou o Dhyeikow, tatuador. Obrigado por me procurar e confiar no meu trabalho.\n\n" +
        "Me manda uma referência em *imagem* do que você quer tatuar (pode ser foto/print).";

      session.stage = "aguardando_referencia";
      await sendZapiMessage(phone, reply);
      return res.json({ ok: true });
    }

    // 2) AGUARDANDO REFERÊNCIA
    if (session.stage === "aguardando_referencia") {
      if (!session.gotReference) {
        reply = "Pra eu avaliar certinho, me envia a *referência em imagem*.";
        await sendZapiMessage(phone, reply);
        return res.json({ ok: true });
      }

      reply =
        "Boa! Referência recebida ✅\n\n" +
        "Agora me diz *tamanho (cm)* e *local do corpo*.\n" +
        'Ex: "25cm no ombro"';

      session.stage = "aguardando_tamanho_local";
      await sendZapiMessage(phone, reply);
      return res.json({ ok: true });
    }

    // 3) AGUARDANDO TAMANHO/LOCAL
    if (session.stage === "aguardando_tamanho_local") {
      const size = extractSizeLocation(message);

      if (!size) {
        reply =
          'Me fala só assim pra eu fechar certinho:\nEx: "25cm no ombro" ou "15cm antebraço interno".';
        await sendZapiMessage(phone, reply);
        return res.json({ ok: true });
      }

      session.sizeLocationText = size;
      session.stage = "orcamento";
    }

    // 4) ORÇAMENTO (OpenAI)
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

      const userMsg = `Tamanho/local: ${session.sizeLocationText}.
Regras: analise a imagem, descreva e então gere um valor fechado de orçamento.`;

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
        "Me manda o tamanho/local certinho de novo pra eu fechar.";

      session.stage = "pos_orcamento";
      await sendZapiMessage(phone, reply);
      return res.json({ ok: true });
    }

    // 5) PÓS-ORÇAMENTO
    if (session.stage === "pos_orcamento") {
      if (image) {
        session.stage = "aguardando_tamanho_local";
        await sendZapiMessage(
          phone,
          "Fechado — referência nova recebida ✅\nAgora me diz *tamanho (cm)* e *local do corpo*."
        );
        return res.json({ ok: true });
      }

      const lower = (message || "").toLowerCase();
      if (lower.includes("cm")) {
        session.sizeLocationText = message;
        session.stage = "orcamento";
        await sendZapiMessage(
          phone,
          "Perfeito — vou recalcular certinho com esse tamanho."
        );
        return res.json({ ok: true });
      }

      await sendZapiMessage(
        phone,
        "Perfeito. Se quiser, me confirma:\n1) tamanho e local certinhos\n2) horário comercial ou pós-comercial\n\nAí eu já te passo as próximas datas e como fica o sinal pra reservar."
      );
      return res.json({ ok: true });
    }

    // fallback
    await sendZapiMessage(
      phone,
      "Me manda a referência em imagem e o tamanho/local pra eu te atender certinho."
    );
    return res.json({ ok: true });
  } catch (err) {
    console.error("[ZAPI ERROR]:", err);
    // responde 200 pra não ficar reenviando
    return res.status(200).json({ ok: false });
  }
});

// ------------------------------------------------------------------------
// ROTA DE SAÚDE (pra testar no navegador)
// ------------------------------------------------------------------------
app.get("/", (req, res) => {
  res.status(200).send("OK - dw-whatsapp-bot rodando");
});

// ------------------------------------------------------
//  Porta Render
// ------------------------------------------------------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("Servidor rodando na porta", PORT));
