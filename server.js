// Import dependencies
const express = require('express');
const nodemailer = require('nodemailer');
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

// Middlewares
app.use(cors({ origin: '*' })); // Allow all origins for development. Restrict in production.
app.use(express.json());

// --- IN-MEMORY DATABASES ---
// Note: In production, replace these with a real database (MongoDB, PostgreSQL, etc.)
const verificationCodes = {};
const userSubscriptions = {}; // Stores license status: { 'email@example.com': { isPremium: true, plan: 'Pro' } }

// --- Security: App Password ---
const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_APP_PASS = process.env.GMAIL_APP_PASS;

if (!GMAIL_USER || !GMAIL_APP_PASS) {
    console.error('❌ FATAL ERROR: GMAIL_USER and GMAIL_APP_PASS must be defined in your .env file.');
    process.exit(1);
}

// Rate limiter to prevent abuse
const sendCodeLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 5, // Limit each IP to 5 requests per windowMs
    message: "Too many requests, please try again later.",
});

// SMTP Transporter (Gmail)
// UPDATED: Using Port 587 (STARTTLS) instead of default 465 to fix ETIMEDOUT on Render
const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 587,
    secure: false, // true for 465, false for other ports
    auth: {
        user: GMAIL_USER,
        pass: GMAIL_APP_PASS,
    },
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

    // Generate a 6-digit code
    const code = crypto.randomInt(100000, 999999).toString();

    // Save the code with a 10-minute expiration
    verificationCodes[email] = { code, expiresAt: Date.now() + 10 * 60 * 1000 };

    try {
        await transporter.sendMail({
            from: `"Autofill App" <${GMAIL_USER}>`,
            to: email,
            subject: 'Your Verification Code',
            text: `Your verification code is: ${code}`,
        });

        console.log(`✅ Verification code sent to ${email}: ${code}`);
        res.json({ success: true, message: 'Verification code sent.' });
    } catch (error) {
        console.error('❌ Error sending email:', error);
        res.status(500).json({ error: 'Failed to send verification code.' });
    }
});

/**
 * 2. Verify the code
 */
app.post('/api/verify-code', (req, res) => {
    const { email, code } = req.body;

    if (!email || !code) return res.status(400).json({ error: 'Email and code required' });

    const record = verificationCodes[email];

    if (!record) return res.status(400).json({ error: 'No code found for this email.' });
    if (record.expiresAt < Date.now()) {
        delete verificationCodes[email];
        return res.status(400).json({ error: 'Code expired.' });
    }
    if (record.code !== code) return res.status(400).json({ error: 'Invalid code.' });

    // Code is valid. Initialize user in DB if not exists.
    delete verificationCodes[email];
    
    if (!userSubscriptions[email]) {
        userSubscriptions[email] = { isPremium: false, plan: 'Free' };
    }

    console.log(`✅ Email verified: ${email}`);
    res.json({ success: true, message: 'Email verified.' });
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
 * NOTE: This is a MOCK implementation for demonstration.
 * In production, you would use the 'stripe' library here.
 */
app.post('/api/create-checkout-session', (req, res) => {
    const { priceId, userId, successUrl, cancelUrl } = req.body;

    if (!userId || !priceId) {
        return res.status(400).json({ error: 'Missing userId or priceId' });
    }

    console.log(`💰 Creating checkout for ${userId} (${priceId})`);

    // --- MOCK PAYMENT LOGIC ---
    // Since we don't have your Stripe Secret Key, we simulate a successful payment.
    // In a real app, you'd create a Stripe session here.
    
    // We instantly upgrade the user in memory for this demo
    userSubscriptions[userId] = {
        isPremium: true,
        plan: priceId.includes('pro') ? 'Pro' : 'Plus' // Simple guess based on ID
    };

    console.log(`✅ [MOCK] Upgraded ${userId} to Premium`);

    // Redirect the frontend directly to the success URL
    res.json({ url: successUrl });
});

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));