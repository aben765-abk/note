const express = require('express');
const cors = require('cors');
const axios = require('axios');
const pdfParse = require('pdf-parse');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
const port = process.env.PORT || 3001;

// Vérification de la configuration au démarrage
if (!process.env.GEMINI_API_KEY) {
    console.error("ERREUR CRITIQUE : La variable d'environnement GEMINI_API_KEY est absente.");
}

// Middleware pour gérer les requêtes volumineuses (nécessaire pour le contexte des documents)
app.use(cors());
app.use(express.json({ limit: '30mb' }));

// Initialisation de l'IA Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "AIzaSy_dummy_key");
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash-preview-09-2025" });

/**
 * Extrait le texte d'un PDF depuis une URL WordPress de manière stable.
 * Utilise un moteur de rendu minimal pour éviter les erreurs de bibliothèques natives sur Railway.
 */
async function extractTextFromPdfUrl(url) {
    try {
        console.log(`[LOG] Téléchargement du PDF : ${url}`);
        const response = await axios.get(url, { 
            responseType: 'arraybuffer',
            timeout: 12000 // Timeout de 12 secondes
        });
        
        // Options pour désactiver le rendu visuel (évite l'erreur @napi-rs/canvas)
        const options = {
            pagerender: function(pageData) {
                return pageData.getTextContent()
                    .then(function(textContent) {
                        return textContent.items.map(item => item.str).join(' ');
                    });
            }
        };

        const data = await pdfParse(response.data, options);
        
        // Nettoyage manuel pour aider le Garbage Collector
        response.data = null; 
        
        // On limite l'extraction aux 15 000 premiers caractères pour la stabilité du prompt
        return data.text.substring(0, 15000); 
    } catch (error) {
        console.error(`[ERREUR PDF] Sur ${url} : ${error.message}`);
        return `[Le contenu de ce document PDF n'a pas pu être extrait : ${error.message}]`;
    }
}

/**
 * Point d'entrée principal pour le chat
 */
app.post('/api/chat', async (req, res) => {
    const { question, documents } = req.body;

    if (!question || !documents || !Array.isArray(documents)) {
        return res.status(400).json({ error: "Requête invalide ou documents manquants." });
    }

    try {
        console.log(`[API] Traitement d'une question. Nombre de sources : ${documents.length}`);
        let contextParts = [];

        // Traitement séquentiel (un par un) pour éviter les pics de mémoire sur Railway
        for (const doc of documents) {
            let content = doc.content || "";
            
            // Si c'est un PDF sans texte pré-extrait, on lance l'extraction
            if (doc.type === 'PDF' && doc.url && content.length < 50) {
                content = await extractTextFromPdfUrl(doc.url);
            }
            
            contextParts.push(`SOURCE: ${doc.title}\nCONTENU: ${content}`);
        }

        const fullContext = contextParts.join('\n\n---\n\n');

        const systemPrompt = `Tu es un assistant de recherche expert. 
        Réponds à la question de l'utilisateur en te basant UNIQUEMENT sur le contexte fourni ci-dessous.
        Cite systématiquement le titre de la source pour chaque information donnée.
        Si la réponse ne figure pas dans les documents, indique-le clairement.

        CONTEXTE :
        ${fullContext}`;

        // Appel à Gemini
        const result = await model.generateContent([
            { text: systemPrompt },
            { text: `Question de l'utilisateur : ${question}` }
        ]);

        const aiResponse = await result.response;
        res.json({ answer: aiResponse.text() });

    } catch (error) {
        console.error("[ERREUR SERVEUR]", error);
        res.status(500).json({ 
            error: "Erreur lors de l'analyse par l'IA.", 
            details: error.message 
        });
    }
});

// Route de santé pour le monitoring de Railway
app.get('/health', (req, res) => res.status(200).send('OK'));

app.listen(port, '0.0.0.0', () => {
    console.log(`[READY] Serveur Notebook AI opérationnel sur le port ${port}`);
});