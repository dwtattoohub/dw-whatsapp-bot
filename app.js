import express from "express";
import OpenAI from "openai";
import twilio from "twilio";

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// MEMÓRIA SIMPLES POR NÚMERO
const sessions = {};

app.post("/whatsapp", async (req, res) => {
  const MessagingResponse = twilio.twiml.MessagingResponse;
  const twiml = new MessagingResponse();

  const from = req.body.From;
  const text = req.body.Body || "";
  const hasMedia = Number(req.body.NumMedia) > 0;

  if (!sessions[from]) {
    sessions[from] = {
      stage: "inicio",
      referencia: false,
      tamanhoLocal: null,
    };
  }

  const session = sessions[from];

  let reply = "";

  try {
    // 1️⃣ INÍCIO
    if (session.stage === "inicio") {
      reply =
        "Oi! Eu sou o Dhyeikow, tatuador. Obrigado por me procurar e confiar no meu trabalho.\n\nMe manda uma referência em imagem do que você tem em mente pra sua tattoo.";
      session.stage = "aguardando_referencia";
    }

    // 2️⃣ AGUARDANDO REFERÊNCIA
    else if (session.stage === "aguardando_referencia") {
      if (hasMedia) {
        session.referencia = true;
        session.stage = "aguardando_tamanho_local";
        reply =
          "Perfeito! Agora me diz o tamanho aproximado (em cm) e o local do corpo onde você quer tatuar.";
      } else {
        reply =
          "Pra eu conseguir avaliar certinho, preciso que você me envie uma referência em imagem 😊";
      }
    }

    // 3️⃣ AGUARDANDO TAMANHO E LOCAL
    else if (session.stage === "aguardando_tamanho_local") {
      session.tamanhoLocal = text;
      session.stage = "orcamento";

      // CHAMA GPT SÓ PRA TEXTO DE ORÇAMENTO (SEM LOOP)
      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: `
Você é Dhyeikow, tatuador profissional com anos de experiência.
Fale de forma humana, direta e profissional.
Explique rapidamente a complexidade do trabalho.
Calcule o tempo internamente.
Sempre some 1 hora extra de segurança.
Primeira hora: R$150
Demais horas: R$130
Nunca fale valor por hora, apenas valor final.
Ative gatilhos de valor e profissionalismo.
Convide para agendamento ao final.
`,
          },
          {
            role: "user",
            content: `Referência já recebida. Tamanho e local: ${session.tamanhoLocal}`,
          },
        ],
      });

      reply = completion.choices[0].message.content;
    }

    twiml.message(reply);
    res.status(200).type("text/xml").send(twiml.toString());
  } catch (err) {
    console.error(err);
    twiml.message("Tive um problema aqui agora. Me chama de novo em alguns segundos.");
    res.status(200).type("text/xml").send(twiml.toString());
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("Servidor rodando na porta", PORT));
