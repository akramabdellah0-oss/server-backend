// server.js

// 1. Imports et Initialisation
const express = require('express');
// La clé secrète STRIPE_SECRET_KEY est lue depuis les variables d'environnement de Railway
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY); 
const { Pool } = require('pg');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// Configuration de la connexion à la base de données PostgreSQL
// DATABASE_URL est injectée automatiquement par Railway
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    // Nécessaire pour les connexions sécurisées (SSL) sur Railway
    ssl: { rejectUnauthorized: false } 
});

// --- Configuration CORS (Sécurité) ---
// Liste blanche des domaines/origines autorisés à appeler cette API
const allowedOrigins = [
    process.env.CLIENT_DOMAIN, // Votre domaine public Railway pour les redirections
    // L'ID de votre extension Chrome (REMINDER: À RENSEIGNER DANS LES VARIABLES RAILWAY)
    process.env.CHROME_EXTENSION_ID 
];

app.use(cors({
    origin: (origin, callback) => {
        // Autorise les requêtes sans 'origin' (ex: Service Worker) et les origines de confiance
        if (!origin || allowedOrigins.includes(origin) || origin.startsWith('chrome-extension://')) {
            callback(null, true);
        } else {
            callback(new Error('Not allowed by CORS'));
        }
    }
}));


// Middleware pour analyser les corps JSON entrants (sauf pour le webhook qui est géré séparément)
app.use(express.json()); 


// ===============================================
// ROUTES API - DÉFINITION
// ===============================================

// Fonction utilitaire pour trouver le Price ID Stripe
// REMPLACER price_VOTRE_ID_... par vos ID réels depuis Stripe
function getPriceId(plan) {
    switch (plan) {
        case 'Plus':
            return 'price_VOTRE_ID_PRICE_PLUS'; 
        case 'Pro':
            return 'price_VOTRE_ID_PRICE_PRO'; 
        default:
            return null;
    }
}


// ROUTE 1 : Création de Session de Paiement (Appelée par l'extension)
app.post('/api/create-checkout', async (req, res) => {
    // 1. Récupération des données envoyées par l'extension
    const { plan, googleUserId } = req.body; 

    if (!plan || !googleUserId) {
        return res.status(400).json({ error: "Missing plan or user ID" });
    }

    const priceId = getPriceId(plan);
    if (!priceId) {
        return res.status(400).json({ error: "Invalid plan specified" });
    }

    // L'URL de succès et d'annulation utilise le domaine public Railway
    const domain = process.env.CLIENT_DOMAIN;
    const successUrl = `${domain}/payment-success.html?session_id={CHECKOUT_SESSION_ID}`;
    const cancelUrl = `${domain}/payment-cancel.html`;

    try {
        const session = await stripe.checkout.sessions.create({
            mode: 'subscription',
            line_items: [{ price: priceId, quantity: 1 }],
            
            // Stocke l'ID utilisateur Google dans la session Stripe
            client_reference_id: googleUserId, 
            
            // URL de redirection
            success_url: successUrl,
            cancel_url: cancelUrl,
            
            payment_method_types: ['card', 'paypal'], 
        });

        // Renvoyer l'URL de paiement à l'extension
        res.status(200).json({ checkoutUrl: session.url });

    } catch (error) {
        console.error("Stripe Checkout Error:", error);
        res.status(500).json({ error: "Failed to create checkout session" });
    }
});

// ROUTE 2 : Webhook Stripe (Sera implémentée à l'étape suivante)
// Note: Le middleware express.json() ne doit PAS être utilisé ici, 
// nous devons lire le buffer brut pour la validation.

// app.post('/api/stripe-webhook', express.raw({type: 'application/json'}), async (req, res) => {
//     // ... Logique de vérification et de mise à jour de licence ...
// });

// ROUTE 3 : Vérification de Licence (Sera implémentée à l'étape suivante)
// app.get('/api/check-license', async (req, res) => {
//     // ... Logique de lecture de licence dans la DB ...
// });


// 4. Démarrage du serveur
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});