const router = require('express').Router();
const authenticate = require('../middleware/authMiddleware');
const { recordScreening } = require('../controllers/screeningController');
const { clinicalHandler } = require('../controllers/workflowV2Controller');
router.post('/:request_id', authenticate, clinicalHandler('screen'), recordScreening);
module.exports = router;
