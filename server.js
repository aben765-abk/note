const express = require('express');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const cors = require('cors');
const axios = require('axios'); // Ajouté pour télécharger les PDF par URL
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
const port = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: '50mb' })); // Augmenté pour les gros documents

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash-preview-09-2025" });

/**
 * Fonction utilitaire pour extraire le texte d'un PDF à partir d'une URL
 */
async function extractTextFromPdfUrl(url) {
    try {
        const response = await axios.get(url, { responseType: 'arraybuffer' });
        const data = await pdfParse(response.data);
        return data.text;
    } catch (error) {
        console.error(`Erreur extraction PDF (${url}):`, error);
        return "[Erreur lors de la lecture de ce PDF]";
    }
}

app.post('/api/chat', async (req, res) => {
    const { question, documents } = req.body;

    if (!question || !documents) {
        return res.status(400).json({ error: "Données manquantes" });
    }

    try {
        // Traitement asynchrone de tous les documents (WP, URL, PDF)
        const processedDocs = await Promise.all(documents.map(async (doc) => {
            let content = doc.content || "";
            
            // Si c'est un PDF et qu'on a une URL mais pas encore de contenu extrait
            if (doc.type === 'PDF' && doc.url && !doc.content) {
                content = await extractTextFromPdfUrl(doc.url);
            }
            
            return `[Source: ${doc.title} (${doc.type})]\n${content}`;
        }));

        const context = processedDocs.join('\n\n---\n\n');
        
        const systemPrompt = `Tu es un assistant expert. Réponds de manière précise en utilisant UNIQUEMENT le contexte suivant. Si la réponse n'est pas dans les documents, dis-le.
        
        CONTEXTE :
        ${context}`;

        const result = await model.generateContent([
            { text: systemPrompt },
            { text: `Question de l'utilisateur : ${question}` }
        ]);

        const response = await result.response;
        res.json({ answer: response.text() });

    } catch (error) {
        console.error("Erreur API Gemini:", error);
        res.status(500).json({ error: "Erreur lors du traitement de la requête" });
    }
});

app.listen(port, () => {
    console.log(`Serveur prêt sur le port ${port}`);
});