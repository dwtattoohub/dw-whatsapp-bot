import express from "express";
import OpenAI from "openai";
import twilio from "twilio";

const app = express();

// Twilio manda x-www-form-urlencoded
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// MEMÓRIA SIMPLES (reseta quando reinicia/deploya)
const sessions = {};

// Helpers
function getSession(from) {
  if (!sessions[from]) {
    sessions[from] = {
      stage: "inicio",
      greeted: false,
      referencia: false,
      tamanhoLocal: null,
      horarioPref: null, // "comercial" | "pos"
      lastQuoteText: null,
    };
  }
  return sessions[from];
}

function detectImage(reqBody) {
  const numMedia = parseInt(reqBody.NumMedia || "0", 10);
  const ct0 = (reqBody.MediaContentType0 || "").toLowerCase();
  return numMedia > 0 && ct0.startsWith("image/");
}

function looksLikePaymentProof(text) {
  const t = (text || "").toLowerCase();
  return (
    t.includes("comprovante") ||
    t.includes("paguei") ||
    t.includes("pix feito") ||
    t.includes("pago") ||
    t.includes("transferi") ||
    t.includes("transferência")
  );
}

app.post("/whatsapp", async (req, res) => {
  const MessagingResponse = twilio.twiml.MessagingResponse;
  const twiml = new MessagingResponse();

  const from = req.body.From || "unknown";
  const text = (req.body.Body || "").trim();
  const hasImage = detectImage(req.body);

  const session = getSession(from);

  try {
    let reply = "";

    // 0) Se já está em fase de sinal e cliente menciona pagamento
    if (session.stage === "aguardando_sinal" && looksLikePaymentProof(text)) {
      reply =
        "Perfeito! Comprovante recebido ✅\n\nSeu agendamento está confirmado. " +
        "Me diz se você prefere *horário comercial* ou *pós horário comercial* pra eu te passar as opções certinhas 🙂";
      session.stage = "definir_horario";
      twiml.message(reply);
      return res.status(200).type("text/xml").send(twiml.toString());
    }

    // 1) INÍCIO (saúda 1x e pede referência)
    if (session.stage === "inicio") {
      reply =
        "Oi! Eu sou o Dhyeikow, tatuador. Obrigado por me procurar e confiar no meu trabalho.\n\n" +
        "Pra eu te passar um orçamento bem certeiro, me manda *uma referência em imagem* do que você tem em mente.";
      session.stage = "aguardando_referencia";
      twiml.message(reply);
      return res.status(200).type("text/xml").send(twiml.toString());
    }

    // 2) AGUARDANDO REFERÊNCIA (só avança se tiver imagem)
    if (session.stage === "aguardando_referencia") {
      if (hasImage) {
        session.referencia = true;
        session.stage = "aguardando_tamanho_local";
        reply =
          "Boa! Referência recebida ✅\n\nAgora me diz:\n" +
          "• *tamanho* (em cm)\n" +
          "• *local do corpo*\n" +
          "Ex: “25cm no ombro”";
      } else {
        reply =
          "Pra eu avaliar certinho, preciso que você envie *uma referência em imagem* (foto/print) 🙂";
      }

      twiml.message(reply);
      return res.status(200).type("text/xml").send(twiml.toString());
    }

    // 3) AGUARDANDO TAMANHO E LOCAL
    if (session.stage === "aguardando_tamanho_local") {
      // evita avançar se o cliente mandar vazio
      if (!text) {
        reply = "Me manda o tamanho e o local, por favor 🙂 Ex: “25cm no ombro”.";
        twiml.message(reply);
        return res.status(200).type("text/xml").send(twiml.toString());
      }

      session.tamanhoLocal = text;
      session.stage = "orcamento";

      // GPT: texto do orçamento com suas regras
      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: `
Você é o Dhyeikow, tatuador profissional (anos de experiência), estilo whip shading (mais demorado).
Objetivo: responder de forma humana, amigável e profissional, sem texto gigante.

REGRAS IMPORTANTES:
- Só gerar orçamento porque a referência em imagem já foi recebida.
- NÃO repetir saudação.
- Não fazer muitas perguntas: no máximo 1 pergunta curta, só se for indispensável.
- Explicar rapidamente (2 a 4 linhas) por que é um trabalho mais complexo (tamanho, área, whip shading, nível de detalhe).
- Estimar tempo em FAIXA, mas SEM falar "média". Use: "estimativa de X a Y horas".
- Sempre adicionar +1 hora de segurança usando o MAIOR valor da faixa (ex: se estimou 4–6h, considerar 7h no cálculo).
- Cálculo interno:
  * 1ª hora = R$150
  * Demais horas = R$130
  * NÃO mostrar conta, NÃO falar valor/hora. Apenas valor final (ou faixa final se necessário).
- Depois do valor, usar gatilhos suaves (segurança, exclusividade, qualidade, encaixe, pós/retorno).
- Final: convite claro para agendar + pedir preferência de horário (comercial ou pós comercial).

PAGAMENTO (citar de forma curta):
- Pix, débito ou crédito em até 12x (com acréscimo da maquininha).
- Sinal: 10% para reservar.
- Pix: dwtattooshop@gmail.com
`,
          },
          {
            role: "user",
            content: `Tamanho e local informado pelo cliente: ${session.tamanhoLocal}`,
          },
        ],
      });

      reply = completion.choices?.[0]?.message?.content?.trim() || "Perfeito! Me passa mais um detalhe do tamanho e local.";
      session.lastQuoteText = reply;

      // após orçamento, já vai pra etapa de definir horário/sinal
      session.stage = "pos_orcamento";

      twiml.message(reply);
      return res.status(200).type("text/xml").send(twiml.toString());
    }

    // 4) PÓS-ORÇAMENTO: organizar agenda e sinal
    if (session.stage === "pos_orcamento") {
      const t = text.toLowerCase();

      // se cliente escolher horário aqui
      if (t.includes("comercial")) {
        session.horarioPref = "comercial";
        session.stage = "aguardando_sinal";
        reply =
          "Fechado 🙌\n\nMe passa *2 ou 3 dias* que você consegue (ex: “quarta ou sexta”) que eu te encaixo no horário comercial.\n\n" +
          "Pra reservar a data, o sinal é *10%* via Pix: *dwtattooshop@gmail.com*.\n" +
          "Depois que enviar o comprovante, eu já confirmo aqui ✅";
      } else if (t.includes("pós") || t.includes("pos") || t.includes("noite") || t.includes("após")) {
        session.horarioPref = "pos";
        session.stage = "aguardando_sinal";
        reply =
          "Boa 🙌\n\nMe passa *2 ou 3 dias* que você consegue (ex: “quarta ou sexta”) que eu te encaixo pós horário comercial.\n\n" +
          "Pra reservar a data, o sinal é *10%* via Pix: *dwtattooshop@gmail.com*.\n" +
          "Depois que enviar o comprovante, eu já confirmo aqui ✅";
      } else {
        // se ele mandar outra coisa, só pergunta a preferência
        reply =
          "Perfeito. Você prefere fazer em *horário comercial* ou *pós horário comercial*? 🙂";
      }

      twiml.message(reply);
      return res.status(200).type("text/xml").send(twiml.toString());
    }

    // 5) DEFINIR HORÁRIO (caso caia aqui)
    if (session.stage === "definir_horario") {
      const t = text.toLowerCase();
      if (t.includes("comercial")) {
        session.horarioPref = "comercial";
        session.stage = "aguardando_sinal";
        reply =
          "Fechado! Me passa *2 ou 3 dias* que você consegue.\n\n" +
          "Pra reservar a data, o sinal é *10%* via Pix: *dwtattooshop@gmail.com*.\n" +
          "Assim que mandar o comprovante, eu confirmo ✅";
      } else if (t.includes("pós") || t.includes("pos") || t.includes("noite") || t.includes("após")) {
        session.horarioPref = "pos";
        session.stage = "aguardando_sinal";
        reply =
          "Fechado! Me passa *2 ou 3 dias* que você consegue.\n\n" +
          "Pra reservar a data, o sinal é *10%* via Pix: *dwtattooshop@gmail.com*.\n" +
          "Assim que mandar o comprovante, eu confirmo ✅";
      } else {
        reply = "Você prefere *horário comercial* ou *pós horário comercial*? 🙂";
      }

      twiml.message(reply);
      return res.status(200).type("text/xml").send(twiml.toString());
    }

    // 6) AGUARDANDO SINAL
    if (session.stage === "aguardando_sinal") {
      if (looksLikePaymentProof(text)) {
        reply =
          "Perfeito! Comprovante recebido ✅\n\nSeu horário está reservado. " +
          "Se quiser, já me confirma: *horário comercial* ou *pós horário comercial*?";
        session.stage = "definir_horario";
      } else {
        reply =
          "Show. Pra reservar a data, o sinal é *10%* via Pix: *dwtattooshop@gmail.com*.\n" +
          "Quando enviar o comprovante, eu confirmo aqui ✅";
      }

      twiml.message(reply);
      return res.status(200).type("text/xml").send(twiml.toString());
    }

    // fallback (se cair em stage desconhecido)
    session.stage = "inicio";
    twiml.message("Me manda uma referência em imagem pra eu te atender certinho 🙂");
    return res.status(200).type("text/xml").send(twiml.toString());
  } catch (err) {
    console.error("ERRO NO WEBHOOK:", err);
    twiml.message("Tive um problema agora. Me chama de novo em alguns segundos.");
    return res.status(200).type("text/xml").send(twiml.toString());
  }
});

// Render geralmente usa 10000
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("Servidor rodando na porta", PORT));
