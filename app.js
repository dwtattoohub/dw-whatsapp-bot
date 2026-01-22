// app.js (pronto pra colar no GitHub)
// - Mantém seu fluxo por "stage" igual
// - Adiciona endpoint novo /zapi (JSON) + mantém /whatsapp (Twilio) se você quiser usar depois
// - Responde Z-API com JSON (não TwiML)
// - Cria GET /health e GET /zapi só pra teste rápido no navegador

import express from "express";
import OpenAI from "openai";
import twilio from "twilio";

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// -------------------- Memória simples por número (RAM) --------------------
const sessions = {};
function getSession(from) {
  if (!sessions[from]) {
    sessions[from] = {
      stage: "inicio",
      imageDataUrl: null, // data:image/jpeg;base64,...
      imageMime: null,
      gotReference: false,
      sizeLocationText: null,
    };
  }
  return sessions[from];
}

// -------------------- Helpers --------------------
function extractSizeLocation(text) {
  const t = (text || "").trim();
  if (!t) return null;
  const hasNumber = /\d/.test(t);
  if (!hasNumber) return null;
  return t;
}

function safeStr(v) {
  if (v === null || v === undefined) return "";
  return String(v);
}

/**
 * Normaliza payload do Z-API (vários formatos) para:
 * { from, text, numMedia, mediaUrl }
 */
function normalizeZapiPayload(body) {
  // Formatos comuns: body.phone / body.from / body.sender / body.chatId...
  const from =
    safeStr(body?.from) ||
    safeStr(body?.phone) ||
    safeStr(body?.sender) ||
    safeStr(body?.participantPhone) ||
    safeStr(body?.chatId) ||
    safeStr(body?.data?.from) ||
    safeStr(body?.data?.phone) ||
    "unknown";

  // Texto: body.text.message / body.message.text / body.body / body.data.message...
  const text =
    safeStr(body?.text?.message) ||
    safeStr(body?.message?.text) ||
    safeStr(body?.body) ||
    safeStr(body?.message) ||
    safeStr(body?.data?.message) ||
    safeStr(body?.data?.text) ||
    "";

  // Mídia: body.image.url / body.message.imageMessage.url / body.media.url / body.data.media...
  const mediaUrl =
    safeStr(body?.image?.url) ||
    safeStr(body?.image?.link) ||
    safeStr(body?.media?.url) ||
    safeStr(body?.mediaUrl) ||
    safeStr(body?.message?.imageMessage?.url) ||
    safeStr(body?.message?.documentMessage?.url) ||
    safeStr(body?.data?.image?.url) ||
    safeStr(body?.data?.media?.url) ||
    safeStr(body?.data?.mediaUrl) ||
    "";

  const numMedia = mediaUrl ? 1 : 0;

  return { from, text: (text || "").trim(), numMedia, mediaUrl };
}

/**
 * Baixa imagem do Z-API (URL pública). Se for URL privada, aí precisa de token — mas
 * na maioria dos setups do Z-API o link vem acessível.
 */
async function downloadPublicMediaAsDataUrl(url) {
  const resp = await fetch(url);
  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw new Error(`Failed to fetch media: ${resp.status} ${t}`);
  }
  const contentType = resp.headers.get("content-type") || "image/jpeg";
  const arrayBuffer = await resp.arrayBuffer();
  const base64 = Buffer.from(arrayBuffer).toString("base64");
  return { dataUrl: `data:${contentType};base64,${base64}`, mime: contentType };
}

// -------------------- Fluxo central (reutiliza pro Twilio e pro Z-API) --------------------
async function runBotFlow({ from, text, numMedia, mediaUrl }) {
  const session = getSession(from);

  // Se chegou imagem, baixa e guarda
  if (numMedia > 0 && mediaUrl) {
    const { dataUrl, mime } = await downloadPublicMediaAsDataUrl(mediaUrl);
    session.imageDataUrl = dataUrl;
    session.imageMime = mime;
    session.gotReference = true;
  }

  // 1) INÍCIO
  if (session.stage === "inicio") {
    session.stage = "aguardando_referencia";
    return (
      "Oi! Eu sou o Dhyeikow, tatuador. Obrigado por me procurar e confiar no meu trabalho.\n\n" +
      "Me manda uma referência em *imagem* do que você quer tatuar (pode ser foto/print)."
    );
  }

  // 2) AGUARDANDO REFERÊNCIA
  if (session.stage === "aguardando_referencia") {
    if (!session.gotReference) {
      return "Pra eu avaliar certinho, me envia a *referência em imagem*.";
    }

    session.stage = "aguardando_tamanho_local";
    return (
      "Boa! Referência recebida ✅\n\n" +
      "Agora me diz *tamanho (cm)* e *local do corpo*.\n" +
      "Ex: “25cm no ombro”"
    );
  }

  // 3) AGUARDANDO TAMANHO/LOCAL
  if (session.stage === "aguardando_tamanho_local") {
    const sizeLoc = extractSizeLocation(text);
    if (!sizeLoc) {
      return (
        "Me fala só assim pra eu fechar certinho:\n" +
        "Ex: “25cm no ombro” ou “15cm antebraço interno”."
      );
    }

    session.sizeLocationText = sizeLoc;
    session.stage = "orcamento";
  }

  // 4) ORÇAMENTO (OpenAI)
  if (session.stage === "orcamento") {
    if (!session.gotReference || !session.imageDataUrl) {
      session.stage = "aguardando_referencia";
      return "Consigo sim — só me manda a referência em *imagem* de novo, por favor.";
    }

    const systemPrompt =
      process.env.SYSTEM_PROMPT ||
      "Você é Dhyeikow, tatuador. Seja humano, objetivo e profissional.";

    const userMsg = `Tamanho e local: ${session.sizeLocationText}.
Regras: você deve analisar a imagem, descrever e classificar o estilo, e então calcular um valor fechado seguindo as regras.`;

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

    const reply =
      completion?.choices?.[0]?.message?.content?.trim() ||
      "Consigo sim — me manda de novo o tamanho e local pra eu fechar certinho.";

    session.stage = "pos_orcamento";
    return reply;
  }

  // 5) PÓS-ORÇAMENTO
  if (session.stage === "pos_orcamento") {
    // Nova imagem reinicia pro tamanho/local
    if (session.gotReference && numMedia > 0) {
      session.stage = "aguardando_tamanho_local";
      return (
        "Fechado — referência nova recebida ✅\n\n" +
        "Agora me diz *tamanho (cm)* e *local do corpo* pra eu fechar o valor."
      );
    }

    const quick = (text || "").toLowerCase();
    if (quick.includes("cm")) {
      session.sizeLocationText = text;
      session.stage = "orcamento";
      return "Perfeito — só um segundo que vou recalcular certinho com esse tamanho.";
    }

    return (
      "Perfeito. Se quiser, me confirma:\n" +
      "1) tamanho e local certinhos\n" +
      "2) horário comercial ou pós-comercial\n\n" +
      "Aí eu já te passo as próximas datas e como fica o sinal pra reservar."
    );
  }

  // fallback
  return "Me manda a referência em imagem e o tamanho/local pra eu te atender certinho.";
}

// -------------------- Endpoints --------------------
app.get("/health", (req, res) => res.status(200).json({ ok: true }));
app.get("/zapi", (req, res) => res.status(200).json({ ok: true, hint: "use POST /zapi" }));

// Z-API WEBHOOK (principal)
app.post("/zapi", async (req, res) => {
  try {
    const { from, text, numMedia, mediaUrl } = normalizeZapiPayload(req.body);

    // log curto pra você ver no Render que chegou
    console.log("[ZAPI IN]", { from, text, hasMedia: !!mediaUrl });

    const replyText = await runBotFlow({ from, text, numMedia, mediaUrl });

    // IMPORTANTÍSSIMO:
    // Z-API normalmente NÃO aceita “responder” no webhook automaticamente.
    // Você precisa enviar a mensagem via endpoint de envio do Z-API usando seu token/instance.
    // Então aqui a gente só confirma e loga o reply.
    console.log("[ZAPI OUT]", { to: from, replyPreview: replyText?.slice(0, 80) });

    return res.status(200).json({ ok: true, reply: replyText });
  } catch (err) {
    console.error("ERRO /zapi:", err);
    return res.status(200).json({ ok: false, error: "fail" });
  }
});

// TWILIO (mantive, caso você volte)
app.post("/whatsapp", async (req, res) => {
  const MessagingResponse = twilio.twiml.MessagingResponse;
  const twiml = new MessagingResponse();

  try {
    const from = req.body.From || "unknown";
    const text = (req.body.Body || "").trim();
    const numMedia = Number(req.body.NumMedia || 0);
    const mediaUrl = req.body.MediaUrl0 || "";

    console.log("[TWILIO IN]", { from, text, hasMedia: !!mediaUrl });

    const replyText = await runBotFlow({ from, text, numMedia, mediaUrl });

    twiml.message(replyText);
    return res.status(200).type("text/xml").send(twiml.toString());
  } catch (err) {
    console.error("ERRO /whatsapp:", err);
    twiml.message("Tive um problema aqui agora. Me chama de novo em alguns segundos.");
    return res.status(200).type("text/xml").send(twiml.toString());
  }
});

// Render geralmente usa 10000
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("Servidor rodando na porta", PORT));
