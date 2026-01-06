import express from "express";

const app = express();

// ESSENCIAL para Twilio (Webhook)
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.post("/whatsapp", (req, res) => {
  console.log("CHEGOU DA TWILIO");
  console.log(req.body);
  res.status(200).send("ok");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Servidor rodando na porta", PORT);
});
