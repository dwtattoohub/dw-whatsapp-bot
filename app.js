import express from "express";
import twilio from "twilio";
import OpenAI from "openai";

const app = express();

// ESSENCIAL para Twilio (Webhook)
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Twilio client
const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// Webhook WhatsApp
app.post("/whatsapp", async (req, res) => {
  try {
    console.log("CHEGOU DA TWILIO");
    console.log(req.body);

    const incomingMsg = req.body.Body;
    const from = req.body.From;

    // Chamada OpenAI
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: process.env.SYSTEM_PROMPT || "Você é um assistente útil.",
        },
        {
          role: "user",
          content: incomingMsg,
        },
      ],
    });

    const reply = completion.choices[0].message.content;

    // Resposta via WhatsApp
    await client.messages.create({
      from: "whatsapp:" + process.env.TWILIO_WHATSAPP_NUMBER,
      to: from,
      body: reply,
    });

    res.status(200).send("ok");
  } catch (err) {
    console.error("ERRO NO WEBHOOK:", err);
    res.status(200).send("ok"); // NUNCA retornar erro pra Twilio
  }
});

// Porta (Render usa 10000)
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log("Servidor rodando na porta", PORT);
});
