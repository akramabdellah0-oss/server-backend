// Import dependencies
const express = require('express');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const cors = require('cors');

// Load environment variables from .env file
require('dotenv').config();

const app = express();

// Middlewares
app.use(cors({ origin: '*' })); // Allow all origins for development. Restrict in production.
app.use(express.json());

// In-memory database (use a real DB in production)
const verificationCodes = {};

// --- Security: App Password ---
// IMPORTANT: Use a Google App Password for security, not your regular password.
// 1. Go to your Google Account: https://myaccount.google.com/
// 2. Go to "Security"
// 3. Under "Signing in to Google", enable "2-Step Verification"
// 4. Then, create an "App password" for Mail on your device.
// 5. Put the generated 16-character password in your .env file.

const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_APP_PASS = process.env.GMAIL_APP_PASS;

if (!GMAIL_USER || !GMAIL_APP_PASS) {
    console.error('❌ FATAL ERROR: GMAIL_USER and GMAIL_APP_PASS must be defined in your .env file.');
    process.exit(1); // Exit if credentials are not set
}

// Rate limiter to prevent abuse
const sendCodeLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 5, // Limit each IP to 5 requests per windowMs
    message: "Too many requests, please try again later.",
});

// SMTP Transporter (Gmail)
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: GMAIL_USER,
        pass: GMAIL_APP_PASS,
    },
});

// API Endpoints

// 1. Generate and send verification code
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
        // Send the e-mail
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

// 2. Verify the code
app.post('/api/verify-code', (req, res) => {
    const { email, code } = req.body;

    if (!email || !code) {
        return res.status(400).json({ error: 'Email and code are required' });
    }

    const record = verificationCodes[email];

    if (!record) {
        return res.status(400).json({ error: 'No verification code found for this email.' });
    }

    if (record.expiresAt < Date.now()) {
        delete verificationCodes[email]; // Clean up expired code
        return res.status(400).json({ error: 'Verification code has expired.' });
    }

    if (record.code !== code) {
        return res.status(400).json({ error: 'Invalid verification code.' });
    }

    // Code is valid, "activate subscription"
    delete verificationCodes[email]; // Remove the code after successful verification
    console.log(`✅ Subscription activated for ${email}`);
    res.json({ success: true, message: 'Verification successful. Subscription activated.' });
});

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));
