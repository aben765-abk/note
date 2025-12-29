const express = require('express');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
const port = process.env.PORT || 3001;

// Configuration
app.use(cors());
app.use(express.json());
const upload = multer({ storage: multer.memoryStorage() });

// Initialisation de Gemini (Côté serveur pour la sécurité)
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash-preview-09-2025" });

/**
 * Endpoint 1: Extraire le texte d'un PDF
 * Utile si vous voulez traiter l'indexation côté serveur
 */
app.post('/api/extract-pdf', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).send('Aucun fichier uploadé.');
    
    const data = await pdfParse(req.file.buffer);
    res.json({
      title: req.file.originalname,
      text: data.text,
      pageCount: data.numpages
    });
  } catch (error) {
    res.status(500).json({ error: "Erreur lors de l'extraction PDF" });
  }
});

/**
 * Endpoint 2: Chat avec contexte
 * Reçoit une liste de documents et une question
 */
app.post('/api/chat', async (req, res) => {
  const { question, documents } = req.body;

  if (!question || !documents) {
    return res.status(400).json({ error: "Données manquantes" });
  }

  try {
    const context = documents.map(doc => `[Source: ${doc.title}]\n${doc.content}`).join('\n\n');
    const systemPrompt = `Tu es un assistant de recherche. Réponds UNIQUEMENT sur la base de :\n${context}`;

    const chat = model.startChat({
      history: [
        { role: "user", parts: [{ text: systemPrompt }] },
        { role: "model", parts: [{ text: "Compris. Je répondrai uniquement sur la base de ces documents." }] }
      ]
    });

    const result = await chat.sendMessage(question);
    const response = await result.response;
    
    res.json({ answer: response.text() });
  } catch (error) {
    res.status(500).json({ error: "Erreur lors de l'appel à l'IA" });
  }
});

app.listen(port, () => {
  console.log(`API Notebook AI lancée sur http://localhost:${port}`);
});
