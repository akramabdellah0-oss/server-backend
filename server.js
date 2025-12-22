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

// --- DEBUG: LOG ENVIRONMENT VARIABLES ---
console.log('🔍 ENVIRONMENT DEBUG:');
console.log('   Active Keys:', Object.keys(process.env).join(', '));
console.log('   RAILWAY_PUBLIC_DOMAIN:', process.env.RAILWAY_PUBLIC_DOMAIN);
console.log('-----------------------------');

// --- SERVER URL CONFIGURATION ---
const SERVER_URL = process.env.SERVER_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : 'https://thoughtful-liza-laguasetta-ac137d0b.koyeb.app');
console.log('🌐 Server URL:', SERVER_URL);

// --- FIX FOR KOYEB/LOAD BALANCERS ---
// Tell Express to trust the proxy (Koyeb Load Balancer) so rate-limiter gets the real IP
// This fixes the "ValidationError: The 'X-Forwarded-For' header is set..." error.
app.set('trust proxy', 1);

// --- WEBHOOK PARSING ---
// Le webhook de Stripe a besoin du "raw body", donc nous utilisons bodyParser.raw
// pour cet endpoint spécifique, AVANT `express.json()`.
app.post('/api/stripe-webhook', bodyParser.raw({ type: 'application/json' }), handleStripeWebhook);

// Middlewares
app.use(cors({ origin: '*' })); // Allow all origins for development. Restrict in production.
app.use(express.json());

// --- IN-MEMORY DATABASES ---
// Note: In production, replace these with a real database (MongoDB, PostgreSQL, etc.)
const verificationCodes = {};
const userSubscriptions = {}; // Stores license status: { 'email@example.com': { isPremium: true, plan: 'Pro' } }
const sharedRules = {};

// --- ADMIN AUTHENTICATION ---
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123'; // Change in production!
const adminTokens = new Set(); // Store valid admin tokens

function generateAdminToken() {
    return crypto.randomBytes(32).toString('hex');
}

function verifyAdminToken(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Authorization required' });
    }
    const token = authHeader.split(' ')[1];
    if (!adminTokens.has(token)) {
        return res.status(401).json({ error: 'Invalid or expired token' });
    }
    next();
}

// --- SERVER LOGGING SYSTEM ---
const serverLogs = [];
const MAX_LOGS = 200;

function addLog(message) {
    const logEntry = {
        timestamp: new Date().toISOString(),
        message: message
    };
    serverLogs.push(logEntry);
    if (serverLogs.length > MAX_LOGS) {
        serverLogs.shift(); // Remove oldest log
    }
}

// Hook into console.log to capture logs
const originalConsoleLog = console.log;
console.log = function (...args) {
    const message = args.map(arg =>
        typeof arg === 'object' ? JSON.stringify(arg) : String(arg)
    ).join(' ');
    addLog(message);
    originalConsoleLog.apply(console, args);
};

const originalConsoleError = console.error;
console.error = function (...args) {
    const message = '❌ ' + args.map(arg =>
        typeof arg === 'object' ? JSON.stringify(arg) : String(arg)
    ).join(' ');
    addLog(message);
    originalConsoleError.apply(console, args);
};

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
    max: 100, // Relaxed limit for testing (was 5)
    message: "Too many requests, please try again later.",
});

// --- HEALTH CHECK & ADMIN ENDPOINTS ---

/**
 * Health check endpoint - keeps server alive on Render free tier
 */
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        users: Object.keys(userSubscriptions).length
    });
});

// --- SERVE ADMIN DASHBOARD ---
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin.html'));
});

// Serve static files for admin
app.get('/admin.css', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin.css'));
});

app.get('/admin.js', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin.js'));
});

// --- ADMIN API ENDPOINTS ---

/**
 * Admin Login - returns a token if password is correct
 */
app.post('/api/admin/login', (req, res) => {
    const { password } = req.body;
    console.log('🔐 Admin login attempt');

    if (password === ADMIN_PASSWORD) {
        const token = generateAdminToken();
        adminTokens.add(token);
        console.log('✅ Admin login successful');
        res.json({ success: true, token });
    } else {
        console.log('❌ Admin login failed - wrong password');
        res.status(401).json({ success: false, error: 'Mot de passe incorrect' });
    }
});

/**
 * Verify admin token
 */
app.get('/api/admin/verify', verifyAdminToken, (req, res) => {
    res.json({ success: true });
});

/**
 * Get server statistics
 */
app.get('/api/admin/stats', verifyAdminToken, (req, res) => {
    const totalUsers = Object.keys(userSubscriptions).length;
    const premiumUsers = Object.values(userSubscriptions).filter(u => u.isPremium).length;
    const memoryUsage = process.memoryUsage();

    res.json({
        totalUsers,
        premiumUsers,
        freeUsers: totalUsers - premiumUsers,
        uptime: process.uptime(),
        memoryMB: Math.round(memoryUsage.heapUsed / 1024 / 1024),
        timestamp: new Date().toISOString()
    });
});

/**
 * Get server logs
 */
app.get('/api/admin/logs', verifyAdminToken, (req, res) => {
    res.json({ logs: serverLogs });
});

/**
 * Clear server logs
 */
app.delete('/api/admin/logs', verifyAdminToken, (req, res) => {
    serverLogs.length = 0;
    console.log('🗑️ Admin: Logs cleared');
    res.json({ success: true });
});

/**
 * Add a new user manually
 */
/**
 * Add a new user manually (Persisted via Stripe)
 * Creates a Stripe Customer + Subscription with 100% OFF Coupon
 */
app.post('/api/admin/add-user', verifyAdminToken, async (req, res) => {
    const { email, plan } = req.body;

    if (!email) {
        return res.status(400).json({ error: 'Email is required' });
    }

    const validPlan = (plan === 'Plus' || plan === 'Pro') ? plan : 'Free';
    console.log(`👤 Admin adding user: ${email} (${validPlan}) via Stripe...`);

    // Fallback if Stripe not configured
    if (!stripe) {
        console.warn('⚠️ Stripe not configured. Adding locally only (will be lost on restart).');
        userSubscriptions[email] = {
            isPremium: validPlan !== 'Free',
            plan: validPlan,
            activatedAt: new Date().toISOString(),
            addedBy: 'admin',
            note: 'Local only (Stripe missing)'
        };
        saveDataToFile();
        return res.json({ success: true, user: userSubscriptions[email], warning: 'Stripe unavailable, not persisted.' });
    }

    try {
        // 1. Find or Create Customer
        let customer;
        const existingCustomers = await stripe.customers.list({ email, limit: 1 });

        if (existingCustomers.data.length > 0) {
            customer = existingCustomers.data[0];
            console.log(`✓ Found existing Stripe customer: ${customer.id}`);
        } else {
            customer = await stripe.customers.create({
                email,
                metadata: { source: 'admin_dashboard', added_by: 'admin' }
            });
            console.log(`✓ Created new Stripe customer: ${customer.id}`);
        }

        // 2. If Premium, Create Subscription with Coupon
        if (validPlan !== 'Free') {
            // Ensure 100% OFF Coupon exists
            const COUPON_ID = 'ADMIN_OFFER_FREE';
            try {
                await stripe.coupons.retrieve(COUPON_ID);
            } catch (err) {
                console.log('ℹ️ Creating 100% OFF coupon...');
                await stripe.coupons.create({
                    id: COUPON_ID,
                    duration: 'forever',
                    percent_off: 100,
                    name: 'Offre Admin (Gratuit à vie)'
                });
            }

            const priceId = validPlan === 'Plus'
                ? 'price_1SXINCJdBDLWAyB09C5II34Q'
                : 'price_1SXIM2JdBDLWAyB0cVOcC25x';

            // Check if already subscribed to avoid duplicates
            const existingSubs = await stripe.subscriptions.list({
                customer: customer.id,
                status: 'active',
                limit: 1
            });

            if (existingSubs.data.length === 0) {
                await stripe.subscriptions.create({
                    customer: customer.id,
                    items: [{ price: priceId }],
                    coupon: COUPON_ID,
                    metadata: { source: 'admin_dashboard' }
                });
                console.log(`✓ Created FREE subscription for ${email}`);
            } else {
                console.log(`ℹ️ User already has active subscription: ${existingSubs.data[0].id}`);
            }
        }

        // 3. Update Local DB immediately
        userSubscriptions[email] = {
            isPremium: validPlan !== 'Free',
            plan: validPlan,
            activatedAt: new Date().toISOString(),
            stripeCustomerId: customer.id,
            status: 'active',
            source: 'admin_stripe_sync'
        };

        console.log(`✅ Admin: Successfully added/synced ${email}`);
        saveDataToFile();

        res.json({ success: true, user: userSubscriptions[email] });

    } catch (error) {
        console.error('❌ Error adding user to Stripe:', error.message);
        res.status(500).json({ error: `Stripe Error: ${error.message}` });
    }
});

/**
 * Sync all users with Stripe
 */
/**
 * Sync all users with Stripe (Improved Logic)
 * Scans ALL customers with active subscriptions directly from Stripe
 */
async function syncAllUsersWithStripe() {
    if (!stripe) {
        console.log('⚠️ Stripe not configured, skipping sync.');
        return { success: false, error: 'Stripe not configured' };
    }

    console.log('🔄 START: Syncing all users with Stripe directly...');
    let synced = 0;
    let errors = 0;
    let newUsers = 0;

    try {
        // Fetch ALL active subscriptions directly
        // We expand 'customer' to get email directly
        const subscriptions = await stripe.subscriptions.list({
            status: 'active',
            limit: 100, // Fetch up to 100 active subs at once
            expand: ['data.customer']
        });

        console.log(`🔎 Found ${subscriptions.data.length} active subscriptions in Stripe.`);

        for (const subscription of subscriptions.data) {
            try {
                // Get customer email
                const customer = subscription.customer;

                // Handle case where customer is expanded or just ID
                const email = customer.email || (typeof customer === 'string' ? null : customer.id);

                if (!email || !email.includes('@')) {
                    console.log(`⚠️ Skipping subscription ${subscription.id}: Invalid customer email (${email}).`);
                    continue;
                }

                // Determine Plan
                const priceId = subscription.items.data[0]?.price?.id;
                let planName = 'Pro'; // Default fallback

                if (priceId === 'price_1SXINCJdBDLWAyB09C5II34Q') {
                    planName = 'Plus';
                } else if (priceId === 'price_1SXIM2JdBDLWAyB0cVOcC25x') {
                    planName = 'Pro';
                } else {
                    console.log(`ℹ️ Unknown price ID for ${email}: ${priceId}. Defaulting to Pro.`);
                }

                // Check if user is new
                if (!userSubscriptions[email]) {
                    newUsers++;
                }

                // Update Local Database
                userSubscriptions[email] = {
                    isPremium: true,
                    plan: planName,
                    activatedAt: new Date(subscription.created * 1000).toISOString(),
                    syncedAt: new Date().toISOString(),
                    stripeCustomerId: customer.id,
                    stripeSubscriptionId: subscription.id,
                    status: 'active',
                    installationId: customer.metadata?.installation_id || null
                };

                console.log(`➕ Added user to local DB: ${email} (${planName})`);
                synced++;

            } catch (err) {
                console.error(`❌ Error processing subscription ${subscription.id}:`, err.message);
                errors++;
            }
        }

        saveDataToFile();
        console.log(`✅ SYNC COMPLETE: ${synced} users active. (${newUsers} new locally).`);
        return { success: true, synced, newUsers, errors };

    } catch (error) {
        console.error('❌ FATAL SYNC ERROR:', error.message);
        return { success: false, error: error.message };
    }
}

// Auto-sync on startup (5 seconds after launch)
if (stripe) {
    setTimeout(syncAllUsersWithStripe, 5000);
}

app.post('/api/admin/sync-all', verifyAdminToken, async (req, res) => {
    const result = await syncAllUsersWithStripe();
    res.json(result);
});

/**
 * List all users in database (admin endpoint)
 */
app.get('/api/admin/users', (req, res) => {
    const userCount = Object.keys(userSubscriptions).length;
    console.log(`📋 Admin: Listing all users. Count: ${userCount}`);
    console.log('📋 User emails:', Object.keys(userSubscriptions));

    res.json({
        count: userCount,
        users: userSubscriptions
    });
});

/**
 * Delete a specific user from the database
 */
app.delete('/api/admin/users/:email', (req, res) => {
    const email = decodeURIComponent(req.params.email);
    console.log(`🗑️ Admin: Deleting user ${email}`);

    if (userSubscriptions[email]) {
        const deletedUser = userSubscriptions[email];
        delete userSubscriptions[email];
        saveDataToFile();

        console.log(`✅ User ${email} deleted`);
        res.json({
            success: true,
            message: `User ${email} deleted`,
            deletedUser
        });
    } else {
        console.log(`⚠️ User ${email} not found`);
        res.status(404).json({
            error: 'User not found',
            email
        });
    }
});

/**
 * Clear all users from database (dangerous!)
 */
app.delete('/api/admin/users', (req, res) => {
    const { confirm } = req.query;

    if (confirm !== 'yes-delete-all') {
        return res.status(400).json({
            error: 'Add ?confirm=yes-delete-all to confirm this dangerous action'
        });
    }

    console.log('🗑️ Admin: Clearing ALL users');
    const count = Object.keys(userSubscriptions).length;

    // Clear all subscriptions
    for (const email in userSubscriptions) {
        delete userSubscriptions[email];
    }

    saveDataToFile();

    console.log(`✅ Deleted ${count} users`);
    res.json({
        success: true,
        message: `Deleted ${count} users`,
        remaining: Object.keys(userSubscriptions).length
    });
});

/**
 * Sync a user's subscription status with Stripe
 */
app.get('/api/admin/sync-user/:email', async (req, res) => {
    const email = decodeURIComponent(req.params.email);
    console.log(`🔄 Admin: Syncing user ${email} with Stripe`);

    if (!stripe) {
        return res.status(500).json({ error: 'Stripe not configured' });
    }

    try {
        // Find customer in Stripe by email
        const customers = await stripe.customers.list({ email: email, limit: 1 });

        if (customers.data.length === 0) {
            // No Stripe customer found, reset to free
            userSubscriptions[email] = {
                isPremium: false,
                plan: 'Free',
                syncedAt: new Date().toISOString(),
                note: 'No Stripe customer found'
            };
            saveDataToFile();

            return res.json({
                success: true,
                message: 'No Stripe customer found, user set to Free',
                user: userSubscriptions[email]
            });
        }

        const customer = customers.data[0];

        // Get active subscriptions for this customer
        const subscriptions = await stripe.subscriptions.list({
            customer: customer.id,
            status: 'active',
            limit: 1
        });

        if (subscriptions.data.length === 0) {
            // No active subscription, reset to free
            userSubscriptions[email] = {
                isPremium: false,
                plan: 'Free',
                syncedAt: new Date().toISOString(),
                stripeCustomerId: customer.id,
                note: 'No active subscription in Stripe'
            };
            saveDataToFile();

            return res.json({
                success: true,
                message: 'No active subscription found, user set to Free',
                user: userSubscriptions[email]
            });
        }

        // User has active subscription
        const subscription = subscriptions.data[0];
        const priceId = subscription.items.data[0]?.price?.id;
        let planName = 'Pro';

        if (priceId === 'price_1SXINCJdBDLWAyB09C5II34Q') {
            planName = 'Plus';
        } else if (priceId === 'price_1SXIM2JdBDLWAyB0cVOcC25x') {
            planName = 'Pro';
        }

        userSubscriptions[email] = {
            isPremium: true,
            plan: planName,
            syncedAt: new Date().toISOString(),
            stripeCustomerId: customer.id,
            stripeSubscriptionId: subscription.id,
            status: subscription.status
        };
        saveDataToFile();

        console.log(`✅ User ${email} synced: ${planName}`);
        res.json({
            success: true,
            message: `User synced with Stripe: ${planName}`,
            user: userSubscriptions[email]
        });

    } catch (error) {
        console.error('❌ Sync error:', error);
        res.status(500).json({
            error: 'Failed to sync with Stripe',
            details: error.message
        });
    }
});

// --- NEW ENDPOINT: Import all customers from Stripe ---
app.post('/api/admin/sync-stripe-customers', async (req, res) => {
    console.log('🔄 Admin: Syncing ALL customers from Stripe...');

    if (!stripe) {
        return res.status(500).json({ error: 'Stripe not configured' });
    }

    try {
        // Fetch last 100 customers
        const customers = await stripe.customers.list({ limit: 100 });
        console.log(`📡 Fetched ${customers.data.length} customers from Stripe`);

        let stats = { added: 0, updated: 0, skipped: 0 };

        for (const customer of customers.data) {
            const email = customer.email;
            if (!email) continue;

            // Check for active subscriptions for this customer
            const subscriptions = await stripe.subscriptions.list({
                customer: customer.id,
                status: 'active',
                limit: 1
            });

            let isPremium = false;
            let planName = 'Free';
            let subDetails = {};

            if (subscriptions.data.length > 0) {
                isPremium = true;
                const sub = subscriptions.data[0];
                const priceId = sub.items.data[0]?.price?.id;

                if (priceId === 'price_1SXINCJdBDLWAyB09C5II34Q') {
                    planName = 'Plus';
                } else if (priceId === 'price_1SXIM2JdBDLWAyB0cVOcC25x') {
                    planName = 'Pro';
                } else {
                    planName = 'Pro'; // Default fallback
                }

                subDetails = {
                    stripeCustomerId: customer.id,
                    stripeSubscriptionId: sub.id,
                    status: sub.status,
                    syncedAt: new Date().toISOString()
                };
            }

            // Update local DB
            if (!userSubscriptions[email]) {
                // New user found in Stripe
                userSubscriptions[email] = {
                    isPremium,
                    plan: isPremium ? planName : 'Free',
                    ...subDetails,
                    addedVia: 'stripe-sync-all',
                    createdAt: new Date(customer.created * 1000).toISOString()
                };
                stats.added++;
                console.log(`✨ Added new user from Stripe: ${email} (${planName})`);
            } else {
                // Update existing user if they have a subscription in Stripe
                if (isPremium) {
                    userSubscriptions[email] = {
                        ...userSubscriptions[email],
                        isPremium: true,
                        plan: planName,
                        ...subDetails
                    };
                    stats.updated++;
                } else {
                    stats.skipped++;
                }
            }
        }

        saveDataToFile();
        console.log('✅ Sync complete:', stats);

        res.json({
            success: true,
            message: `Sync complete: ${stats.added} added, ${stats.updated} updated.`,
            stats
        });

    } catch (error) {
        console.error('❌ Sync All Error:', error);
        res.status(500).json({ error: 'Failed to sync with Stripe: ' + error.message });
    }
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
            from: { name: 'Autofill App', email: process.env.EMAIL_FROM || 'akramabdellah0@gmail.com' },
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

// ============================================
// SHARE RULE ENDPOINTS (Popup Notification)
// ============================================

/**
 * Share a rule with another user
 * POST /api/share-rule
 */
app.post('/api/share-rule', (req, res) => {
    const { fromEmail, toEmail, rule, expireMinutes = 60 } = req.body;

    if (!fromEmail || !toEmail || !rule) {
        return res.status(400).json({ error: 'fromEmail, toEmail, and rule are required' });
    }

    // Generate unique share ID
    const shareId = crypto.randomBytes(16).toString('hex');
    const expiresAt = Date.now() + (expireMinutes * 60 * 1000);

    // Store the shared rule
    if (!sharedRules[toEmail]) {
        sharedRules[toEmail] = [];
    }

    sharedRules[toEmail].push({
        shareId,
        fromEmail,
        rule,
        expiresAt,
        createdAt: Date.now(),
        accepted: false
    });

    console.log(`📤 Rule shared from ${fromEmail} to ${toEmail} (ID: ${shareId})`);
    saveDataToFile();

    res.json({
        success: true,
        shareId,
        message: `Rule shared with ${toEmail}`
    });
});

/**
 * Check for pending shared rules for a user
 * GET /api/check-shared-rules/:email
 */
app.get('/api/check-shared-rules/:email', (req, res) => {
    const email = decodeURIComponent(req.params.email);

    // Clean up expired shares
    if (sharedRules[email]) {
        sharedRules[email] = sharedRules[email].filter(share => {
            if (share.expiresAt < Date.now()) {
                console.log(`🗑️ Expired share removed for ${email} (ID: ${share.shareId})`);
                return false;
            }
            return true;
        });
    }

    const pendingShares = (sharedRules[email] || []).filter(share => !share.accepted);

    console.log(`📥 Checking shared rules for ${email}: ${pendingShares.length} pending`);

    res.json({
        success: true,
        pendingShares: pendingShares.map(share => ({
            shareId: share.shareId,
            fromEmail: share.fromEmail,
            rule: share.rule,
            createdAt: share.createdAt,
            expiresAt: share.expiresAt
        }))
    });
});

/**
 * Accept a shared rule
 * POST /api/accept-shared-rule/:shareId
 */
app.post('/api/accept-shared-rule/:shareId', (req, res) => {
    const { shareId } = req.params;
    const { email } = req.body;

    if (!email) {
        return res.status(400).json({ error: 'Email required' });
    }

    if (!sharedRules[email]) {
        return res.status(404).json({ error: 'No shared rules found for this email' });
    }

    const shareIndex = sharedRules[email].findIndex(share => share.shareId === shareId);

    if (shareIndex === -1) {
        return res.status(404).json({ error: 'Shared rule not found or expired' });
    }

    // Mark as accepted
    sharedRules[email][shareIndex].accepted = true;
    const acceptedRule = sharedRules[email][shareIndex];

    console.log(`✅ Rule accepted by ${email} (ID: ${shareId})`);
    saveDataToFile();

    res.json({
        success: true,
        rule: acceptedRule.rule,
        fromEmail: acceptedRule.fromEmail,
        message: 'Rule accepted successfully'
    });
});

/**
 * Decline/Delete a shared rule
 * DELETE /api/shared-rule/:shareId
 */
app.delete('/api/shared-rule/:shareId', (req, res) => {
    const { shareId } = req.params;
    const { email } = req.body;

    if (!email) {
        return res.status(400).json({ error: 'Email required' });
    }

    if (!sharedRules[email]) {
        return res.status(404).json({ error: 'No shared rules found' });
    }

    const originalLength = sharedRules[email].length;
    sharedRules[email] = sharedRules[email].filter(share => share.shareId !== shareId);

    if (sharedRules[email].length === originalLength) {
        return res.status(404).json({ error: 'Shared rule not found' });
    }

    console.log(`🗑️ Shared rule declined by ${email} (ID: ${shareId})`);
    saveDataToFile();

    res.json({ success: true, message: 'Shared rule removed' });
});

/**
 * 3. Check License Status (Called by App.tsx)
 * NOW VERIFIES AGAINST STRIPE IN REAL-TIME
 */
app.get('/api/check-license', async (req, res) => {
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

    // ALWAYS verify against Stripe if available
    if (stripe) {
        try {
            console.log('🔍 Verifying subscription with Stripe for:', decodedUserId);

            // Find customer in Stripe by email
            const customers = await stripe.customers.list({
                email: decodedUserId,
                limit: 1
            });

            if (customers.data.length === 0) {
                console.log('⚠️ No Stripe customer found for:', decodedUserId);
                // No Stripe customer = free user, update local cache
                userSubscriptions[decodedUserId] = {
                    isPremium: false,
                    plan: 'Free',
                    verifiedAt: new Date().toISOString(),
                    source: 'stripe-verification'
                };
                saveDataToFile();

                return res.json({ is_premium: false, plan: 'Free' });
            }

            const customer = customers.data[0];
            console.log('👤 Found Stripe customer:', customer.id);

            // Check for active subscriptions
            const subscriptions = await stripe.subscriptions.list({
                customer: customer.id,
                status: 'active',
                limit: 1
            });

            if (subscriptions.data.length === 0) {
                // Also check for trialing subscriptions
                const trialingSubscriptions = await stripe.subscriptions.list({
                    customer: customer.id,
                    status: 'trialing',
                    limit: 1
                });

                if (trialingSubscriptions.data.length === 0) {
                    console.log('� No active subscription in Stripe for:', decodedUserId);
                    // No active subscription = downgrade to free
                    userSubscriptions[decodedUserId] = {
                        isPremium: false,
                        plan: 'Free',
                        verifiedAt: new Date().toISOString(),
                        stripeCustomerId: customer.id,
                        source: 'stripe-verification',
                        note: 'No active subscription found in Stripe'
                    };
                    saveDataToFile();

                    return res.json({ is_premium: false, plan: 'Free' });
                }

                // Has trialing subscription
                subscriptions.data = trialingSubscriptions.data;
            }

            // User has active/trialing subscription
            const subscription = subscriptions.data[0];
            const priceId = subscription.items?.data[0]?.price?.id;
            let planName = 'Pro'; // Default

            if (priceId === 'price_1SXINCJdBDLWAyB09C5II34Q') {
                planName = 'Plus';
            } else if (priceId === 'price_1SXIM2JdBDLWAyB0cVOcC25x') {
                planName = 'Pro';
            }

            console.log(`✅ Stripe verified: ${decodedUserId} has ${planName} (${subscription.status})`);

            // Update local cache
            userSubscriptions[decodedUserId] = {
                isPremium: true,
                plan: planName,
                verifiedAt: new Date().toISOString(),
                stripeCustomerId: customer.id,
                stripeSubscriptionId: subscription.id,
                status: subscription.status,
                source: 'stripe-verification'
            };
            saveDataToFile();

            return res.json({ is_premium: true, plan: planName });

        } catch (stripeError) {
            console.error('❌ Stripe verification error:', stripeError.message);
            // Fall back to local cache on Stripe error
            console.log('⚠️ Falling back to local cache due to Stripe error');
        }
    } else {
        console.log('⚠️ Stripe not configured, using local cache only');
    }

    // Fallback: use local cache (only if Stripe verification failed)
    const user = userSubscriptions[decodedUserId];
    console.log('👤 User subscription data (from cache):', user);

    if (user && user.isPremium) {
        const planData = { is_premium: true, plan: user.plan || 'Pro' };
        console.log('✅ Returning premium plan (from cache):', planData);
        return res.json(planData);
    }

    // Default to free
    const freeData = { is_premium: false, plan: 'Free' };
    console.log('🆓 Returning free plan:', freeData);
    return res.json(freeData);
});

/**
 * 3.4 Check Email Status (For upgrade/downgrade flow)
 * Called before payment to check if email already exists and has a subscription
 */
app.get('/api/check-email-status', async (req, res) => {
    const { email } = req.query;

    console.log('📧 Checking email status for:', email);

    if (!email) {
        return res.status(400).json({ error: 'Email is required' });
    }

    // Decode the email if it's encoded
    let decodedEmail = email;
    try {
        decodedEmail = decodeURIComponent(email);
    } catch (decodeError) {
        console.log('⚠️ Could not decode email, using original:', email);
    }

    // First check local database
    const localUser = userSubscriptions[decodedEmail];

    // If user exists locally with premium status, return that
    if (localUser && localUser.isPremium) {
        console.log(`✅ Email ${decodedEmail} found locally with plan: ${localUser.plan}`);
        return res.json({
            exists: true,
            isPremium: true,
            plan: localUser.plan || 'Pro',
            stripeCustomerId: localUser.stripeCustomerId || null,
            stripeSubscriptionId: localUser.stripeSubscriptionId || null,
            status: localUser.status || 'active'
        });
    }

    // Verify against Stripe for real-time status
    if (stripe) {
        try {
            const customers = await stripe.customers.list({
                email: decodedEmail,
                limit: 1
            });

            if (customers.data.length > 0) {
                const customer = customers.data[0];
                console.log(`👤 Found Stripe customer: ${customer.id}`);

                // Check for active subscriptions
                const subscriptions = await stripe.subscriptions.list({
                    customer: customer.id,
                    status: 'active',
                    limit: 1
                });

                if (subscriptions.data.length > 0) {
                    const subscription = subscriptions.data[0];
                    const priceId = subscription.items?.data[0]?.price?.id;
                    let planName = 'Pro';

                    if (priceId === 'price_1SXINCJdBDLWAyB09C5II34Q') {
                        planName = 'Plus';
                    } else if (priceId === 'price_1SXIM2JdBDLWAyB0cVOcC25x') {
                        planName = 'Pro';
                    }

                    console.log(`✅ Email ${decodedEmail} has active subscription: ${planName}`);

                    // Update local cache
                    userSubscriptions[decodedEmail] = {
                        isPremium: true,
                        plan: planName,
                        stripeCustomerId: customer.id,
                        stripeSubscriptionId: subscription.id,
                        status: subscription.status,
                        verifiedAt: new Date().toISOString()
                    };
                    saveDataToFile();

                    return res.json({
                        exists: true,
                        isPremium: true,
                        plan: planName,
                        stripeCustomerId: customer.id,
                        stripeSubscriptionId: subscription.id,
                        status: subscription.status
                    });
                }

                // Customer exists but no active subscription
                console.log(`⚠️ Email ${decodedEmail} exists in Stripe but no active subscription`);
                return res.json({
                    exists: true,
                    isPremium: false,
                    plan: 'Free',
                    stripeCustomerId: customer.id,
                    status: 'no_active_subscription'
                });
            }
        } catch (stripeError) {
            console.error('❌ Stripe check error:', stripeError.message);
            // Continue with local data if Stripe fails
        }
    }

    // User exists locally but is not premium
    if (localUser) {
        console.log(`📧 Email ${decodedEmail} exists locally with Free plan`);
        return res.json({
            exists: true,
            isPremium: false,
            plan: localUser.plan || 'Free',
            status: localUser.status || 'free'
        });
    }

    // Email does not exist anywhere
    console.log(`🆕 Email ${decodedEmail} is new (not found)`);
    return res.json({
        exists: false,
        isPremium: false,
        plan: null,
        status: 'new_user'
    });
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
 * NOW WITH DEVICE BINDING SECURITY: Checks if email already has active subscription
 */
app.post('/api/create-checkout-session', async (req, res) => {
    const { priceId, userId, extensionId, installationId } = req.body;
    console.log('💳 Creating checkout session with:', { priceId, userId, extensionId, installationId });

    // Validate required fields
    if (!userId) {
        return res.status(400).json({ error: 'Email is required' });
    }

    if (!installationId) {
        console.warn('⚠️ No installation ID provided - this is a security risk');
    }

    // 🔒 SECURITY CHECK: Does this email already have an active subscription?
    if (stripe) {
        try {
            const customers = await stripe.customers.list({
                email: userId,
                limit: 1
            });

            if (customers.data.length > 0) {
                const customer = customers.data[0];
                console.log('👤 Existing customer found:', customer.id);

                // Check for active subscriptions
                const subscriptions = await stripe.subscriptions.list({
                    customer: customer.id,
                    status: 'active',
                    limit: 1
                });

                if (subscriptions.data.length > 0) {
                    const existingSubscription = subscriptions.data[0];
                    console.log('⚠️ User already has active subscription:', existingSubscription.id);

                    // Check if installation ID matches (if stored)
                    const storedInstallationId = customer.metadata?.installation_id;

                    if (storedInstallationId && storedInstallationId !== installationId) {
                        console.log('🚫 DEVICE MISMATCH! Stored:', storedInstallationId, 'Requested:', installationId);
                        return res.status(403).json({
                            error: 'This email is linked to another device. Please use the Stripe portal to manage your subscription.',
                            code: 'DEVICE_MISMATCH'
                        });
                    }

                    // Same device trying to subscribe again - redirect to portal
                    console.log('ℹ️ Same device, redirecting to portal for plan management');
                    return res.status(409).json({
                        error: 'You already have an active subscription. Use the customer portal to manage your plan.',
                        code: 'ALREADY_SUBSCRIBED',
                        portalUrl: '/api/create-portal-session'
                    });
                }
            }
        } catch (stripeError) {
            console.error('❌ Stripe check error:', stripeError.message);
            // Continue with checkout if check fails - better UX than blocking
        }
    }

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
            success_url: successUrl,
            cancel_url: cancelUrl,
            customer_email: userId,
            metadata: {
                user_id: userId,
                price_id: priceId,
                installation_id: installationId || 'unknown'  // 🔑 Store for device binding
            }
        });

        console.log(`✅ Stripe session created: ${session.id}`);
        res.json({ url: session.url });

    } catch (error) {
        console.error('❌ Stripe Error:', error.message);
        res.status(500).json({ error: 'Failed to create payment session.' });
    }
});

/**
 * 4.5 Create Customer Portal Session (For subscription management)
 * Allows existing customers to upgrade/downgrade/cancel their subscription
 */
app.post('/api/create-portal-session', async (req, res) => {
    const { email } = req.body;
    console.log('🔧 Creating portal session for:', email);

    if (!email) {
        return res.status(400).json({ error: 'Email is required' });
    }

    if (!stripe) {
        return res.status(500).json({ error: 'Stripe not configured' });
    }

    try {
        // Find customer in Stripe by email
        const customers = await stripe.customers.list({
            email: email,
            limit: 1
        });

        if (customers.data.length === 0) {
            console.log('❌ No Stripe customer found for:', email);
            return res.status(404).json({ error: 'No customer found with this email' });
        }

        const customer = customers.data[0];
        console.log('👤 Found Stripe customer:', customer.id);

        // Create a portal session
        const extId = req.body.extensionId || 'unknown';
        const portalSession = await stripe.billingPortal.sessions.create({
            customer: customer.id,
            return_url: SERVER_URL + '/payment-success?portal_return=true&extension_id=' + extId
        });

        console.log('✅ Portal session created:', portalSession.id);
        res.json({ url: portalSession.url });

    } catch (error) {
        console.error('❌ Portal session error:', error.message);
        res.status(500).json({ error: 'Failed to create portal session: ' + error.message });
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

            // 🔑 Get installation ID from metadata for device binding
            const installationId = session.metadata?.installation_id;
            console.log('🔑 Installation ID from session:', installationId);

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

            // 🔑 Store installation ID in Stripe customer metadata for device binding
            if (session.customer && installationId && installationId !== 'unknown') {
                try {
                    await stripe.customers.update(session.customer, {
                        metadata: {
                            installation_id: installationId
                        }
                    });
                    console.log('✅ Installation ID stored in Stripe customer metadata');
                } catch (metadataError) {
                    console.error('⚠️ Could not update customer metadata:', metadataError.message);
                }
            }

            // Mettre à jour le statut de l'utilisateur
            userSubscriptions[customerEmail] = {
                isPremium: true,
                plan: planName,
                activatedAt: new Date().toISOString(),
                lastPayment: new Date().toISOString(),
                status: 'active',
                installationId: installationId || null  // 🔑 Store locally too
            };

            // Sauvegarder les données
            await saveDataToFile();

            console.log(`✅ Premium activé pour: ${customerEmail} (${planName})`);
            console.log(`🔑 Device binding: ${installationId}`);

            // Envoyer un email de confirmation
            await sendActivationEmail(customerEmail, planName);

        } catch (error) {
            console.error('❌ Error processing webhook:', error);
            return res.status(500).json({ error: 'Internal server error' });
        }
    }

    // Handle subscription cancellation/deletion
    else if (event.type === 'customer.subscription.deleted' ||
        event.type === 'customer.subscription.canceled') {
        const subscription = event.data.object;
        console.log('🚫 Subscription cancelled/deleted:', subscription.id);

        try {
            // Get customer email from Stripe
            const customer = await stripe.customers.retrieve(subscription.customer);
            const customerEmail = customer.email;

            if (customerEmail && userSubscriptions[customerEmail]) {
                console.log(`🗑️ Removing premium status for: ${customerEmail}`);

                // Downgrade to free plan
                userSubscriptions[customerEmail] = {
                    isPremium: false,
                    plan: 'Free',
                    cancelledAt: new Date().toISOString(),
                    previousPlan: userSubscriptions[customerEmail]?.plan || 'Unknown',
                    status: 'cancelled'
                };

                saveDataToFile();
                console.log(`✅ User ${customerEmail} downgraded to Free plan`);
            } else {
                console.log(`⚠️ No local subscription found for customer: ${subscription.customer}`);
            }
        } catch (error) {
            console.error('❌ Error handling subscription deletion:', error);
        }
    }

    // Handle subscription updates (e.g., plan changes, payment failures)
    else if (event.type === 'customer.subscription.updated') {
        const subscription = event.data.object;
        console.log('🔄 Subscription updated:', subscription.id, 'Status:', subscription.status);

        try {
            const customer = await stripe.customers.retrieve(subscription.customer);
            const customerEmail = customer.email;

            if (customerEmail) {
                // Check if subscription is still active
                if (subscription.status === 'active' || subscription.status === 'trialing') {
                    // Subscription is active, ensure user has premium
                    const priceId = subscription.items?.data[0]?.price?.id;
                    let planName = 'Pro';

                    if (priceId === 'price_1SXINCJdBDLWAyB09C5II34Q') {
                        planName = 'Plus';
                    } else if (priceId === 'price_1SXIM2JdBDLWAyB0cVOcC25x') {
                        planName = 'Pro';
                    }

                    userSubscriptions[customerEmail] = {
                        isPremium: true,
                        plan: planName,
                        updatedAt: new Date().toISOString(),
                        status: subscription.status
                    };

                    console.log(`✅ Subscription active for ${customerEmail} (${planName})`);
                } else if (subscription.status === 'past_due' || subscription.status === 'unpaid') {
                    // Payment failed, mark as inactive
                    console.log(`⚠️ Payment issue for ${customerEmail}, status: ${subscription.status}`);

                    userSubscriptions[customerEmail] = {
                        ...userSubscriptions[customerEmail],
                        isPremium: false,
                        status: subscription.status,
                        paymentIssueAt: new Date().toISOString()
                    };
                } else if (subscription.status === 'canceled') {
                    // Subscription cancelled
                    userSubscriptions[customerEmail] = {
                        isPremium: false,
                        plan: 'Free',
                        cancelledAt: new Date().toISOString(),
                        status: 'cancelled'
                    };

                    console.log(`🚫 Subscription cancelled for ${customerEmail}`);
                }

                saveDataToFile();
            }
        } catch (error) {
            console.error('❌ Error handling subscription update:', error);
        }
    }

    // Handle invoice payment failure
    else if (event.type === 'invoice.payment_failed') {
        const invoice = event.data.object;
        console.log('❌ Invoice payment failed:', invoice.id);

        try {
            const customerEmail = invoice.customer_email;

            if (customerEmail && userSubscriptions[customerEmail]) {
                console.log(`⚠️ Payment failed for ${customerEmail}`);

                userSubscriptions[customerEmail] = {
                    ...userSubscriptions[customerEmail],
                    paymentFailed: true,
                    paymentFailedAt: new Date().toISOString(),
                    status: 'payment_failed'
                };

                saveDataToFile();
            }
        } catch (error) {
            console.error('❌ Error handling payment failure:', error);
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
    console.log('💰 Payment success (Auto Close) for extension:', extension_id);

    // Serve a simple HTML page with auto-close functionality ONLY
    res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>Payment Successful</title>
    <meta charset="utf-8">
    <style>
        body { font-family: 'Segoe UI', sans-serif; text-align: center; padding: 50px; background: #f0fdf4; color: #166534; }
        .container { max-width: 600px; margin: 0 auto; background: white; padding: 40px; border-radius: 12px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1); }
        h1 { color: #22c55e; margin-bottom: 10px; }
        .message { margin: 20px 0; font-size: 18px; color: #4b5563; }
    </style>
</head>
<body>
    <div class="container">
        <h1>Payment Successful!</h1>
        <div class="message">
            <p>Thank you! Your premium features are activated.</p>
            <p>You can close this tab and return to the extension.</p>
        </div>
    </div>
    <script>
        setTimeout(function() { window.close(); }, 3000);
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

// Clear database endpoint (for development only)
app.post('/api/clear-database', (req, res) => {
    try {
        // Clear in-memory data
        Object.keys(userSubscriptions).forEach(key => delete userSubscriptions[key]);
        Object.keys(verificationCodes).forEach(key => delete verificationCodes[key]);

        // Clear file data
        const emptyData = { userSubscriptions: {}, verificationCodes: {} };
        fs.writeFileSync(DATA_FILE, JSON.stringify(emptyData, null, 2));

        console.log('✅ Database cleared successfully');
        res.json({ success: true, message: 'Database cleared successfully' });
    } catch (error) {
        console.error('❌ Error clearing database:', error);
        res.status(500).json({ success: false, error: 'Failed to clear database' });
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