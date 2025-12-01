// server.js

// Load .env file only in development
if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}

const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY); 
const { Pool } = require('pg');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

app.use(cors());

// --- WEBHOOK (MUST BE BEFORE express.json) ---
app.post('/webhook', express.raw({type: 'application/json'}), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;
    let event;

    try {
        event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
    } catch (err) {
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        const googleId = session.metadata.google_id;
        const email = session.customer_details.email;
        const stripeCustomerId = session.customer;

        try {
            const query = `
                INSERT INTO users (google_id, email, is_premium, stripe_customer_id, updated_at)
                VALUES ($1, $2, true, $3, NOW())
                ON CONFLICT (google_id) 
                DO UPDATE SET is_premium = true, stripe_customer_id = $3, updated_at = NOW();
            `;
            await pool.query(query, [googleId, email, stripeCustomerId]);
            console.log(`✅ License activated for ${googleId}`);
        } catch (err) { console.error("DB Error:", err); }
    }
    res.json({received: true});
});

app.use(express.json());

// ============================================================
// 👇 THIS IS THE ROUTE THAT WAS MISSING OR NAMED WRONG 👇
// ============================================================
app.post('/api/create-checkout-session', async (req, res) => {
    console.log("💰 Checkout request received:", req.body); // Log request

    const { priceId, userId } = req.body; 

    if (!priceId || !userId) {
        return res.status(400).json({ error: "Missing priceId or userId" });
    }

    try {
        const session = await stripe.checkout.sessions.create({
            mode: 'subscription',
            payment_method_types: ['card'],
            line_items: [{ price: priceId, quantity: 1 }],
            metadata: { google_id: userId },
            success_url: 'https://www.google.com?payment_success=true',
            cancel_url: 'https://www.google.com?payment_cancelled=true',
        });

        // Respond with the URL
        res.json({ url: session.url });

    } catch (error) {
        console.error("❌ Stripe Error:", error.message);
        res.status(500).json({ error: error.message });
    }
});

// --- CHECK LICENSE ROUTE ---
app.get('/api/check-license', async (req, res) => {
    const { user_id } = req.query;
    if (!user_id) return res.status(400).json({ error: "User ID required" });

    try {
        const result = await pool.query('SELECT is_premium FROM users WHERE google_id = $1', [user_id]);
        if (result.rows.length > 0) {
            return res.json({ 
                is_premium: result.rows[0].is_premium, 
                plan: result.rows[0].is_premium ? 'Premium' : 'Free'
            });
        }
        return res.json({ is_premium: false, plan: 'Free' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "DB Error" });
    }
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
