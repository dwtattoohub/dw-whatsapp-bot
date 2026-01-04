import express from "express";
import bodyParser from "body-parser";
import twilio from "twilio";
import OpenAI from "openai";

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

app.post("/whatsapp", async (req, res) => {
  try {
    const incomingMsg = req.body.Body;
    const from = req.body.From;

    const aiResponse = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: [
        {
          role: "system",
          content: process.env.SYSTEM_PROMPT,
        },
        {
          role: "user",
          content: incomingMsg,
        },
      ],
    });

    const reply = aiResponse.output_text;

    await client.messages.create({
      from: process.env.TWILIO_WHATSAPP_FROM,
      to: from,
      body: reply,
    });

    res.send("<Response></Response>");
  } catch (err) {
    console.error(err);
    res.status(500).send("Erro no webhook");
  }
});

app.get("/", (req, res) => {
  res.send("Bot WhatsApp DW online");
});

app.listen(process.env.PORT || 3000);
