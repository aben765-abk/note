const express = require('express');
const cors = require('cors');
const axios = require('axios');
const pdfParse = require('pdf-parse');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
const port = process.env.PORT || 3001;

// Vérification de la clé API au démarrage pour éviter un crash silencieux plus tard
if (!process.env.GEMINI_API_KEY) {
    console.error("ERREUR FATALE : La variable GEMINI_API_KEY est manquante dans Railway.");
}

app.use(cors());
app.use(express.json({ limit: '30mb' }));

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "dummy_key");
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash-preview-09-2025" });

/**
 * Extraction PDF optimisée pour limiter l'usage de la RAM au strict minimum
 */
async function extractTextFromPdfUrl(url) {
    try {
        console.log(`[LOG] Téléchargement PDF : ${url}`);
        const response = await axios.get(url, { 
            responseType: 'arraybuffer',
            timeout: 10000 
        });
        
        // On n'utilise pas d'options de rendu personnalisées ici pour éviter les fuites mémoire
        const data = await pdfParse(response.data);
        return data.text.substring(0, 15000); // On limite à 15k caractères par PDF pour la stabilité
    } catch (error) {
        console.error(`[ERREUR] Impossible de lire le PDF : ${error.message}`);
        return `[Contenu du document ${url} non accessible]`;
    }
}

app.post('/api/chat', async (req, res) => {
    const { question, documents } = req.body;

    if (!question || !documents) {
        return res.status(400).json({ error: "Requête malformée" });
    }

    try {
        let contextParts = [];

        // Traitement synchrone/séquentiel pour Railway (évite les pics de CPU)
        for (const doc of documents) {
            let content = doc.content || "";
            if (doc.type === 'PDF' && doc.url && content.length < 50) {
                content = await extractTextFromPdfUrl(doc.url);
            }
            contextParts.push(`SOURCE: ${doc.title}\nCONTENU: ${content}`);
        }

        const systemPrompt = `Tu es un assistant de recherche. Réponds en utilisant le contexte suivant. 
        Cite les sources. Si tu ne sais pas, dis-le.\n\nCONTEXTE :\n${contextParts.join('\n\n')}`;

        const result = await model.generateContent([
            { text: systemPrompt },
            { text: question }
        ]);

        const response = await result.response;
        res.json({ answer: response.text() });

    } catch (error) {
        console.error("[ERREUR API]", error);
        res.status(500).json({ error: "Erreur serveur", details: error.message });
    }
});

// Route de santé pour que Railway sache que le serveur est vivant
app.get('/health', (req, res) => res.send('OK'));

app.listen(port, '0.0.0.0', () => {
    console.log(`[SUCCESS] Serveur Notebook AI démarré sur le port ${port}`);
});