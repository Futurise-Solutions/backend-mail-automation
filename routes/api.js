const express = require('express');
const router = express.Router();

const authController = require('../controllers/authController');
const leadController = require('../controllers/leadController');
const settingsController = require('../controllers/settingsController');

const { protect } = require('../middleware/auth');
const { uploadPdf, uploadCsv } = require('../middleware/upload');

// ==========================================
// Authentication Routes
// ==========================================
router.post('/login', authController.login);
router.post('/logout', authController.logout);
router.get('/validate', protect, authController.validateToken);

// ==========================================
// Lead Management Routes
// ==========================================
router.post('/leads/upload', protect, uploadCsv.single('file'), leadController.uploadLeads);
router.get('/leads', protect, leadController.getLeads);
router.get('/lead/:id', protect, leadController.getLeadById);
router.put('/lead/:id', protect, leadController.updateLead);
router.delete('/lead/:id', protect, leadController.deleteLead);

// Campaign Send Actions (including SSE batches)
router.post('/lead/send', protect, leadController.triggerBatchSend);
router.post('/lead/send-single', protect, leadController.sendSingleEmail);
router.post('/lead/followup', protect, leadController.triggerFollowupBatch);

// Reply Operations
router.post('/lead/reply', protect, leadController.recordReply);
router.post('/lead/suggest-reply', protect, leadController.suggestReply);

// ==========================================
// Configuration & Settings Routes
// ==========================================
router.get('/settings', protect, settingsController.getSettings);
router.put('/settings', protect, uploadPdf.single('catalogue'), settingsController.updateSettings);

// ==========================================
// Dashboard Analytics Routes
// ==========================================
router.get('/dashboard', protect, leadController.getDashboardStats);

module.exports = router;
