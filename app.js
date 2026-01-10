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
      imageDataUrl: null,       // data:image/jpeg;base64,...
      imageMime: null,
      gotReference: false,
      sizeLocationText: null,
    };
  }
  return sessions[from];
}

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

  // Twilio MediaUrl precisa de autenticação
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
  // Mantém simples: você quer “25cm no ombro”, “5 cm no antebraço”, etc.
  // Se vier vazio, retorna null pra perguntar de novo.
  const t = (text || "").trim();
  if (!t) return null;
  // Heurística mínima: tem número + "cm" OU tem número e local
  const hasNumber = /\d/.test(t);
  if (!hasNumber) return null;
  return t;
}

// ---------- Webhook ----------
app.post("/whatsapp", async (req, res) => {
  const MessagingResponse = twilio.twiml.MessagingResponse;
  const twiml = new MessagingResponse();

  const from = req.body.From || "unknown";
  const text = (req.body.Body || "").trim();
  const numMedia = Number(req.body.NumMedia || 0);

  const session = getSession(from);

  try {
    // 0) Se chegou imagem, baixa e guarda (SEM calcular ainda, só guarda)
    if (numMedia > 0) {
      const mediaUrl = req.body.MediaUrl0; // primeira imagem
      if (mediaUrl) {
        const { dataUrl, mime } = await downloadTwilioMediaAsDataUrl(mediaUrl);
        session.imageDataUrl = dataUrl;
        session.imageMime = mime;
        session.gotReference = true;
      }
    }

    let reply = "";

    // 1) INÍCIO (saudação só UMA vez)
    if (session.stage === "inicio") {
      reply =
        "Oi! Eu sou o Dhyeikow, tatuador. Obrigado por me procurar e confiar no meu trabalho.\n\n" +
        "Me manda uma referência em *imagem* do que você quer tatuar (pode ser foto/print).";
      session.stage = "aguardando_referencia";
      twiml.message(reply);
      return res.status(200).type("text/xml").send(twiml.toString());
    }

    // 2) AGUARDANDO REFERÊNCIA
    if (session.stage === "aguardando_referencia") {
      if (!session.gotReference) {
        reply = "Pra eu avaliar certinho, me envia a *referência em imagem* 😊";
        twiml.message(reply);
        return res.status(200).type("text/xml").send(twiml.toString());
      }

      // Já tem imagem -> pede tamanho/local (curto, sem repetir saudação)
      reply =
        "Boa! Referência recebida ✅\n\n" +
        "Agora me diz *tamanho (cm)* e *local do corpo*.\n" +
        "Ex: “25cm no ombro”";
      session.stage = "aguardando_tamanho_local";
      twiml.message(reply);
      return res.status(200).type("text/xml").send(twiml.toString());
    }

    // 3) AGUARDANDO TAMANHO/LOCAL
    if (session.stage === "aguardando_tamanho_local") {
      const sizeLoc = extractSizeLocation(text);

      if (!sizeLoc) {
        reply =
          "Me fala só assim pra eu fechar certinho:\n" +
          "Ex: “25cm no ombro” ou “15cm antebraço interno”.";
        twiml.message(reply);
        return res.status(200).type("text/xml").send(twiml.toString());
      }

      session.sizeLocationText = sizeLoc;
      session.stage = "orcamento";
    }

    // 4) ORÇAMENTO (analisando a imagem de verdade)
    if (session.stage === "orcamento") {
      if (!session.gotReference || !session.imageDataUrl) {
        // Segurança: se perder a imagem, volta a pedir
        session.stage = "aguardando_referencia";
        reply = "Consigo sim — só me manda a referência em *imagem* de novo, por favor.";
        twiml.message(reply);
        return res.status(200).type("text/xml").send(twiml.toString());
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
              {
                type: "image_url",
                image_url: { url: session.imageDataUrl },
              },
            ],
          },
        ],
      });

      reply =
        completion?.choices?.[0]?.message?.content?.trim() ||
        "Consigo sim — me manda de novo o tamanho e local pra eu fechar certinho.";

      // Depois de mandar orçamento, já entra em “pós-orçamento”
      session.stage = "pos_orcamento";

      twiml.message(reply);
      return res.status(200).type("text/xml").send(twiml.toString());
    }

    // 5) PÓS-ORÇAMENTO (sem ficar repetindo fluxo)
    if (session.stage === "pos_orcamento") {
      // Aqui você pode só responder natural e, se vier nova imagem, reinicia o fluxo
      if (session.gotReference && numMedia > 0) {
        // Nova referência => reinicia
        session.stage = "aguardando_tamanho_local";
        reply =
          "Fechado — referência nova recebida ✅\n\n" +
          "Agora me diz *tamanho (cm)* e *local do corpo* pra eu fechar o valor.";
        twiml.message(reply);
        return res.status(200).type("text/xml").send(twiml.toString());
      }

      // Se perguntarem “e se for 25cm?” etc:
      const quick = text.toLowerCase();
      if (quick.includes("cm")) {
        session.sizeLocationText = text;
        session.stage = "orcamento";
        reply = "Perfeito — só um segundo que vou recalcular certinho com esse tamanho.";
        twiml.message(reply);
        return res.status(200).type("text/xml").send(twiml.toString());
      }

      reply =
        "Perfeito. Se quiser, me confirma:\n" +
        "1) tamanho e local certinhos\n" +
        "2) horário comercial ou pós-comercial\n\n" +
        "Aí eu já te passo as próximas datas e como fica o sinal pra reservar.";
      twiml.message(reply);
      return res.status(200).type("text/xml").send(twiml.toString());
    }

    // fallback
    twiml.message("Me manda a referência em imagem e o tamanho/local pra eu te atender certinho.");
    return res.status(200).type("text/xml").send(twiml.toString());
  } catch (err) {
    console.error("ERRO:", err);
    twiml.message("Tive um problema aqui agora. Me chama de novo em alguns segundos.");
    return res.status(200).type("text/xml").send(twiml.toString());
  }
});

// Render geralmente usa 10000
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("Servidor rodando na porta", PORT));
