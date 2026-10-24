const express = require('express');
const { donorLogin, recipientLogin, organizationLogin, bloodBankLogin, getCurrentUser } = require('../controllers/authController');
const authenticate = require('../middleware/authMiddleware');
const router = express.Router();

router.post('/donor/login', donorLogin);
router.post('/recipient/login', recipientLogin);
router.post('/organization/login', organizationLogin);
router.post('/blood-bank/login', bloodBankLogin);
router.get('/me', authenticate, getCurrentUser);

module.exports = router;
