const express = require('express');
const authenticate = require('../middleware/authMiddleware');
const { listBloodBanks, getBloodBank } = require('../controllers/bankController');
const router = express.Router();

// Signed donor, recipient aur blood bank ko safe contact details milenge.
router.use(authenticate);
router.get('/', listBloodBanks);
router.get('/:bankId', getBloodBank);

module.exports = router;
