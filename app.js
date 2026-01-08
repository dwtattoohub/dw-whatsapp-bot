import express from "express";
import OpenAI from "openai";
import twilio from "twilio";

const app = express();

// Twilio manda x-www-form-urlencoded
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

app.post("/whatsapp", async (req, res) => {
  const MessagingResponse = twilio.twiml.MessagingResponse;
  const twiml = new MessagingResponse();

  try {
    console.log("CHEGOU DA TWILIO");
    console.log(req.body);

    const incomingMsg = (req.body.Body || "").trim();
    const hasImage = Number(req.body.NumMedia || 0) > 0;
const mediaUrl = hasImage ? req.body.MediaUrl0 : null;

    // Detecta mídia (foto) enviada pelo WhatsApp/Twilio
    const numMedia = parseInt(req.body.NumMedia || "0", 10);
    const mediaUrl0 = numMedia > 0 ? req.body.MediaUrl0 : null;
    const mediaType0 = numMedia > 0 ? req.body.MediaContentType0 : null;

    // Força “modo orçamento direto” quando o cliente manda foto/referência
    let userContent = incomingMsg;

    if (numMedia > 0) {
      userContent =
        `O cliente enviou uma REFERÊNCIA (imagem). ` +
        `Trate como arte definida ("igual à referência"). ` +
        `Seja direto e vá para ORÇAMENTO com base em R$150/h. ` +
        `Faça no máximo 2 perguntas (ideal 1): tamanho (cm) e local do corpo. ` +
        `NÃO peça tema/elementos.\n\n` +
        `Mensagem do cliente: ${incomingMsg || "(sem texto)"}\n` +
        `Imagem URL: ${mediaUrl0}\n` +
        `Tipo: ${mediaType0 || "desconhecido"}`;
    }

    const systemPrompt =
      process.env.SYSTEM_PROMPT ||
      "Você é um assistente útil. Seja direto e objetivo.";

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.4,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ],
    });

    const reply =
      completion.choices?.[0]?.message?.content?.trim() ||
      "Perfeito. Me diz o tamanho (cm) e o local do corpo pra eu te passar o valor certinho.";

    console.log("RESPOSTA GPT:", reply);

    // Responde pro WhatsApp via TwiML
    twiml.message(reply);
    res.status(200).type("text/xml").send(twiml.toString());
  } catch (err) {
    console.error("ERRO NO WEBHOOK:", err);
    twiml.message("Deu um erro aqui. Tenta de novo em 10s.");
    res.status(200).type("text/xml").send(twiml.toString());
  }
});

// Render geralmente usa 10000
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("Servidor rodando na porta", PORT));
