import express from "express";
import OpenAI from "openai";
import twilio from "twilio";

const app = express();

/**
 * ESSENCIAL para Twilio (Webhook WhatsApp)
 */
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

/**
 * OpenAI
 */
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// 🔴 LOG CRÍTICO — NÃO REMOVA AGORA
console.log("OPENAI KEY EXISTS:", !!process.env.OPENAI_API_KEY);

/**
 * Twilio client
 */
const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

/**
 * Webhook WhatsApp
 */
app.post("/whatsapp", async (req, res) => {
  try {
    console.log("CHEGOU DA TWILIO");
    console.log(req.body);

    const incomingMsg = req.body.Body;
    const from = req.body.From;

    const aiResponse = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: [
        {
          role: "system",
          content: "Você é um assistente profissional e educado.",
        },
        {
          role: "user",
          content: incomingMsg,
        },
      ],
    });

    const reply =
      aiResponse.output_text || "Não consegui gerar uma resposta agora.";

    await client.messages.create({
      from: "whatsapp:" + process.env.TWILIO_WHATSAPP_NUMBER,
      to: from,
      body: reply,
    });

    res.status(200).send("ok");
  } catch (error) {
    console.error("ERRO NO WEBHOOK:", error);
    res.status(200).send("ok");
  }
});

/**
 * Porta (Render)
 */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Servidor rodando na porta", PORT);
});
