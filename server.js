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
 * Nettoie le HTML pour extraire le texte brut
 */
function cleanHtml(html) {
    return html
        .replace(/<script\b[^>]*>([\s\S]*?)<\/script>/gim, "")
        .replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gim, "")
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Extrait le contenu textuel d'une page Web et explore les liens internes (Crawling léger)
 * @param {string} baseUrl - L'URL de départ
 * @param {number} maxPages - Nombre maximum de pages à explorer (Mis à 6)
 */
async function extractTextFromWebUrl(baseUrl, maxPages = 6) {
    const visited = new Set();
    const toVisit = [baseUrl];
    let aggregatedText = "";
    const domain = new URL(baseUrl).hostname;

    console.log(`[LOG] Début de l'exploration multi-pages (limite: ${maxPages}) pour : ${baseUrl}`);

    while (toVisit.length > 0 && visited.size < maxPages) {
        const url = toVisit.shift();
        if (visited.has(url)) continue;

        try {
            visited.add(url);
            const response = await axios.get(url, { 
                timeout: 8000,
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
            });

            const html = response.data;
            if (typeof html !== 'string') continue;

            // Ajouter le texte de la page actuelle
            aggregatedText += `\n--- CONTENU DE LA PAGE : ${url} ---\n`;
            aggregatedText += cleanHtml(html).substring(0, 8000);

            // Trouver de nouveaux liens sur la même page (liens internes uniquement)
            if (visited.size < maxPages) {
                const linkRegex = /href="([^"]+)"/g;
                let match;
                while ((match = linkRegex.exec(html)) !== null) {
                    try {
                        let link = match[1];
                        if (link.startsWith('/')) link = new URL(link, baseUrl).href;
                        
                        const linkUrl = new URL(link);
                        // On vérifie que le lien est sur le même domaine et n'a pas encore été visité
                        if (linkUrl.hostname === domain && !visited.has(link) && !toVisit.includes(link)) {
                            toVisit.push(link);
                        }
                    } catch (e) { /* Lien invalide ignoré */ }
                }
            }
        } catch (error) {
            console.error(`[ERREUR EXPLORATION] ${url} : ${error.message}`);
        }
    }

    // Augmentation de la limite à 40 000 caractères pour supporter les 6 pages
    return aggregatedText.substring(0, 40000); 
}

/**
 * Point d'entrée principal pour le chat
 */
app.post('/api/chat', async (req, res) => {
    const { question, documents } = req.body;

    if (!question || !documents || !Array.isArray(documents)) {
        return res.status(400).json({ error: "Requête invalide." });
    }

    try {
        console.log(`[API] Analyse de ${documents.length} sources.`);
        let contextParts = [];

        for (const doc of documents) {
            let content = doc.content || "";
            
            if (doc.type === 'PDF' && doc.url && content.length < 50) {
                content = await extractTextFromPdfUrl(doc.url);
            } 
            else if (doc.type === 'URL' && (doc.title.startsWith('http') || doc.url)) {
                const targetUrl = doc.url || doc.title;
                // Exploration de 6 pages maximum par URL configurée ici
                content = await extractTextFromWebUrl(targetUrl, 6);
            }
            
            contextParts.push(`SOURCE: ${doc.title}\nCONTENU: ${content}`);
        }

        const fullContext = contextParts.join('\n\n---\n\n');

        const systemPrompt = `Tu es un assistant de recherche expert. 
        Réponds à la question en te basant sur le contexte fourni. 
        Le contexte contient plusieurs pages explorées pour chaque site web (jusqu'à 6 pages par source).
        Cite précisément les sources. Si l'information est manquante, dis-le.

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

app.get('/health', (req, res) => res.status(200).send('OK'));

app.listen(port, '0.0.0.0', () => {
    console.log(`[READY] Serveur Notebook AI actif avec exploration étendue (6 pages).`);
});