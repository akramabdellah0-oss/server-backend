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
    console.log('💳 Creating checkout session with:', { priceId, userId, successUrl, cancelUrl });
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
                user_id: userId
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
    console.log('📝 Request headers:', req.headers);
    console.log('📦 Request body length:', req.body.length);
    console.log('🔑 Webhook secret configured:', !!STRIPE_WEBHOOK_SECRET);
    
    if (!STRIPE_WEBHOOK_SECRET) {
        console.error('❌ Stripe webhook secret not configured.');
        return res.status(400).send('Webhook Error: Missing secret.');
    }

    const sig = req.headers['stripe-signature'];
    let event;

    try {
        event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
        console.log('✅ Webhook event constructed successfully');
        console.log('🏷️ Event type:', event.type);
        console.log('🆔 Event ID:', event.id);
    } catch (err) {
        console.error(`❌ Webhook signature verification failed:`, err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Gérer l'événement
    console.log('🔄 Handling event type:', event.type);
    switch (event.type) {
        case 'checkout.session.completed':
            console.log('✅ Checkout session completed event received');
            const session = event.data.object;
            console.log('📧 Full session data:', JSON.stringify(session, null, 2));
            console.log('📧 Customer email from session.customer_email:', session.customer_email);
            console.log('📧 Customer metadata:', session.metadata);
            
            // Try multiple ways to get the customer email
            let userEmail = null;
            
            // Method 1: Direct customer_email field
            if (session.customer_email) {
                userEmail = session.customer_email;
                console.log('📧 Found email in session.customer_email:', userEmail);
            }
            
            // Method 2: Metadata
            else if (session.metadata && session.metadata.user_id) {
                userEmail = session.metadata.user_id;
                console.log('📧 Found email in session.metadata.user_id:', userEmail);
            }
            
            // Method 3: Customer object
            else if (session.customer && typeof session.customer === 'string') {
                // Sometimes customer is just the customer ID, but let's log it anyway
                console.log('📧 Customer ID from session.customer:', session.customer);
            }
            
            // Method 4: Customer details object
            else if (session.customer_details && session.customer_details.email) {
                userEmail = session.customer_details.email;
                console.log('📧 Found email in session.customer_details.email:', userEmail);
            }
            
            console.log('📧 Final determined user email:', userEmail);
            
            if (userEmail) {
                // Determine plan based on price ID
                let planName = 'Pro'; // Default
                console.log('📋 Session line items structure:', session.line_items);
                if (session.line_items && session.line_items.data && session.line_items.data.length > 0) {
                    const firstLineItem = session.line_items.data[0];
                    console.log('📋 First line item:', JSON.stringify(firstLineItem, null, 2));
                    
                    if (firstLineItem.price) {
                        const priceId = firstLineItem.price.id;
                        console.log('💰 Price ID from session:', priceId);
                        
                        // Map price IDs to plan names (you'll need to update these with your actual price IDs)
                        if (priceId === 'price_1SXINCJdBDLWAyB09C5II34Q') {
                            planName = 'Plus';
                        } else if (priceId === 'price_1SXIM2JdBDLWAyB0cVOcC25x') {
                            planName = 'Pro';
                        } else {
                            console.log('⚠️ Unknown price ID, using default Pro plan');
                        }
                        
                        console.log('🏷️ Determined plan name:', planName);
                    } else {
                        console.log('⚠️ No price information found in line item');
                    }
                } else {
                    console.log('⚠️ No line items found in session, using default Pro plan');
                }
                
                // Mettre à jour le statut de l'utilisateur dans notre "base de données"
                console.log('💾 Updating user subscription for:', userEmail);
                console.log('🏷️ Plan name:', planName);
                userSubscriptions[userEmail] = {
                    isPremium: true,
                    plan: planName
                };
                console.log(`🌟 Subscription ACTIVATED for ${userEmail} (${planName})`);
                console.log('💾 Updated user subscriptions:', userSubscriptions);
                
                // Save data to file
                saveDataToFile();
            } else {
                console.log('❌ ERROR: No user email found in session! Cannot activate subscription.');
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
    console.log(`   GET  /api/test-subscription`);
});