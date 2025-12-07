// Import dependencies
const express = require('express');
const bodyParser = require('body-parser'); // 1. Importer body-parser
const Stripe = require('stripe'); // 1. Importer Stripe
const sgMail = require('@sendgrid/mail'); // 🔴 REMPLACER nodemailer
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

// Load environment variables from .env file
require('dotenv').config();

const app = express();

// --- SERVER URL CONFIGURATION ---
const SERVER_URL = process.env.SERVER_URL || 'https://server-backend-fuwj.onrender.com';
console.log('🌐 Server URL:', SERVER_URL);

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
const sharedRules = {};

// --- SUBSCRIPTION DATA PERSISTENCE ---
const DATA_FILE = path.join(__dirname, 'app_data.json');

// Save all data to file
function saveDataToFile() {
    try {
        const data = {
            userSubscriptions: userSubscriptions,
            verificationCodes: verificationCodes
        };
        fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
        console.log('💾 Data saved to file');
    } catch (error) {
        console.error('❌ Error saving data to file:', error);
    }
}

// Load data from file
function loadDataFromFile() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            const data = fs.readFileSync(DATA_FILE, 'utf8');
            const loadedData = JSON.parse(data);
            
            // Load user subscriptions
            if (loadedData.userSubscriptions) {
                Object.assign(userSubscriptions, loadedData.userSubscriptions);
                console.log('📂 User subscriptions loaded from file:', Object.keys(userSubscriptions).length, 'users');
            }
            
            // Load verification codes
            if (loadedData.verificationCodes) {
                Object.assign(verificationCodes, loadedData.verificationCodes);
                console.log('📂 Verification codes loaded from file:', Object.keys(verificationCodes).length, 'codes');
            }
        } else {
            console.log('📄 Data file not found, starting with empty data');
        }
    } catch (error) {
        console.error('❌ Error loading data from file:', error);
    }
}

// Load data on server start
loadDataFromFile();

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
console.log('💳 Stripe configuration:');
console.log('   Secret key configured:', !!STRIPE_SECRET_KEY);
console.log('   Webhook secret configured:', !!STRIPE_WEBHOOK_SECRET);
console.log('   Webhook secret value:', STRIPE_WEBHOOK_SECRET ? '[REDACTED]' : 'NOT SET');
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
    
    // Save data to file
    saveDataToFile();

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
    
    // Save data to file
    saveDataToFile();

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

    // Decode the email if it's encoded
    let decodedUserId = user_id;
    try {
        decodedUserId = decodeURIComponent(user_id);
        console.log('🔓 Decoded user ID:', decodedUserId);
    } catch (decodeError) {
        console.log('⚠️ Could not decode user ID, using original:', user_id);
    }

    const user = userSubscriptions[decodedUserId];
    
    console.log('👤 User subscription data:', user);
    console.log('📋 All users in database:', Object.keys(userSubscriptions));

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
 * 3.5 Force Activate Plan (For Testing/Emergency)
 * Usage: /api/force-activate?email=user@example.com&plan=Plus
 */
app.get('/api/force-activate', (req, res) => {
    const { email, plan } = req.query;
    
    if (!email) {
        console.error('❌ Force activate: Email required');
        return res.status(400).json({ error: 'Email required' });
    }
    
    const validPlan = plan === 'Plus' || plan === 'Pro' ? plan : 'Pro';
    
    console.log(`⚡ Force activating ${validPlan} plan for ${email}`);
    
    userSubscriptions[email] = {
        isPremium: true,
        plan: validPlan,
        activatedAt: new Date().toISOString(),
        lastPayment: new Date().toISOString(),
        status: 'active'
    };
    
    // Save to file
    saveDataToFile();
    
    console.log(`✅ User activated: ${email} (${validPlan})`);
    
    res.json({
        success: true,
        message: `${validPlan} plan activated for ${email}`,
        user: userSubscriptions[email]
    });
});

/**
 * 4. Create Checkout Session (Called by Pricing.tsx)
 * This is the REAL implementation using Stripe.
 */
app.post('/api/create-checkout-session', async (req, res) => {
    const { priceId, userId, extensionId } = req.body;
    console.log('💳 Creating checkout session with:', { priceId, userId, extensionId });

    // Note: Stripe cannot redirect to chrome-extension:// URLs directly
    // We need to redirect to a web page that can then communicate with the extension
    const extId = extensionId || 'unknown';
    const successUrl = SERVER_URL + '/payment-success?payment_status=success&extension_id=' + extId;
    const cancelUrl = SERVER_URL + '/payment-cancelled?payment_status=cancelled&extension_id=' + extId;

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
            metadata: {
                user_id: userId,
                price_id: priceId  // Store price ID for webhook to identify plan
            }
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
    console.log('🔔 Stripe webhook received');
    
    const sig = req.headers['stripe-signature'];
    let event;

    try {
        event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
        console.log('✅ Webhook verified');
    } catch (err) {
        console.error('❌ Webhook signature verification failed:', err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Gérer l'événement
    console.log('🔄 Handling event type:', event.type);
    
    if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        console.log('✅ Checkout session completed');
        
        // Récupérer l'email du client
        const customerEmail = session.customer_email || 
                            (session.customer_details && session.customer_details.email) ||
                            (session.metadata && session.metadata.user_id);
        
        if (!customerEmail) {
            console.error('❌ No email found in session');
            return res.status(400).json({ error: 'No email found in session' });
        }

        try {
            let planName = 'Pro'; // Par défaut
            let priceId = null;
            
            // Try to get price ID from line_items
            if (session.line_items && session.line_items.data && session.line_items.data[0]) {
                const lineItem = session.line_items.data[0];
                console.log('💰 Full line item:', JSON.stringify(lineItem, null, 2));
                
                // Try to get price ID from different possible locations
                priceId = lineItem.price?.id || lineItem.price;
                console.log('💰 Extracted Price ID from line_items:', priceId);
            } else {
                console.log('⚠️ No line items found in session');
            }
            
            // If no price ID found, try to get it from metadata (fallback)
            if (!priceId && session.metadata && session.metadata.price_id) {
                priceId = session.metadata.price_id;
                console.log('💰 Extracted Price ID from metadata:', priceId);
            }
            
            // Determine plan based on price ID
            if (priceId) {
                console.log('🔍 Checking price ID:', priceId);
                if (priceId === 'price_1SXINCJdBDLWAyB09C5II34Q') {
                    planName = 'Plus';
                    console.log('🏷️ Detected Plus plan');
                } else if (priceId === 'price_1SXIM2JdBDLWAyB0cVOcC25x') {
                    planName = 'Pro';
                    console.log('🏷️ Detected Pro plan');
                } else {
                    console.log('⚠️ Unknown price ID, using default Pro plan');
                    console.log('❓ Unrecognized price ID:', priceId);
                }
            } else {
                console.log('⚠️ No price ID found anywhere, using default Pro plan');
            }
            
            console.log('💾 Full session object:', JSON.stringify(session, null, 2));

            // Mettre à jour le statut de l'utilisateur
            userSubscriptions[customerEmail] = {
                isPremium: true,
                plan: planName,
                activatedAt: new Date().toISOString(),
                lastPayment: new Date().toISOString(),
                status: 'active'
            };

            // Sauvegarder les données
            await saveDataToFile();
            
            console.log(`✅ Premium activé pour: ${customerEmail} (${planName})`);
            
            // Envoyer un email de confirmation
            await sendActivationEmail(customerEmail, planName);
            
        } catch (error) {
            console.error('❌ Error processing webhook:', error);
            return res.status(500).json({ error: 'Internal server error' });
        }
    }

    // Répondre à Stripe pour confirmer la réception
    res.json({ received: true });
}

// Fonction pour envoyer un email d'activation
async function sendActivationEmail(email, planName) {
    if (!process.env.SENDGRID_API_KEY) {
        console.log('SendGrid non configuré, email non envoyé');
        return;
    }

    const msg = {
        to: email,
        from: process.env.EMAIL_FROM || 'noreply@yourdomain.com',
        subject: '🎉 Votre compte Premium est activé !',
        text: `Félicitations ! Votre compte a été mis à niveau vers le plan ${planName}.`,
        html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                <h2>🎉 Félicitations !</h2>
                <p>Votre compte a été mis à niveau avec succès vers le plan <strong>${planName}</strong>.</p>
                <p>Vous pouvez maintenant profiter de toutes les fonctionnalités exclusives.</p>
                <p>Merci pour votre confiance !</p>
            </div>
        `
    };

    try {
        await sgMail.send(msg);
        console.log(`� Email de confirmation envoyé à ${email}`);
    } catch (error) {
        console.error('❌ Erreur lors de l\'envoi de l\'email:', error);
    }
}

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
    
    // Serve a simple HTML page with auto-close functionality
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
        .message { margin: 20px 0; font-size: 18px; }
        .progress { width: 100%; height: 4px; background: #e0e0e0; border-radius: 2px; margin: 20px 0; overflow: hidden; }
        .progress-bar { height: 100%; background: #28a745; width: 0%; animation: progress 3s linear forwards; }
        @keyframes progress { to { width: 100%; } }
        .note { background: #e8f5e9; padding: 15px; border-radius: 5px; margin: 20px 0; }
    </style>
</head>
<body>
    <div class="container">
        <h1>✅ Payment Successful!</h1>
        <div class="message">
            <p>Your payment has been processed successfully.</p>
            <p>Your premium features will be activated automatically.</p>
        </div>
        
        <div class="progress">
            <div class="progress-bar"></div>
        </div>
        
        <div class="note">
            <p>This page will close automatically. Your extension will refresh with premium features activated.</p>
        </div>
    </div>
    
    <script>
        // Notify the extension and close the tab automatically
        console.log('Payment success page loaded. Activating premium features...');
        
        // Close the tab after 3 seconds
        setTimeout(function() {
            console.log('Closing payment success page...');
            window.close();
        }, 3000);
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
    
    // Serve a simple HTML page with auto-close functionality
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
        .message { margin: 20px 0; font-size: 18px; }
        .progress { width: 100%; height: 4px; background: #e0e0e0; border-radius: 2px; margin: 20px 0; overflow: hidden; }
        .progress-bar { height: 100%; background: #dc3545; width: 0%; animation: progress 3s linear forwards; }
        @keyframes progress { to { width: 100%; } }
        .note { background: #f8d7da; padding: 15px; border-radius: 5px; margin: 20px 0; }
    </style>
</head>
<body>
    <div class="container">
        <h1>❌ Payment Cancelled</h1>
        <div class="message">
            <p>Your payment was cancelled or not completed.</p>
            <p>You can try again or continue with the free plan.</p>
        </div>
        
        <div class="progress">
            <div class="progress-bar"></div>
        </div>
        
        <div class="note">
            <p>This page will close automatically. You can upgrade anytime from extension settings.</p>
        </div>
    </div>
    
    <script>
        // Close the tab after 3 seconds
        console.log('Payment cancelled page loaded. Closing automatically...');
        
        setTimeout(function() {
            console.log('Closing payment cancelled page...');
            window.close();
        }, 3000);
    </script>
</body>
</html>
    `);
});

// Test endpoint to manually trigger subscription update
app.get('/api/test-subscription', (req, res) => {
    const { email, plan } = req.query;
    if (!email) {
        return res.status(400).json({ error: 'Email required' });
    }
    
    const planName = plan || 'Pro';
    userSubscriptions[email] = {
        isPremium: true,
        plan: planName
    };
    
    console.log(`🧪 TEST: Subscription ACTIVATED for ${email} (${planName})`);
    
    // Save data to file
    saveDataToFile();
    
    res.json({ success: true, message: `Subscription activated for ${email}` });
});

// Test endpoint to check a user's subscription status
app.get('/api/check-user-status', (req, res) => {
    const { email } = req.query;
    if (!email) {
        return res.status(400).json({ error: 'Email required' });
    }
    
    const user = userSubscriptions[email];
    console.log(`🔍 Checking subscription status for ${email}:`, user);
    
    if (user && user.isPremium) {
        return res.json({ 
            is_premium: true, 
            plan: user.plan,
            message: `User ${email} has ${user.plan} subscription`
        });
    } else {
        return res.json({ 
            is_premium: false, 
            plan: 'Free',
            message: `User ${email} has no premium subscription`
        });
    }
});

// Test endpoint to manually trigger subscription update with detailed logging
app.get('/api/manual-subscription', (req, res) => {
    const { email, plan } = req.query;
    if (!email) {
        return res.status(400).json({ error: 'Email required' });
    }
    
    console.log(`🔧 MANUAL SUBSCRIPTION TRIGGER for ${email}`);
    console.log(`🔧 Current subscriptions before update:`, userSubscriptions);
    
    const planName = plan || 'Pro';
    userSubscriptions[email] = {
        isPremium: true,
        plan: planName
    };
    
    console.log(`🔧 MANUAL: Subscription ACTIVATED for ${email} (${planName})`);
    console.log(`🔧 Current subscriptions after update:`, userSubscriptions);
    
    // Save data to file
    saveDataToFile();
    
    // Also save a backup copy for debugging
    try {
        const fs = require('fs');
        const path = require('path');
        const backupFile = path.join(__dirname, `manual_subscription_backup_${Date.now()}.json`);
        fs.writeFileSync(backupFile, JSON.stringify({
            timestamp: new Date().toISOString(),
            email: email,
            plan: planName,
            allSubscriptions: userSubscriptions
        }, null, 2));
        console.log(`🔧 Backup saved to: ${backupFile}`);
    } catch (backupError) {
        console.error('❌ Error saving backup:', backupError);
    }
    
    res.json({ 
        success: true, 
        message: `Subscription manually activated for ${email}`,
        data: {
            email: email,
            plan: planName,
            allSubscriptionsCount: Object.keys(userSubscriptions).length
        }
    });
});

// Debug endpoint to view current subscription data
app.get('/api/debug-subscriptions', (req, res) => {
    console.log('🔧 DEBUG: Current subscription data request');
    console.log('🔧 Current userSubscriptions:', userSubscriptions);
    console.log('🔧 Current verificationCodes:', verificationCodes);
    
    // Try to read the data file
    try {
        const fs = require('fs');
        const path = require('path');
        const dataFile = path.join(__dirname, 'app_data.json');
        
        if (fs.existsSync(dataFile)) {
            const fileContent = fs.readFileSync(dataFile, 'utf8');
            const parsedData = JSON.parse(fileContent);
            
            res.json({
                success: true,
                message: 'Current subscription data',
                inMemory: {
                    userSubscriptions: userSubscriptions,
                    verificationCodes: verificationCodes,
                    userCount: Object.keys(userSubscriptions).length
                },
                inFile: parsedData,
                fileExists: true
            });
        } else {
            res.json({
                success: true,
                message: 'Current subscription data (no file)',
                inMemory: {
                    userSubscriptions: userSubscriptions,
                    verificationCodes: verificationCodes,
                    userCount: Object.keys(userSubscriptions).length
                },
                fileExists: false
            });
        }
    } catch (error) {
        console.error('❌ Error reading data file:', error);
        res.json({
            success: false,
            error: error.message,
            inMemory: {
                userSubscriptions: userSubscriptions,
                verificationCodes: verificationCodes,
                userCount: Object.keys(userSubscriptions).length
            }
        });
    }
});

// Emergency endpoint to force activate a user's subscription
app.get('/api/force-activate', (req, res) => {
    const { email, plan } = req.query;
    
    if (!email) {
        return res.status(400).json({ 
            success: false, 
            error: 'Email is required' 
        });
    }
    
    const planName = plan || 'Pro';
    
    console.log(`🚨 EMERGENCY ACTIVATION for ${email} with plan ${planName}`);
    
    // Activate the subscription
    userSubscriptions[email] = {
        isPremium: true,
        plan: planName
    };
    
    // Save to file
    saveDataToFile();
    
    console.log(`✅ EMERGENCY: Subscription activated for ${email} (${planName})`);
    
    res.json({
        success: true,
        message: `Subscription forcefully activated for ${email} with ${planName} plan`,
        email: email,
        plan: planName
    });
});

// Endpoint to manually register and activate a user
app.get('/api/register-user', (req, res) => {
    const { email, plan } = req.query;
    
    if (!email) {
        return res.status(400).json({ 
            success: false, 
            error: 'Email is required' 
        });
    }
    
    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
        return res.status(400).json({ 
            success: false, 
            error: 'Invalid email format' 
        });
    }
    
    const planName = plan || 'Pro';
    
    console.log(`👤 REGISTERING USER: ${email} with plan ${planName}`);
    
    // Register and activate the subscription
    userSubscriptions[email] = {
        isPremium: true,
        plan: planName
    };
    
    // Save to file
    saveDataToFile();
    
    console.log(`✅ USER REGISTERED: ${email} (${planName})`);
    
    res.json({
        success: true,
        message: `User ${email} registered with ${planName} plan`,
        email: email,
        plan: planName
    });
});

// Endpoint to check if an email exists in the subscription database
app.get('/api/check-email-exists', (req, res) => {
    const { email } = req.query;
    
    if (!email) {
        return res.status(400).json({ 
            success: false, 
            error: 'Email is required' 
        });
    }
    
    console.log(`🔍 Checking if email exists in database: ${email}`);
    
    // Check if email exists
    const user = userSubscriptions[email];
    
    if (user) {
        console.log(`✅ Email found: ${email}`, user);
        res.json({
            success: true,
            exists: true,
            email: email,
            subscription: user
        });
    } else {
        console.log(`❌ Email not found: ${email}`);
        res.json({
            success: true,
            exists: false,
            email: email
        });
    }
});

// Endpoint to get the most recent payment email
// This helps the extension discover which email was used for payment
app.get('/api/get-recent-payment-email', (req, res) => {
    console.log('🔍 Getting recent payment email');
    
    // Get all premium users
    const premiumUsers = [];
    for (const [email, subscription] of Object.entries(userSubscriptions)) {
        if (subscription.isPremium) {
            premiumUsers.push({
                email: email,
                plan: subscription.plan,
                // We don't have timestamps, so we'll just return all premium users
            });
        }
    }
    
    console.log(`📋 Found ${premiumUsers.length} premium users`);
    
    if (premiumUsers.length > 0) {
        // Return the first one (in a real implementation, you'd want the most recent)
        const recentUser = premiumUsers[0];
        res.json({
            success: true,
            email: recentUser.email,
            plan: recentUser.plan
        });
    } else {
        res.json({
            success: false,
            error: 'No recent payments found'
        });
    }
});

// Emergency endpoint to manually activate a user's subscription
// This is for cases where the webhook failed to process
app.get('/api/emergency-activate', (req, res) => {
    const { email, plan } = req.query;
    
    if (!email) {
        return res.status(400).json({ 
            success: false, 
            error: 'Email is required' 
        });
    }
    
    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
        return res.status(400).json({ 
            success: false, 
            error: 'Invalid email format' 
        });
    }
    
    const planName = plan || 'Pro';
    
    console.log(`🚨 EMERGENCY ACTIVATION for ${email} with plan ${planName}`);
    
    // Activate the subscription
    userSubscriptions[email] = {
        isPremium: true,
        plan: planName
    };
    
    // Save to file
    saveDataToFile();
    
    console.log(`✅ EMERGENCY: Subscription activated for ${email} (${planName})`);
    
    res.json({
        success: true,
        message: `Subscription forcefully activated for ${email} with ${planName} plan`,
        email: email,
        plan: planName
    });
});

/**
 * 8. Delete user from database
 * Usage: DELETE /api/delete-user?email=user@example.com
 */
app.delete('/api/delete-user', (req, res) => {
    const { email } = req.query;
    
    if (!email) {
        console.error('❌ Delete user: Email required');
        return res.status(400).json({ error: 'Email required' });
    }
    
    console.log(`🗑️ Deleting user: ${email}`);
    
    // Delete from subscriptions
    if (userSubscriptions[email]) {
        delete userSubscriptions[email];
        console.log(`✅ Deleted from subscriptions`);
    }
    
    // Delete from verification codes
    if (verificationCodes[email]) {
        delete verificationCodes[email];
        console.log(`✅ Deleted from verification codes`);
    }
    
    // Save to file
    saveDataToFile();
    
    console.log(`✅ User deleted: ${email}`);
    
    res.json({
        success: true,
        message: `User ${email} deleted from database`
    });
});

/**
 * 9. Delete Stripe customer
 * Usage: DELETE /api/delete-stripe-customer?email=user@example.com
 */
app.delete('/api/delete-stripe-customer', async (req, res) => {
    const { email } = req.query;
    
    if (!email) {
        console.error('❌ Delete Stripe customer: Email required');
        return res.status(400).json({ error: 'Email required' });
    }
    
    try {
        console.log(`🗑️ Deleting Stripe customer for: ${email}`);
        
        // Find customer by email
        const customers = await stripe.customers.list({ email });
        
        if (customers.data.length === 0) {
            console.log('⚠️ No Stripe customer found for:', email);
            return res.json({ 
                success: true,
                message: 'No Stripe customer found',
                count: 0
            });
        }
        
        // Delete each customer
        let deletedCount = 0;
        for (const customer of customers.data) {
            await stripe.customers.del(customer.id);
            console.log(`✅ Deleted Stripe customer: ${customer.id}`);
            deletedCount++;
        }
        
        res.json({
            success: true,
            message: `Deleted ${deletedCount} Stripe customer(s) for ${email}`,
            count: deletedCount
        });
    } catch (error) {
        console.error('❌ Error deleting Stripe customer:', error.message);
        res.status(500).json({ 
            error: error.message,
            success: false
        });
    }
});

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📧 Email service: ${SENDGRID_API_KEY ? 'SendGrid (API Ready)' : 'Disabled - No API Key'}`);
    console.log(`💳 Payment service: ${STRIPE_SECRET_KEY ? 'Stripe (Ready)' : 'Disabled - No API Key'}`);
    console.log(`🔑 Endpoints:`);
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
    console.log(`   GET  /api/test-subscription`);
    console.log(`   DELETE /api/delete-user`);
    console.log(`   DELETE /api/delete-stripe-customer`);
});