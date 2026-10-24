const express = require('express');
const { createInventory, getInventory, updateInventory, checkAvailability } = require('../controllers/inventoryController');

const authenticate = require('../middleware/authMiddleware');
const router = express.Router();

router.use(authenticate);
router.use((req, res, next) => {
  if (!['blood_bank', 'organization'].includes(req.user.user_type)) {
    return res.status(403).json({ message: 'Blood Bank access is required.' });
  }
  return next();
});

// Specific check URL pehle rakhenge; stock logic controller mein rahega.
router.get('/check/:bank_id/:blood_group', checkAvailability);
router.post('/', createInventory);
router.get('/:bank_id', getInventory);
router.put('/:bank_id/:blood_group', updateInventory);

module.exports = router;
