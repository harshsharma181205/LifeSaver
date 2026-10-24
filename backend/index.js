const express = require('express');//Express library ko backend mein laata hai.
const cors = require('cors');//React frontend ko backend API access karne ki permission dene ke liye.
require('dotenv').config();//.env file ke environment variables load karega. Baad mein DB credentials yahin se lenge.
const donorRoutes = require('./routes/donorRoutes');
// Recipient endpoints ko alag router se connect kar rahe hain.
const recipientRoutes = require('./routes/recipientRoutes');
// Login endpoints ko alag authentication router se connect karenge.
const authRoutes = require('./routes/authRoutes');
// Blood request endpoints ko alag router mein rakhenge.
const requestRoutes = require('./routes/requestRoutes');
// Blood bank stock endpoints ke liye separate inventory router hai.
const inventoryRoutes = require('./routes/inventoryRoutes');
const bankRoutes = require('./routes/bankRoutes');
// Bank-first request processing ke liye alag router hai.
const allocationRoutes = require('./routes/allocationRoutes');
// In-app notifications ke liye separate router hai.
const notificationRoutes = require('./routes/notificationRoutes');
// Admin reports ke liye separate router hai.
const adminRoutes = require('./routes/adminRoutes');
const organizationRoutes = require('./routes/organizationRoutes');
const screeningRoutes = require('./routes/screeningRoutes');
const donationRoutes = require('./routes/donationRoutes');
const app = express();//Express application create hoti hai.
const PORT = process.env.PORT || 5000;//Agar .env mein PORT diya hai to woh use hoga, otherwise 5000.

app.use(cors());//cors() ? frontend-backend communication
app.use(express.json());//express.json() ? JSON request body read karne ke liye

app.get('/', (req, res) => {
  res.json({ message: 'LifeSaver backend is running' });
});//Jab browser/Postman:
// GET http://localhost:5000/
// request bhejta hai, backend JSON response deta hai.

app.use('/api/donors', donorRoutes);
// Router ka POST / yahan POST /api/recipients banega.
app.use('/api/recipients', recipientRoutes);
// Donor, recipient aur blood bank login /api/auth ke andar milenge.
app.use('/api/auth', authRoutes);
app.use('/api/organizations', organizationRoutes);
app.use('/api/screenings', screeningRoutes);
app.use('/api/donations', donationRoutes);
// Request create aur list endpoints /api/requests par milenge.
app.use('/api/requests', requestRoutes);
// Existing modules ko badle bina inventory router mount kar rahe hain.
app.use('/api/inventory', inventoryRoutes);
app.use('/api/blood-banks', bankRoutes);
// Existing registration/request/inventory logic ko badle bina processing mount karenge.
app.use('/api/allocations', allocationRoutes);
// Notification routes ka logic controller aur services handle karenge.
app.use('/api/notifications', notificationRoutes);
// Read-only admin report endpoints mount karenge.
app.use('/api/admin', adminRoutes);

// Return JSON when a request contains malformed JSON.
app.use((error, req, res, next) => {
  if (error.type === 'entity.too.large') {
    return res.status(413).json({ message: 'Request body is too large.' });
  }
  if (error.type === 'entity.parse.failed') {
    return res.status(400).json({ message: 'Invalid JSON request body.' });
  }
  return res.status(500).json({ message: 'Internal server error.' });
});

app.listen(PORT, () => {
  console.log(`LifeSaver backend is running on port ${PORT}`);
  require('./services/cityWideFallbackReconciler').startFallbackReconciliation(require('./db'));
});//Server ko specified port par start karta hai.
