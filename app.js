import express from "express";
import OpenAI from "openai";
import twilio from "twilio";

const app = express();

// Twilio envia form-urlencoded
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const MessagingResponse = twilio.twiml.MessagingResponse;

app.post("/whatsapp", async (req, res) => {
  const twiml = new MessagingResponse();

  try {
    console.log("==== MENSAGEM RECEBIDA ====");
    console.log(req.body);

    const incomingMsg = (req.body.Body || "").trim();
    const from = req.body.From || "unknown";

    const numMedia = Number(req.body.NumMedia || 0);
    const hasImage = numMedia > 0;
    const mediaUrl = hasImage ? req.body.MediaUrl0 : null;

    const normalized = incomingMsg.toLowerCase();
    const greetings = ["oi", "olá", "ola", "bom dia", "boa tarde", "boa noite"];
    const isGreetingOnly = greetings.includes(normalized);

    // 👉 Saudação APENAS se for a primeira mensagem simples
    if (isGreetingOnly && !hasImage) {
      twiml.message(
        "Oi! Aqui é o Dhyeikow (DW Tattooer). Obrigado por me chamar e confiar no meu trabalho 🙏\n\nMe manda uma referência em imagem do que você tem em mente, junto com o tamanho em cm e o local do corpo, que eu já te passo uma ideia bem certeira."
      );
      return res.status(200).type("text/xml").send(twiml.toString());
    }

    // 👉 Monta contexto técnico invisível pro GPT
    const systemContext = `
${process.env.SYSTEM_PROMPT}

CONTEXTO TÉCNICO (NÃO MOSTRAR AO CLIENTE):
- Cliente: ${from}
- Já enviou imagem: ${hasImage ? "SIM" : "NÃO"}
- URL da imagem (se houver): ${mediaUrl || "null"}

REGRAS TÉCNICAS:
- Se já houver imagem, NUNCA pedir imagem novamente.
- Nunca se reapresentar.
- Nunca repetir perguntas já respondidas.
- Responder como tatuador humano, direto e profissional.
`.trim();

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.6,
      messages: [
        { role: "system", content: systemContext },
        { role: "user", content: incomingMsg },
      ],
    });

    const reply =
      completion.choices?.[0]?.message?.content?.trim() ||
      "Perfeito! Me conta só mais um detalhe pra eu te orientar melhor.";

    console.log("==== RESPOSTA GPT ====");
    console.log(reply);

    twiml.message(reply);
    res.status(200).type("text/xml").send(twiml.toString());
  } catch (err) {
    console.error("ERRO NO WEBHOOK:", err);
    twiml.message(
      "Tive um erro técnico aqui agora 😅 Pode me chamar de novo em alguns segundos?"
    );
    res.status(200).type("text/xml").send(twiml.toString());
  }
});

// Porta padrão Render
const PORT = process.env.PORT || 10000;
app.listen(PORT, () =>
  console.log("Servidor WhatsApp rodando na porta", PORT)
);
