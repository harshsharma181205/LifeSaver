const router = require('express').Router();
const authenticate = require('../middleware/authMiddleware');
const { confirmDonation } = require('../controllers/donationController');
const { clinicalHandler } = require('../controllers/workflowV2Controller');
router.post('/:request_id', authenticate, clinicalHandler('collect'), confirmDonation);
module.exports = router;
