require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const connectDB = require('./config/db');
const logger = require('./config/logger');
const apiRoutes = require('./routes/api');
const { seedAdminUser } = require('./controllers/authController');
const initCronJobs = require('./jobs/cronJobs');

const app = express();

// Connect to Database
connectDB().then(() => {
  // Seed initial Admin User if database is clean
  seedAdminUser();
});

// Middlewares
app.use(cors({
  origin: '*', // Allow all origins for internal tool ease
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve Static files for catalogue downloads
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// API Routes
app.use('/api', apiRoutes);

// Base route for status checks
app.get('/', (req, res) => {
  res.json({ status: 'healthy', service: 'Futurise Cold Email Automation API' });
});

// Error handling middleware
app.use((err, req, res, next) => {
  logger.error(`Express error: ${err.message}`, { stack: err.stack });
  res.status(err.status || 500).json({
    success: false,
    message: err.message || 'Internal Server Error'
  });
});

// Initialize Cron Jobs
initCronJobs();

// Start Server
const PORT = process.env.PORT || 5000;
const server = app.listen(PORT, () => {
  logger.info(`Server is running in ${process.env.NODE_ENV || 'development'} mode on port ${PORT}`);
});

process.on('unhandledRejection', (err) => {
  logger.error(`Unhandled Rejection: ${err.message}`);
  // Keep server running but log error
});
