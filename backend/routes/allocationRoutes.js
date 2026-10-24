const router = require('express').Router();
const authenticate = require('../middleware/authMiddleware');
const { processRequest, matchRequest } = require('../controllers/allocationController');
const { clinicalHandler } = require('../controllers/workflowV2Controller');
router.post('/process/:request_id', authenticate, clinicalHandler('allocate'), processRequest);
router.post('/match/:request_id', authenticate, clinicalHandler('match'), matchRequest);
module.exports = router;
