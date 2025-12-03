// Import dependencies
const express = require('express');
const bodyParser = require('body-parser'); // 1. Importer body-parser
const Stripe = require('stripe'); // 1. Importer Stripe
const sgMail = require('@sendgrid/mail'); // 🔴 REMPLACER nodemailer
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const cors = require('cors');

// Load environment variables from .env file
require('dotenv').config();

const app = express();

// --- FIX FOR RENDER/LOAD BALANCERS ---
// Tell Express to trust the proxy (Render Load Balancer) so rate-limiter gets the real IP
// This fixes the "ValidationError: The 'X-Forwarded-For' header is set..." error.
app.set('trust proxy', 1);

// --- WEBHOOK PARSING ---
// Le webhook de Stripe a besoin du "raw body", donc nous utilisons bodyParser.raw
// pour cet endpoint spécifique, AVANT `express.json()`.
app.post('/api/stripe-webhook', bodyParser.raw({type: 'application/json'}), handleStripeWebhook);

// Middlewares
app.use(cors({ origin: '*' })); // Allow all origins for development. Restrict in production.
app.use(express.json());

// --- IN-MEMORY DATABASES ---
// Note: In production, replace these with a real database (MongoDB, PostgreSQL, etc.)
const verificationCodes = {};
const userSubscriptions = {}; // Stores license status: { 'email@example.com': { isPremium: true, plan: 'Pro' } }

// --- SendGrid Configuration ---
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
if (SENDGRID_API_KEY) {
    sgMail.setApiKey(SENDGRID_API_KEY);
    console.log('✅ SendGrid API key configured.');
} else {
    console.warn('⚠️  SendGrid API key not found. Email functionality will be disabled.');
    console.log('ℹ️  To enable emails, add SENDGRID_API_KEY to environment variables');
}

// --- Stripe Configuration ---
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
let stripe;
if (STRIPE_SECRET_KEY) {
    stripe = new Stripe(STRIPE_SECRET_KEY);
    console.log('✅ Stripe API key configured.');
} else {
    console.warn('⚠️  Stripe API key not found. Payment functionality will be disabled.');
}

// Rate limiter to prevent abuse
const sendCodeLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 5, // Limit each IP to 5 requests per windowMs
    message: "Too many requests, please try again later.",
});

// --- API ENDPOINTS ---

/**
 * 1. Generate and send verification code
 */
app.post('/api/send-verification-code', sendCodeLimiter, async (req, res) => {
    const { email } = req.body;

    if (!email) {
        return res.status(400).json({ error: 'Email is required' });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
        return res.status(400).json({ error: 'Invalid email format' });
    }

    // Generate a 6-digit code
    const code = crypto.randomInt(100000, 999999).toString();

    // Save the code with a 10-minute expiration
    verificationCodes[email] = { code, expiresAt: Date.now() + 10 * 60 * 1000 };

    // Check if SendGrid is configured
    if (!SENDGRID_API_KEY) {
        console.warn(`⚠️  SendGrid not configured. Mock code for ${email}: ${code}`);
        // In development, you can return the code for testing
        if (process.env.NODE_ENV !== 'production') {
            return res.json({ 
                success: true, 
                message: 'Development mode: Email service not configured.',
                debugCode: code // Only return in non-production!
            });
        } else {
            return res.status(503).json({ 
                error: 'Email service is temporarily unavailable. Please try again later.' 
            });
        }
    }

    try {
        console.log(`📧 Attempting to send verification code to ${email}...`);

        const mailOptions = {
            // IMPORTANT: Use a verified sender email in SendGrid
            from: { name: 'Autofill App', email: process.env.EMAIL_FROM || 'noreply@yourverifieddomain.com' },
            to: email,
            subject: 'Your Verification Code',
            text: `Your verification code is: ${code}\n\nThis code will expire in 10 minutes.`,
            html: `
                <div style="font-family: Arial, sans-serif; padding: 20px;">
                    <h2>Your Verification Code</h2>
                    <p>Use this code to verify your email address:</p>
                    <div style="font-size: 32px; font-weight: bold; color: #333; margin: 20px 0; padding: 15px; background: #f5f5f5; border-radius: 8px; text-align: center; letter-spacing: 5px;">
                        ${code}
                    </div>
                    <p><small>This code will expire in 10 minutes.</small></p>
                    <p style="color: #666; font-size: 12px; margin-top: 30px;">
                        If you didn't request this code, please ignore this email.
                    </p>
                </div>
            `
        };

        console.log('📧 Sending via SendGrid to:', email);

        // Utiliser sgMail.send() au lieu de transporter.sendMail()
        await sgMail.send(mailOptions);

        console.log(`✅ Verification code sent to ${email}`);

        res.json({ success: true, message: 'Verification code sent.' });
    } catch (error) {
        console.error('❌ SendGrid API Error:', error.message);
        if (error.response) {
            console.error(error.response.body);
        }

        res.status(500).json({ 
            error: 'Failed to send verification code. Please try again.',
            details: process.env.NODE_ENV !== 'production' ? error.message : undefined
        });
    }
});

/**
 * 2. Verify the code
 */
app.post('/api/verify-code', (req, res) => {
    const { email, code } = req.body;

    if (!email || !code) return res.status(400).json({ error: 'L\'e-mail et le code sont requis.' });

    const record = verificationCodes[email];

    if (!record) return res.status(400).json({ error: 'Aucun code de vérification trouvé pour cet e-mail. Veuillez en demander un nouveau.' });
    if (record.expiresAt < Date.now()) {
        delete verificationCodes[email];
        return res.status(400).json({ error: 'Le code de vérification a expiré. Veuillez en demander un nouveau.' });
    }
    if (record.code !== code) return res.status(400).json({ error: 'Code de vérification invalide.' });

    // Code is valid. Initialize user in DB if not exists.
    delete verificationCodes[email];
    
    if (!userSubscriptions[email]) {
        userSubscriptions[email] = { isPremium: false, plan: 'Free' };
    }

    console.log(`✅ Email verified: ${email}`);
    res.json({ success: true, message: 'E-mail vérifié avec succès.' });
});

/**
 * 3. Check License Status (Called by App.tsx)
 */
app.get('/api/check-license', (req, res) => {
    const { user_id } = req.query; // This is the email
    
    if (!user_id) return res.status(400).json({ error: 'User ID required' });

    const user = userSubscriptions[user_id];

    if (user && user.isPremium) {
        return res.json({ is_premium: true, plan: user.plan });
    }

    // Default to free
    return res.json({ is_premium: false, plan: 'Free' });
});

/**
 * 4. Create Checkout Session (Called by Pricing.tsx)
 * This is the REAL implementation using Stripe.
 */
app.post('/api/create-checkout-session', async (req, res) => {
    const { priceId, userId, successUrl, cancelUrl } = req.body;
    try {
        // Create a new checkout session with Stripe
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [
                {
                    price: priceId,
                    quantity: 1,
                },
            ],
            mode: 'subscription',
            success_url: successUrl, // URL de redirection en cas de succès
            cancel_url: cancelUrl,   // URL de redirection en cas d'annulation
            // Associer la session à l'e-mail de l'utilisateur
            customer_email: userId,
        });

        console.log(`✅ Stripe session created: ${session.id}`);
        // Renvoyer l'URL de la session de paiement au client
        res.json({ url: session.url });

    } catch (error) {
        console.error('❌ Stripe Error:', error.message);
        res.status(500).json({ error: 'Failed to create payment session.' });
    }
});

/**
 * 5. Stripe Webhook Handler
 * Stripe appelle cet endpoint pour notifier des événements (ex: paiement réussi).
 */
async function handleStripeWebhook(req, res) {
    if (!STRIPE_WEBHOOK_SECRET) {
        console.error('❌ Stripe webhook secret not configured.');
        return res.status(400).send('Webhook Error: Missing secret.');
    }

    const sig = req.headers['stripe-signature'];
    let event;

    try {
        event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
    } catch (err) {
        console.error(`❌ Webhook signature verification failed:`, err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Gérer l'événement
    switch (event.type) {
        case 'checkout.session.completed':
            const session = event.data.object;
            console.log('✅ Checkout session completed:', session.id);
            
            const userEmail = session.customer_email;
            if (userEmail) {
                // Mettre à jour le statut de l'utilisateur dans notre "base de données"
                userSubscriptions[userEmail] = {
                    isPremium: true,
                    plan: 'Pro' // Vous pouvez obtenir le plan exact depuis la session
                };
                console.log(`🌟 Subscription ACTIVATED for ${userEmail}`);
            }
            break;
        // ... gérer d'autres événements si nécessaire
        default:
            console.log(`🔔 Unhandled event type ${event.type}`);
    }

    // Renvoyer une réponse 200 pour accuser réception à Stripe
    res.json({ received: true });
}

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📧 Email service: ${SENDGRID_API_KEY ? 'SendGrid (API Ready)' : 'Disabled - No API Key'}`);
    console.log(`💳 Payment service: ${STRIPE_SECRET_KEY ? 'Stripe (Ready)' : 'Disabled - No API Key'}`);
    console.log(`� Endpoints:`);
    console.log(`   POST /api/send-verification-code`);
    console.log(`   POST /api/verify-code`);
    console.log(`   GET  /api/check-license`);
    console.log(`   POST /api/create-checkout-session`);
    console.log(`   POST /api/stripe-webhook`);
});