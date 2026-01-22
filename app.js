import express from "express";
import OpenAI from "openai";

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json({ limit: "25mb" }));

// -------------------- OpenAI --------------------
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// -------------------- Memória simples (RAM) --------------------
const sessions = {};

function getSession(from) {
  if (!sessions[from]) {
    sessions[from] = {
      stage: "inicio",
      imageDataUrl: null, // SEMPRE vamos tentar guardar como dataUrl base64 aqui
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
 * (varia por evento/plano/config)
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
    body?.text?.message ||
    body?.text ||
    body?.Body ||
    body?.body ||
    "";

  // possíveis lugares de mídia
  const image =
    body?.image ||
    body?.imageUrl ||
    body?.message?.image?.url ||
    body?.message?.image?.base64 ||
    body?.media?.url ||
    body?.media?.base64 ||
    null;

  const imageMime =
    body?.message?.image?.mimetype ||
    body?.message?.image?.mimeType ||
    body?.media?.mimetype ||
    body?.media?.mimeType ||
    null;

  return {
    phone: phone ? String(phone) : null,
    message: String(message || "").trim(),
    image: image ? String(image) : null, // pode ser URL, dataUrl, ou base64 cru
    imageMime: imageMime ? String(imageMime) : null,
    raw: body,
  };
}

// -------------------- Helpers mídia --------------------
function looksLikeDataUrl(s) {
  return typeof s === "string" && s.startsWith("data:image/");
}

function looksLikeHttpUrl(s) {
  return typeof s === "string" && /^https?:\/\//i.test(s);
}

function looksLikeBase64(s) {
  if (typeof s !== "string") return false;
  const trimmed = s.trim();
  if (trimmed.length < 100) return false; // base64 de imagem costuma ser grande
  // não é perfeito, mas funciona
  return /^[A-Za-z0-9+/=\s]+$/.test(trimmed) && !looksLikeHttpUrl(trimmed) && !looksLikeDataUrl(trimmed);
}

function guessMimeFromContentType(ct) {
  if (!ct) return "image/jpeg";
  const lower = String(ct).toLowerCase();
  if (lower.includes("png")) return "image/png";
  if (lower.includes("webp")) return "image/webp";
  if (lower.includes("gif")) return "image/gif";
  return "image/jpeg";
}

async function fetchAsDataUrl(url) {
  // tenta baixar a URL do Z-API (muitas vezes precisa do client-token)
  const clientToken = process.env.ZAPI_CLIENT_TOKEN || process.env.ZAPI_TOKEN || "";
  const headers = clientToken ? { "client-token": clientToken } : {};

  const resp = await fetch(url, { method: "GET", headers });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error(`Failed to download image. status=${resp.status} body=${txt}`);
  }
  const ct = resp.headers.get("content-type");
  const mime = guessMimeFromContentType(ct);
  const arr = await resp.arrayBuffer();
  const b64 = Buffer.from(arr).toString("base64");
  return { dataUrl: `data:${mime};base64,${b64}`, mime };
}

async function normalizeIncomingImageToDataUrl(imageValue, imageMimeHint) {
  if (!imageValue) return { dataUrl: null, mime: null };

  // 1) já é dataUrl
  if (looksLikeDataUrl(imageValue)) {
    const mime = imageValue.slice(5, imageValue.indexOf(";")) || "image/jpeg";
    return { dataUrl: imageValue, mime };
  }

  // 2) é URL -> baixa e converte pra dataUrl
  if (looksLikeHttpUrl(imageValue)) {
    return await fetchAsDataUrl(imageValue);
  }

  // 3) é base64 cru -> vira dataUrl
  if (looksLikeBase64(imageValue)) {
    const mime = imageMimeHint || "image/jpeg";
    const clean = imageValue.replace(/\s/g, "");
    return { dataUrl: `data:${mime};base64,${clean}`, mime };
  }

  // 4) fallback: tenta tratar como URL mesmo sem http (raro)
  return { dataUrl: null, mime: null };
}

// ------------------------------------------------------------------------
// ENVIO PARA Z-API (SEND TEXT) - com client-token obrigatório no header
// ------------------------------------------------------------------------
async function sendZapiMessage(phone, message) {
  const instance = process.env.ZAPI_INSTANCE_ID;
  const token = process.env.ZAPI_TOKEN;
  const clientToken = process.env.ZAPI_CLIENT_TOKEN; // <<< ESTE É O “TOKEN DO SAPO” (segurança da conta)

  if (!instance || !token) {
    throw new Error("Missing ZAPI_INSTANCE_ID / ZAPI_TOKEN");
  }
  if (!clientToken) {
    // sem isso você volta pro erro "your client-token is not configured"
    throw new Error("Missing ZAPI_CLIENT_TOKEN");
  }

  const url = `https://api.z-api.io/instances/${instance}/token/${token}/send-text`;

  const payload = {
    phone: String(phone).replace(/\D/g, ""),
    message: String(message || ""),
  };

  console.log("[ZAPI OUT] sending:", payload);

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "client-token": clientToken, // <<< obrigatório
    },
    body: JSON.stringify(payload),
  });

  const body = await resp.text().catch(() => "");
  console.log("[ZAPI SEND] status:", resp.status, "body:", body);

  if (!resp.ok) {
    throw new Error(`[ZAPI SEND FAILED] ${resp.status} ${body}`);
  }
  if (body && body.includes('"error"')) {
    throw new Error(`[ZAPI SEND ERROR BODY] ${body}`);
  }

  return true;
}

// ------------------------------------------------------------------------
// Rotas utilitárias
// ------------------------------------------------------------------------
app.get("/", (req, res) => res.status(200).send("OK"));
app.get("/health", (req, res) => res.status(200).json({ ok: true }));
app.get("/zapi", (req, res) =>
  res.status(200).send("OK (use POST /zapi for webhook)")
);

// ------------------------------------------------------------------------
// WEBHOOK (apontar no Z-API em “Ao receber”):
// https://SEU-SERVICO.onrender.com/zapi
// ------------------------------------------------------------------------
app.post("/zapi", async (req, res) => {
  try {
    console.log("[ZAPI IN] body keys:", Object.keys(req.body || {}));

    const { phone, message, image, imageMime } = parseZapiInbound(req.body);

    console.log("[ZAPI IN parsed]", {
      phone,
      messagePreview: (message || "").slice(0, 80),
      imageType: image
        ? looksLikeDataUrl(image)
          ? "dataUrl"
          : looksLikeHttpUrl(image)
          ? "url"
          : looksLikeBase64(image)
          ? "base64"
          : "unknown"
        : null,
      imageMime,
    });

    if (!phone) {
      console.log("[ZAPI ERROR] missing phone");
      return res.status(400).json({ error: "missing phone" });
    }

    const session = getSession(phone);

    // 0) Se chegou imagem, normaliza para dataUrl (evita invalid_image_url no OpenAI)
    if (image) {
      try {
        const norm = await normalizeIncomingImageToDataUrl(image, imageMime);
        if (norm?.dataUrl) {
          session.imageDataUrl = norm.dataUrl;
          session.imageMime = norm.mime || "image/jpeg";
          session.gotReference = true;
          console.log("[ZAPI IMG] stored as dataUrl:", session.imageMime);
        } else {
          console.log("[ZAPI IMG] could not normalize image.");
        }
      } catch (e) {
        console.log("[ZAPI IMG] normalize failed:", e?.message || e);
      }
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
Regras: analise a imagem, descreva o que será feito e então gere um valor fechado de orçamento.`;

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

// ------------------------------------------------------
// Porta Render
// ------------------------------------------------------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("Servidor rodando na porta", PORT));
