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

    const incomingMsg = req.body.Body || "";

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: process.env.SYSTEM_PROMPT || "Você é um assistente útil.",
        },
        { role: "user", content: incomingMsg },
      ],
    });

    const reply = completion.choices?.[0]?.message?.content?.trim() || "Ok.";
    console.log("RESPOSTA GPT:", reply);

    // Responde pro WhatsApp via TwiML (Sandbox funciona 100% assim)
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
