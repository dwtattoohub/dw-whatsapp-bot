import express from "express";
import bodyParser from "body-parser";
import OpenAI from "openai";
import twilio from "twilio";

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

/* =========================
   OPENAI
========================= */
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/* =========================
   TWILIO
========================= */
const MessagingResponse = twilio.twiml.MessagingResponse;

/* =========================
   WEBHOOK WHATSAPP
========================= */
app.post("/whatsapp", async (req, res) => {
  const twiml = new MessagingResponse();

  try {
    const userMessage = req.body.Body;

    if (!userMessage) {
      twiml.message("Mensagem vazia recebida.");
      res.type("text/xml").status(200).send(twiml.toString());
      return;
    }

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "Você é um assistente profissional que responde mensagens de WhatsApp de forma clara, educada e objetiva.",
        },
        {
          role: "user",
          content: userMessage,
        },
      ],
    });

    const resposta =
      completion.choices[0]?.message?.content ||
      "Não consegui gerar uma resposta agora.";

    twiml.message(resposta);
    res.type("text/xml").status(200).send(twiml.toString());
  } catch (error) {
    console.error("ERRO OPENAI:", error);

    twiml.message(
      "Erro ao processar sua mensagem. Tente novamente em instantes."
    );
    res.type("text/xml").status(200).send(twiml.toString());
  }
});

/* =========================
   HEALTH CHECK
========================= */
app.get("/", (req, res) => {
  res.send("DW WhatsApp Bot ONLINE");
});

/* =========================
   SERVER
========================= */
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
