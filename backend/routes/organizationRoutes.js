const express = require('express');
const authenticate = require('../middleware/authMiddleware');
const { registerOrganization, listStates, listCities, listOrganizations, updateOrganizationLocation } = require('../controllers/organizationController');
const router = express.Router();
const { directoryHandler } = require('../controllers/workflowV2Controller');

// Directory contains real registered provider names and locations, without account credentials.
router.post('/', registerOrganization);
router.get('/states', listStates);
router.get('/cities', directoryHandler(true), listCities);
router.get('/', directoryHandler(false), listOrganizations);
router.put('/me/location', authenticate, updateOrganizationLocation);

module.exports = router;
