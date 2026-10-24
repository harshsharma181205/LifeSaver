const express = require('express');
const { registerRecipient } = require('../controllers/recipientController');

const router = express.Router();

// Registration logic controller mein hai; router sirf endpoint connect karta hai.
router.post('/', registerRecipient);

module.exports = router;
