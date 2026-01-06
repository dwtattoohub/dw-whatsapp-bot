import express from "express";
import twilio from "twilio";
import OpenAI from "openai";

const app = express();

// ESSENCIAL para Twilio
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

app.post("/whatsapp", async (req, res) => {
  try {
    const incomingMsg = req.body.Body;
    const from = req.body.From;

    console.log("MSG:", incomingMsg);

    const ai = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: incomingMsg,
    });

    const reply = ai.output_text || "Não consegui responder agora.";

    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message(reply);

    res.type("text/xml");
    res.status(200).send(twiml.toString());

  } catch (err) {
    console.error("ERRO:", err);
    res.status(200).send("OK");
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Servidor rodando na porta", PORT);
});
