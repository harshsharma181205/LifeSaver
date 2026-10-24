const express = require('express');
const { getDashboard, getRequestReport, getDonorReport, getInventoryReport,
  getDonationReport, getAllocationReport } = require('../controllers/adminController');

const router = express.Router();

// Reports current client roles ko cross-user data nahi denge.
const authenticate = require('../middleware/authMiddleware');
router.use(authenticate);
router.use((req, res, next) => {
  if (req.user.user_type !== 'admin') {
    return res.status(403).json({ message: 'Admin authorization is required for reports.' });
  }
  next();
});
router.get('/dashboard', getDashboard);
router.get('/reports/requests', getRequestReport);
router.get('/reports/donors', getDonorReport);
router.get('/reports/inventory', getInventoryReport);
router.get('/reports/donations', getDonationReport);
router.get('/reports/allocations', getAllocationReport);

// Is module ke unsupported URLs/methods safe JSON 404 return karenge.
router.use((req, res) => {
  res.status(404).json({ message: 'Admin report endpoint not found.' });
});

module.exports = router;
