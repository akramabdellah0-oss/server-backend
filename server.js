// server.js - Complete & Updated for Render/Neon/Stripe

// 1. Imports
require('dotenv').config(); // Load .env if running locally
const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY); 
const { Pool } = require('pg');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// 2. Database Connection (Neon/PostgreSQL)
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false } // Required for Neon/Render
});

// 3. CORS Configuration
app.use(cors());

// ===============================================
// ROUTE 1: STRIPE WEBHOOK (Must be defined BEFORE express.json)
// ===============================================
// This triggers when Stripe tells us "Payment Successful"
app.post('/webhook', express.raw({type: 'application/json'}), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

    let event;

    try {
        // Verify that the request actually came from Stripe
        event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
    } catch (err) {
        console.error(`⚠️  Webhook Signature Verification Failed: ${err.message}`);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Handle the event
    if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        
        // Retrieve data sent from payment.js
        const googleId = session.metadata.google_id;
        const customerEmail = session.customer_details.email;
        const stripeCustomerId = session.customer;

        console.log(`💰 Payment received for User: ${googleId} (${customerEmail})`);

        try {
            // Save/Update License in Neon DB
            // This SQL works for both new users (INSERT) and existing users (UPDATE)
            const query = `
                INSERT INTO users (google_id, email, is_premium, stripe_customer_id, updated_at)
                VALUES ($1, $2, true, $3, NOW())
                ON CONFLICT (google_id) 
                DO UPDATE SET is_premium = true, stripe_customer_id = $3, updated_at = NOW();
            `;
            
            await pool.query(query, [googleId, customerEmail, stripeCustomerId]);
            console.log("✅ Database updated: License Active");
            
        } catch (dbError) {
            console.error("❌ Database Error:", dbError);
        }
    }
    // Handle Subscription Cancellation (Optional but recommended)
    else if (event.type === 'customer.subscription.deleted') {
        const session = event.data.object;
        const stripeCustomerId = session.customer;
        
        try {
            // Revoke license
            await pool.query('UPDATE users SET is_premium = false WHERE stripe_customer_id = $1', [stripeCustomerId]);
            console.log("⚠️ Subscription deleted. License revoked.");
        } catch (err) {
            console.error("Error revoking license:", err);
        }
    }

    res.json({received: true});
});

// 4. Global Middleware (JSON Parser for other routes)
app.use(express.json());


// ===============================================
// ROUTE 2: CREATE CHECKOUT SESSION
// ===============================================
app.post('/api/create-checkout-session', async (req, res) => {
    // We accept 'priceId' directly from payment.js to be flexible
    const { priceId, userId, successUrl, cancelUrl } = req.body; 

    if (!priceId || !userId) {
        return res.status(400).json({ error: "Missing priceId or userId" });
    }

    try {
        const session = await stripe.checkout.sessions.create({
            mode: 'subscription',
            payment_method_types: ['card'],
            line_items: [{ price: priceId, quantity: 1 }],
            
            // Critical: Pass User ID to Webhook
            metadata: {
                google_id: userId
            },
            
            // URLs where user goes after payment
            success_url: successUrl || 'https://google.com?payment_success=true',
            cancel_url: cancelUrl || 'https://google.com?payment_cancelled=true',
        });

        // Send the URL back to the extension
        res.json({ url: session.url });

    } catch (error) {
        console.error("Stripe Checkout Error:", error);
        res.status(500).json({ error: error.message });
    }
});


// ===============================================
// ROUTE 3: CHECK LICENSE STATUS
// ===============================================
app.get('/api/check-license', async (req, res) => {
    const { user_id } = req.query;

    if (!user_id) {
        return res.status(400).json({ error: "User ID required" });
    }

    try {
        const result = await pool.query('SELECT is_premium, email FROM users WHERE google_id = $1', [user_id]);
        
        if (result.rows.length > 0) {
            const user = result.rows[0];
            return res.json({ 
                is_premium: user.is_premium, 
                plan: user.is_premium ? 'Premium' : 'Free'
            });
        } else {
            // User not found in DB = Free User
            return res.json({ is_premium: false, plan: 'Free' });
        }

    } catch (err) {
        console.error("Database Error:", err);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

// 5. Start Server
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});