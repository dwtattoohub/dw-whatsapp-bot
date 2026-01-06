import express from "express";
import twilio from "twilio";
import OpenAI from "openai";

const app = express();

// Twilio manda x-www-form-urlencoded
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// evita duplicar resposta se a Twilio reenviar o mesmo webhook
const seen = new Set();
setInterval(() => seen.clear(), 10 * 60 * 1000); // limpa a cada 10 min

app.post("/whatsapp", (req, res) => {
  // 1) responde rápido pra Twilio não dar 11200
  res.sendStatus(200);

  // 2) processa em "background"
  (async () => {
    try {
      const incomingMsg = (req.body.Body || "").trim();
      const from = req.body.From; // ex: "whatsapp:+55..."
      const to = req.body.To;     // ex: "whatsapp:+14155238886" (sandbox)
      const messageSid = req.body.MessageSid;

      console.log("CHEGOU DA TWILIO:", { messageSid, from, to, incomingMsg });

      if (!incomingMsg) return;

      if (messageSid && seen.has(messageSid)) {
        console.log("IGNORADO (retry duplicado):", messageSid);
        return;
      }
      if (messageSid) seen.add(messageSid);

      const systemPrompt =
        process.env.SYSTEM_PROMPT ||
        "Você é um assistente do estúdio DW Tattooer. Responda curto, objetivo e útil.";

      const ai = await openai.responses.create({
        model: "gpt-4.1-mini",
        input: [
          { role: "system", content: systemPrompt },
          { role: "user", content: incomingMsg }
        ],
        max_output_tokens: 300
      });

      const reply =
        (ai.output_text && ai.output_text.trim()) ||
        "Tive um erro aqui. Pode repetir a mensagem?";

      // 3) manda resposta via WhatsApp (Twilio)
      await client.messages.create({
        from: to,   // MUITO IMPORTANTE: responde a partir do mesmo número que recebeu (sandbox)
        to: from,   // responde pro cliente
        body: reply
      });

      console.log("RESPONDI PRO WHATSAPP ✅");
    } catch (err) {
      console.error("ERRO NO BOT:", err?.message || err);
    }
  })();
});

app.get("/", (req, res) => res.status(200).send("OK"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Servidor rodando na porta", PORT));
