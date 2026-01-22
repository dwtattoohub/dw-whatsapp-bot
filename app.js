// app.js
import express from "express";
import OpenAI from "openai";

const app = express();
app.use(express.json({ limit: "25mb" }));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const ZAPI_INSTANCE_ID = process.env.ZAPI_INSTANCE_ID;
const ZAPI_INSTANCE_TOKEN = process.env.ZAPI_INSTANCE_TOKEN;
const ZAPI_CLIENT_TOKEN = process.env.ZAPI_CLIENT_TOKEN;

function requireEnv(name) {
  if (!process.env[name]) throw new Error(`Missing env var: ${name}`);
}
requireEnv("OPENAI_API_KEY");
requireEnv("ZAPI_INSTANCE_ID");
requireEnv("ZAPI_INSTANCE_TOKEN");
requireEnv("ZAPI_CLIENT_TOKEN");

const ZAPI_BASE = `https://api.z-api.io/instances/${ZAPI_INSTANCE_ID}/token/${ZAPI_INSTANCE_TOKEN}`;

// Cache simples pra não ficar repetindo a mesma pergunta
// key: phone, value: { lastBotText, lastAt }
const chatCache = new Map();
function setCache(phone, text) {
  chatCache.set(phone, { lastBotText: text, lastAt: Date.now() });
}
function getCache(phone) {
  const v = chatCache.get(phone);
  if (!v) return null;
  // expira em 2 minutos
  if (Date.now() - v.lastAt > 2 * 60 * 1000) return null;
  return v;
}

async function zapiSendText(phone, message) {
  const url = `${ZAPI_BASE}/send-text`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Client-Token": ZAPI_CLIENT_TOKEN,
    },
    body: JSON.stringify({ phone, message }),
  });

  const bodyText = await res.text();
  if (!res.ok) {
    throw new Error(`[ZAPI SEND FAILED] ${res.status} ${bodyText}`);
  }
  return bodyText;
}

async function fetchAsBase64(url, mimeHint) {
  // Muitas vezes a URL de mídia exige Client-Token pra baixar
  const res = await fetch(url, {
    headers: {
      "Client-Token": ZAPI_CLIENT_TOKEN,
    },
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Failed to download image from url. status=${res.status} body=${t}`);
  }
  const arr = new Uint8Array(await res.arrayBuffer());
  const b64 = Buffer.from(arr).toString("base64");
  const mime = mimeHint || res.headers.get("content-type") || "image/jpeg";
  return { b64, mime };
}

function normalizeIncoming(body) {
  // Z-API pode variar campos. Tenta cobrir os mais comuns.
  const phone =
    body.phone ||
    body.from ||
    body.senderPhone ||
    body?.data?.phone ||
    body?.data?.from ||
    null;

  // Texto
  const text =
    body.message ||
    body.text ||
    body.body ||
    body?.data?.message ||
    body?.data?.text ||
    "";

  // Tipo
  const messageType =
    body.messageType ||
    body.type ||
    body?.data?.messageType ||
    body?.data?.type ||
    "";

  // Imagem URL e mime
  const imageUrl =
    body.imageUrl ||
    body.imageURL ||
    body?.image?.url ||
    body?.data?.imageUrl ||
    body?.data?.image?.url ||
    body?.mediaUrl ||
    body?.data?.mediaUrl ||
    "";

  const imageMime =
    body.imageMime ||
    body.mimeType ||
    body?.image?.mimeType ||
    body?.data?.imageMime ||
    body?.data?.mimeType ||
    body?.data?.image?.mimeType ||
    "";

  return { phone, text, messageType, imageUrl, imageMime };
}

const SYSTEM_STYLE = `
Você é um tatuador real atendendo no WhatsApp. Soe humano, caloroso e profissional.
Regras:
- Não diga que é IA.
- Não assine mensagem.
- Não seja seco: agradeça por procurar e conduza com educação.
- Primeiro entender o projeto; depois (quando fizer sentido) passar o valor final com segurança.
- Nunca fale em horas nem preço/hora. Isso é interno.
- Se o cliente pedir valor antes, responda de forma humana: "consigo te passar certinho, só preciso ver a referência e entender tamanho/local".
- Quando chegar a referência (texto ou imagem), descreva a complexidade (sombras, detalhes, profundidade, encaixe, elementos) para justificar o valor.
- Seja vendedor: conduza para o próximo passo (tamanho, local do corpo, se quer preto e cinza, prazo) e para fechamento.
- Se o valor passar de 1000, o sinal é 100. Caso contrário, sinal é 10% do total. (não fale regra, só aplique quando for fechar)
- Agendamento é manual: quando o cliente topar, peça pra ele confirmar melhor dia/horário e avise que você manda as opções.
`.trim();

async function generateReply({ text, hasImage, imageAnalysis }) {
  const userMsg = [
    text ? `Mensagem do cliente: ${text}` : "Mensagem do cliente: (sem texto)",
    hasImage ? `O cliente enviou uma imagem. Análise técnica da imagem: ${imageAnalysis}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  const resp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.7,
    messages: [
      { role: "system", content: SYSTEM_STYLE },
      { role: "user", content: userMsg },
    ],
  });

  return resp.choices?.[0]?.message?.content?.trim() || "Me manda só mais um detalhe pra eu te passar certinho 🙏";
}

async function analyzeImageWithOpenAI({ b64, mime }) {
  const resp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.4,
    messages: [
      {
        role: "system",
        content:
          "Você é um tatuador especialista. Descreva a referência de forma técnica (luz/sombra, contraste, nível de detalhe, fundos, texturas, elementos), focando no que impacta a complexidade do trabalho. Não fale de preço nem horas.",
      },
      {
        role: "user",
        content: [
          { type: "text", text: "Descreve a referência e a complexidade." },
          {
            type: "image_url",
            image_url: { url: `data:${mime};base64,${b64}` },
          },
        ],
      },
    ],
  });

  return resp.choices?.[0]?.message?.content?.trim() || "";
}

app.get("/", (req, res) => res.status(200).send("OK"));

app.post("/zapi", async (req, res) => {
  try {
    const body = req.body || {};
    const { phone, text, messageType, imageUrl, imageMime } = normalizeIncoming(body);

    console.log("[ZAPI IN parsed]", { phone, messagePreview: (text || "").slice(0, 80), messageType, imageUrl: imageUrl ? "(present)" : "", imageMime });

    if (!phone) return res.status(200).json({ ok: true }); // evita erro se vier evento diferente

    // Anti-loop: se a última msg do bot foi igual e foi recente, não repete
    const cached = getCache(phone);

    let hasImage = false;
    let imageAnalysis = "";

    // Detecta imagem por tipo OU por URL presente
    if (imageUrl || (messageType && String(messageType).toLowerCase().includes("image"))) {
      hasImage = true;
      if (!imageUrl) {
        // Evento diz "imagem" mas não veio URL
        const msg = "Consegui ver que você mandou uma imagem, mas aqui pra mim não carregou certinho. Consegue reenviar como *foto* (não como documento) só pra eu avaliar direitinho?";
        if (!cached || cached.lastBotText !== msg) {
          await zapiSendText(phone, msg);
          setCache(phone, msg);
        }
        return res.status(200).json({ ok: true });
      }

      // Baixa e analisa imagem
      const { b64, mime } = await fetchAsBase64(imageUrl, imageMime);
      imageAnalysis = await analyzeImageWithOpenAI({ b64, mime });
    }

    // Se o cliente só falou "valor?" sem referência, guia sem ficar robótico
    const needsReference =
      !hasImage &&
      (!text || text.trim().length < 2 || /valor|preço|orc|orç/i.test(text));

    if (needsReference) {
      const msg =
        "Opa! Valeu por me chamar 🙏\nPra eu te passar certinho, me manda uma *referência em imagem* (pode ser foto/print) e me fala rapidinho:\n• local do corpo\n• tamanho aproximado (em cm)\n• se quer preto e cinza (realismo) ou mais desenho\nAí eu já te respondo com o orçamento bem certinho.";
      if (!cached || cached.lastBotText !== msg) {
        await zapiSendText(phone, msg);
        setCache(phone, msg);
      }
      return res.status(200).json({ ok: true });
    }

    // Gera resposta humana + vendedora
    const reply = await generateReply({ text, hasImage, imageAnalysis });

    if (!cached || cached.lastBotText !== reply) {
      await zapiSendText(phone, reply);
      setCache(phone, reply);
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("[WEBHOOK ERROR]", err?.message || err);
    return res.status(200).json({ ok: true }); // Z-API geralmente espera 200
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on ${port}`));
