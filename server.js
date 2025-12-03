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

// --- SendGrid Configuration ---
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;

// Rate limiter to prevent abuse
const sendCodeLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 5, // Limit each IP to 5 requests per windowMs
    message: "Too many requests, please try again later.",
});

// ✅ SMTP Transporter (SendGrid) - FIXES THE TIMEOUT ISSUE
let transporter;

// Only create transporter if API key exists
if (SENDGRID_API_KEY) {
    transporter = nodemailer.createTransport({
        host: 'smtp.sendgrid.net',
        port: 587, // Use 587 for STARTTLS (not 465)
        secure: false, // true for 465, false for other ports
        auth: {
            user: 'apikey', // ← THIS IS LITERALLY THE WORD 'apikey' (not your username)
            pass: SENDGRID_API_KEY // Your actual SendGrid API key
        },
        // Optional: Increase timeouts for reliability
        connectionTimeout: 60000, // 60 seconds
        socketTimeout: 60000,
        greetingTimeout: 30000
    });

    // Test connection on startup
    transporter.verify(function(error, success) {
        if (error) {
            console.error('❌ SendGrid connection failed:', error.message);
            console.log('💡 Tips:');
            console.log('   1. Make sure SENDGRID_API_KEY is correct');
            console.log('   2. Check your API key has "Mail Send" permission');
            console.log('   3. Verify in SendGrid dashboard: Settings → API Keys');
        } else {
            console.log('✅ SendGrid SMTP server is ready to send emails');
        }
    });
} else {
    console.warn('⚠️  SendGrid API key not found. Email functionality will be disabled.');
    console.log('ℹ️  To enable emails, add SENDGRID_API_KEY to environment variables');
}

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
    if (!transporter) {
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
            from: process.env.EMAIL_FROM || '"Autofill App" <noreply@autofillapp.com>',
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

        const info = await transporter.sendMail(mailOptions);

        console.log(`✅ Verification code sent to ${email}`);
        console.log('📧 SendGrid Message ID:', info.messageId);

        res.json({ success: true, message: 'Verification code sent.' });
    } catch (error) {
        console.error('❌ SendGrid Error:', error.message);
        
        // User-friendly error messages
        let errorMessage = 'Failed to send verification code. Please try again.';
        
        if (error.code === 'EAUTH') {
            errorMessage = 'Email service authentication failed.';
        } else if (error.code === 'EENVELOPE') {
            errorMessage = 'Invalid email address.';
        }

        res.status(500).json({ 
            error: errorMessage,
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
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📧 Email service: ${SENDGRID_API_KEY ? 'SendGrid (Ready)' : 'Disabled - No API Key'}`);
    console.log(`🔗 Endpoints:`);
    console.log(`   POST /api/send-verification-code`);
    console.log(`   POST /api/verify-code`);
    console.log(`   GET  /api/check-license`);
    console.log(`   POST /api/create-checkout-session`);
});