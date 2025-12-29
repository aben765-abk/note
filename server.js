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

app.use(cors());
app.use(express.json({ limit: '30mb' }));

// Initialisation de l'IA Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "AIzaSy_dummy_key");
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash-preview-09-2025" });

/**
 * Extrait le texte d'un PDF depuis une URL.
 * Désactive le rendu graphique pour éviter les crashs sur Railway.
 */
async function extractTextFromPdfUrl(url) {
    try {
        console.log(`[LOG] Téléchargement du PDF : ${url}`);
        const response = await axios.get(url, { 
            responseType: 'arraybuffer',
            timeout: 15000 
        });
        
        const options = {
            pagerender: function(pageData) {
                return pageData.getTextContent()
                    .then(function(textContent) {
                        return textContent.items.map(item => item.str).join(' ');
                    });
            }
        };

        const data = await pdfParse(response.data, options);
        response.data = null; 
        return data.text.substring(0, 15000); 
    } catch (error) {
        console.error(`[ERREUR PDF] Sur ${url} : ${error.message}`);
        return `[Le contenu de ce PDF n'a pas pu être extrait]`;
    }
}

/**
 * Extrait le contenu textuel d'une page Web (HTML).
 * Nettoie les balises scripts, styles et HTML pour ne garder que le texte utile.
 */
async function extractTextFromWebUrl(url) {
    try {
        console.log(`[LOG] Extraction de la page Web : ${url}`);
        // Ajout d'un User-Agent pour éviter d'être bloqué par certains sites
        const response = await axios.get(url, { 
            timeout: 10000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            }
        });
        
        const html = response.data;
        if (typeof html !== 'string') return "[Format de page non supporté]";

        const cleanText = html
            .replace(/<script\b[^>]*>([\s\S]*?)<\/script>/gim, "") // Supprime les scripts
            .replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gim, "")   // Supprime les styles
            .replace(/<[^>]+>/g, ' ')                             // Supprime les balises HTML
            .replace(/\s+/g, ' ')                                  // Nettoie les espaces multiples
            .trim();

        return cleanText.substring(0, 15000); 
    } catch (error) {
        console.error(`[ERREUR URL] Sur ${url} : ${error.message}`);
        return `[Impossible de lire le contenu de ce lien : ${error.message}]`;
    }
}

/**
 * Point d'entrée principal pour le chat et l'analyse
 */
app.post('/api/chat', async (req, res) => {
    const { question, documents } = req.body;

    if (!question || !documents || !Array.isArray(documents)) {
        return res.status(400).json({ error: "Requête invalide ou documents manquants." });
    }

    try {
        console.log(`[API] Requête reçue. Analyse de ${documents.length} sources.`);
        let contextParts = [];

        // Traitement séquentiel pour la stabilité de la RAM
        for (const doc of documents) {
            let content = doc.content || "";
            
            // Cas 1 : Le document est un PDF et nécessite une extraction
            if (doc.type === 'PDF' && doc.url && content.length < 50) {
                content = await extractTextFromPdfUrl(doc.url);
            } 
            // Cas 2 : Le document est une URL externe
            else if (doc.type === 'URL' && (doc.title.startsWith('http') || doc.url)) {
                const targetUrl = doc.url || doc.title;
                content = await extractTextFromWebUrl(targetUrl);
            }
            
            contextParts.push(`SOURCE: ${doc.title}\nCONTENU: ${content}`);
        }

        const fullContext = contextParts.join('\n\n---\n\n');

        const systemPrompt = `Tu es un assistant de recherche expert. 
        Réponds à la question de l'utilisateur en te basant sur le contexte fourni.
        Cite systématiquement le titre de la source.
        Si l'information n'est pas présente, dis que tu ne sais pas.

        CONTEXTE :
        ${fullContext}`;

        const result = await model.generateContent([
            { text: systemPrompt },
            { text: `Question : ${question}` }
        ]);

        const aiResponse = await result.response;
        res.json({ answer: aiResponse.text() });

    } catch (error) {
        console.error("[ERREUR SERVEUR]", error);
        res.status(500).json({ error: "Erreur lors de l'analyse.", details: error.message });
    }
});

// Route de santé pour Railway
app.get('/health', (req, res) => res.status(200).send('OK'));

app.listen(port, '0.0.0.0', () => {
    console.log(`[READY] Serveur Notebook AI actif sur le port ${port}`);
});