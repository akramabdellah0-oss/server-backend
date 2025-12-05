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
const sharedRules = {}; // Stores shared rules: { shareId: { fromEmail, toEmail, rule, expiresAt, used } }

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
    
    console.log('🎫 License check request for user:', user_id);
    
    if (!user_id) {
        console.log('❌ No user_id provided');
        return res.status(400).json({ error: 'User ID required' });
    }

    const user = userSubscriptions[user_id];
    
    console.log('👤 User subscription data:', user);

    if (user && user.isPremium) {
        const planData = { is_premium: true, plan: user.plan || 'Pro' };
        console.log('✅ Returning premium plan:', planData);
        return res.json(planData);
    }

    // Default to free
    const freeData = { is_premium: false, plan: 'Free' };
    console.log('🆓 Returning free plan:', freeData);
    return res.json(freeData);
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
            console.log('📧 Customer email from session:', userEmail);
            
            if (userEmail) {
                // Determine plan based on price ID
                let planName = 'Pro'; // Default
                if (session.line_items && session.line_items.data && session.line_items.data.length > 0) {
                    const priceId = session.line_items.data[0].price.id;
                    console.log('💰 Price ID from session:', priceId);
                    // Map price IDs to plan names (you'll need to update these with your actual price IDs)
                    if (priceId === 'price_1SXINCJdBDLWAyB09C5II34Q') {
                        planName = 'Plus';
                    } else if (priceId === 'price_1SXIM2JdBDLWAyB0cVOcC25x') {
                        planName = 'Pro';
                    }
                    console.log('🏷️ Determined plan name:', planName);
                }
                
                // Mettre à jour le statut de l'utilisateur dans notre "base de données"
                userSubscriptions[userEmail] = {
                    isPremium: true,
                    plan: planName
                };
                console.log(`🌟 Subscription ACTIVATED for ${userEmail} (${planName})`);
                console.log('💾 Updated user subscriptions:', userSubscriptions);
            }
            break;
        // ... gérer d'autres événements si nécessaire
        default:
            console.log(`🔔 Unhandled event type ${event.type}`);
    }

    // Renvoyer une réponse 200 pour accuser réception à Stripe
    res.json({ received: true });
}

// --- RULE SHARING ENDPOINTS ---

/**
 * 6. Share a rule with another user
 */
app.post('/api/share-rule', (req, res) => {
    const { fromEmail, toEmail, rule, expireMinutes } = req.body;

    if (!fromEmail || !toEmail || !rule) {
        return res.status(400).json({ error: 'fromEmail, toEmail, and rule are required' });
    }

    // Validate emails
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(fromEmail) || !emailRegex.test(toEmail)) {
        return res.status(400).json({ error: 'Invalid email format' });
    }

    // Generate unique share ID
    const shareId = crypto.randomBytes(16).toString('hex');
    const expiresAt = Date.now() + ((expireMinutes || 60) * 60 * 1000); // Default 1 hour

    // Store the shared rule
    sharedRules[shareId] = {
        fromEmail,
        toEmail,
        rule,
        expiresAt,
        used: false,
        createdAt: Date.now()
    };

    console.log(`🔗 Rule shared from ${fromEmail} to ${toEmail}, ID: ${shareId}`);

    res.json({ 
        success: true, 
        shareId,
        message: `Rule shared with ${toEmail}`,
        expiresIn: expireMinutes || 60
    });
});

/**
 * 7. Check for shared rules for a user
 */
app.get('/api/check-shared-rules/:email', (req, res) => {
    const { email } = req.params;

    if (!email) {
        return res.status(400).json({ error: 'Email is required' });
    }

    const now = Date.now();
    const userShares = [];

    // Find all active shares for this user
    for (const [shareId, share] of Object.entries(sharedRules)) {
        if (share.toEmail === email && !share.used && share.expiresAt > now) {
            userShares.push({
                shareId,
                fromEmail: share.fromEmail,
                rule: share.rule,
                createdAt: share.createdAt,
                expiresAt: share.expiresAt
            });
        }
    }

    console.log(`📬 ${userShares.length} shared rule(s) found for ${email}`);

    res.json({ 
        success: true, 
        shares: userShares,
        count: userShares.length
    });
});

/**
 * 8. Mark a shared rule as used
 */
app.post('/api/mark-rule-used/:shareId', (req, res) => {
    const { shareId } = req.params;

    if (!sharedRules[shareId]) {
        return res.status(404).json({ error: 'Share not found' });
    }

    sharedRules[shareId].used = true;
    console.log(`✅ Share ${shareId} marked as used`);

    res.json({ success: true, message: 'Rule marked as used' });
});

/**
 * 9. Delete expired shares (cleanup job)
 */
function cleanupExpiredShares() {
    const now = Date.now();
    let cleaned = 0;

    for (const [shareId, share] of Object.entries(sharedRules)) {
        if (share.expiresAt < now || share.used) {
            delete sharedRules[shareId];
            cleaned++;
        }
    }

    if (cleaned > 0) {
        console.log(`🧹 Cleaned up ${cleaned} expired/used shares`);
    }
}

// Run cleanup every 10 minutes
setInterval(cleanupExpiredShares, 10 * 60 * 1000);

// --- PAYMENT REDIRECT ENDPOINTS ---

/**
 * Handle successful payment redirect
 */
app.get('/payment-success', (req, res) => {
    const { extension_id } = req.query;
    console.log('💰 Payment success redirect for extension:', extension_id);
    
    // Serve a simple HTML page that redirects to the extension
    res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>Payment Successful</title>
    <meta charset="utf-8">
    <style>
        body { font-family: Arial, sans-serif; text-align: center; padding: 50px; background: #f0f8ff; }
        .container { max-width: 600px; margin: 0 auto; background: white; padding: 30px; border-radius: 10px; box-shadow: 0 0 20px rgba(0,0,0,0.1); }
        h1 { color: #28a745; }
        .instructions { background: #e8f5e9; padding: 20px; border-radius: 5px; margin: 20px 0; }
        button { background: #007bff; color: white; border: none; padding: 12px 24px; font-size: 16px; border-radius: 5px; cursor: pointer; }
        button:hover { background: #0056b3; }
    </style>
</head>
<body>
    <div class="container">
        <h1>✅ Payment Successful!</h1>
        <p>Your payment has been processed successfully.</p>
        
        <div class="instructions">
            <h3>Next Steps:</h3>
            <p>Please click the button below to open your extension and activate your premium features.</p>
        </div>
        
        <button id="open-extension-btn">Open Extension</button>
        
        <p>If the button doesn't work, manually open your Chrome extension and refresh the options page.</p>
    </div>
    
    <script>
        // Get extension ID from URL parameters
        const urlParams = new URLSearchParams(window.location.search);
        const extensionId = urlParams.get('extension_id');
        
        function openExtension() {
            // Try to open the extension
            if (extensionId && extensionId !== '') {
                // Create the extension URL
                const extensionUrl = 'chrome-extension://' + extensionId + '/options.html?payment_status=success';
                
                // Try to open in a new tab
                window.open(extensionUrl, '_blank');
                
                // Show confirmation
                alert('Opening extension... If it doesn\'t open automatically, please open your Chrome extension manually.');
            } else {
                alert('Extension ID not found. Please open your Chrome extension manually.');
            }
        }
        
        // Add event listener to button
        document.getElementById('open-extension-btn').addEventListener('click', openExtension);
        
        // Auto-try to open after 2 seconds
        setTimeout(openExtension, 2000);
        
        // Also try to open immediately
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', openExtension);
        } else {
            openExtension();
        }
    </script>
</body>
</html>
    `);
});

/**
 * Handle cancelled payment redirect
 */
app.get('/payment-cancelled', (req, res) => {
    const { extension_id } = req.query;
    console.log('❌ Payment cancelled for extension:', extension_id);
    
    // Serve a simple HTML page for cancelled payments
    res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>Payment Cancelled</title>
    <meta charset="utf-8">
    <style>
        body { font-family: Arial, sans-serif; text-align: center; padding: 50px; background: #fff5f5; }
        .container { max-width: 600px; margin: 0 auto; background: white; padding: 30px; border-radius: 10px; box-shadow: 0 0 20px rgba(0,0,0,0.1); }
        h1 { color: #dc3545; }
        .instructions { background: #f8d7da; padding: 20px; border-radius: 5px; margin: 20px 0; }
        button { background: #007bff; color: white; border: none; padding: 12px 24px; font-size: 16px; border-radius: 5px; cursor: pointer; }
        button:hover { background: #0056b3; }
    </style>
</head>
<body>
    <div class="container">
        <h1>❌ Payment Cancelled</h1>
        <p>Your payment was cancelled or not completed.</p>
        
        <div class="instructions">
            <h3>You can still:</h3>
            <p>• Try again with a different payment method</p>
            <p>• Continue using the free version of the extension</p>
        </div>
        
        <button id="open-extension-btn">Return to Extension</button>
        
        <p>If the button doesn't work, manually open your Chrome extension.</p>
    </div>
    
    <script>
        // Get extension ID from URL parameters
        const urlParams = new URLSearchParams(window.location.search);
        const extensionId = urlParams.get('extension_id');
        
        function openExtension() {
            // Try to open the extension
            if (extensionId && extensionId !== '') {
                // Create the extension URL
                const extensionUrl = 'chrome-extension://' + extensionId + '/options.html?payment_status=cancelled';
                
                // Try to open in a new tab
                window.open(extensionUrl, '_blank');
                
                // Show confirmation
                alert('Returning to extension... If it doesn\'t open automatically, please open your Chrome extension manually.');
            } else {
                alert('Extension ID not found. Please open your Chrome extension manually.');
            }
        }
        
        // Add event listener to button
        document.getElementById('open-extension-btn').addEventListener('click', openExtension);
        
        // Auto-try to open after 2 seconds
        setTimeout(openExtension, 2000);
        
        // Also try to open immediately
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', openExtension);
        } else {
            openExtension();
        }
    </script>
</body>
</html>
    `);
});

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
    console.log(`   POST /api/share-rule`);
    console.log(`   GET  /api/check-shared-rules/:email`);
    console.log(`   POST /api/mark-rule-used/:shareId`);
    console.log(`   GET  /payment-success`);
    console.log(`   GET  /payment-cancelled`);
});