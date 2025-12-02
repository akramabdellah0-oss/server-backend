// server.js - VERSION MISE À JOUR

// Charger les variables d'environnement uniquement en développement
if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}

const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY); 
const { Pool } = require('pg');
const cors = require('cors');
const nodemailer = require('nodemailer');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// Configuration de la base de données PostgreSQL
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// Stockage temporaire des codes de vérification
// Pour la production, il est recommandé d'utiliser une base de données comme Redis
const verificationCodes = new Map();

// Configuration de Nodemailer (pour l'envoi d'e-mails)
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER, // 🔴 Votre adresse e-mail depuis .env
    pass: process.env.EMAIL_PASS  // 🔴 Votre mot de passe d'application depuis .env
  }
});

app.use(cors());

// --- WEBHOOK STRIPE (doit être avant express.json) ---
app.post('/webhook', express.raw({type: 'application/json'}), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;
    let event;

    try {
        event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
    } catch (err) {
        console.error(`❌ Webhook Error: ${err.message}`);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Gérer l'événement checkout.session.completed
    if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        const userEmail = session.metadata.user_email; // Utiliser l'e-mail depuis les métadonnées
        const stripeCustomerId = session.customer;

        if (!userEmail) {
            console.error("❌ Webhook Error: user_email manquant dans les métadonnées de la session.");
            return res.status(400).send('Webhook Error: Missing user_email in session metadata.');
        }

        try {
            const query = `
                INSERT INTO users (email, is_premium, stripe_customer_id, updated_at)
                VALUES ($1, true, $2, NOW())
                ON CONFLICT (email) 
                DO UPDATE SET is_premium = true, stripe_customer_id = $2, updated_at = NOW();
            `;
            await pool.query(query, [userEmail, stripeCustomerId]);
            console.log(`✅ Licence activée pour ${userEmail}`);
        } catch (err) { 
            console.error("❌ Erreur de base de données lors de l'activation de la licence:", err); 
        }
    }
    
    res.json({received: true});
});

app.use(express.json());

// --- ROUTE DE CRÉATION DE SESSION DE PAIEMENT ---
app.post('/api/create-checkout-session', async (req, res) => {
    console.log("💰 Requête de paiement reçue:", req.body);

    const { priceId, userId } = req.body; // userId est maintenant un e-mail

    if (!priceId || !userId) {
        return res.status(400).json({ error: "priceId ou userId manquant" });
    }

    try {
        const session = await stripe.checkout.sessions.create({
            mode: 'subscription',
            payment_method_types: ['card'],
            line_items: [{ price: priceId, quantity: 1 }],
            customer_email: userId, // Pré-remplir l'e-mail du client dans Stripe
            metadata: { 
                user_email: userId // Stocker l'e-mail pour le webhook
            },
            success_url: 'https://www.google.com?payment_success=true',
            cancel_url: 'https://www.google.com?payment_cancelled=true',
        });

        res.json({ url: session.url });

    } catch (error) {
        console.error("❌ Erreur Stripe:", error.message);
        res.status(500).json({ error: error.message });
    }
});

// --- ROUTE D'ENVOI DE CODE DE VÉRIFICATION ---
app.post('/api/send-verification-code', async (req, res) => {
    const { email } = req.body;
    if (!email) {
        return res.status(400).json({ success: false, message: 'E-mail requis.' });
    }

    try {
        const code = crypto.randomBytes(3).toString('hex').toUpperCase();
        const expiration = Date.now() + 5 * 60 * 1000; // Expire dans 5 minutes

        verificationCodes.set(email, { code, expiration });
        console.log(`Code généré pour ${email}: ${code}`);

        const mailOptions = {
            from: '"Autofill" <' + process.env.EMAIL_USER + '>',
            to: email,
            subject: 'Autofill: Your verification code',
            html: `<h3>Enter this code to proceed to checkout:</h3><p style="font-size: 20px; font-weight: bold;">${code}</p><p><small>Security notice: This code will expire in 5 minutes.</small></p>`
        };

        await transporter.sendMail(mailOptions);
        console.log(`E-mail de vérification envoyé à ${email}`);
        res.status(200).json({ success: true, message: 'Code de vérification envoyé.' });

    } catch (error) {
        console.error("❌ Erreur lors de l'envoi de l'e-mail:", error);
        res.status(500).json({ success: false, message: "Échec de l'envoi de l'e-mail." });
    }
});

// --- ROUTE DE VÉRIFICATION DU CODE D'E-MAIL ---
app.post('/api/verify-email-code', (req, res) => {
    const { email, code } = req.body;
    const stored = verificationCodes.get(email);

    if (stored && stored.code === code && Date.now() < stored.expiration) {
        verificationCodes.delete(email); // Le code est utilisé, on le supprime
        res.status(200).json({ success: true, message: 'E-mail vérifié avec succès.' });
    } else {
        res.status(400).json({ success: false, message: 'Code de vérification invalide ou expiré.' });
    }
});

// --- ROUTE DE VÉRIFICATION DE LICENCE ---
app.get('/api/check-license', async (req, res) => {
    const { user_id } = req.query; // user_id est maintenant un e-mail
    if (!user_id) return res.status(400).json({ error: "User ID (email) requis" });

    try {
        const result = await pool.query('SELECT is_premium FROM users WHERE email = $1', [user_id]);
        if (result.rows.length > 0 && result.rows[0].is_premium) {
            return res.json({ is_premium: true, plan: 'Premium' });
        }
        return res.json({ is_premium: false, plan: 'Free' });
    } catch (err) {
        console.error("❌ Erreur de base de données lors de la vérification de la licence:", err);
        res.status(500).json({ error: "Erreur de base de données" });
    }
});

app.listen(PORT, () => {
    console.log(`🚀 Serveur démarré sur le port ${PORT}`);
});
