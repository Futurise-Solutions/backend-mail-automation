const jwt = require('jsonwebtoken');
const User = require('../models/User');
const logger = require('../config/logger');

// Generate JWT token
const generateToken = (id) => {
  return jwt.sign(
    { id },
    process.env.JWT_SECRET || 'super_secret_jwt_key_futurise_solutions_123!',
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );
};

/**
 * Seed a default admin user if none exist
 */
exports.seedAdminUser = async () => {
  try {
    const adminExists = await User.findOne({ email: 'admin@futurisesolutions.com' });
    if (!adminExists) {
      await User.create({
        name: 'Futurise Admin',
        email: 'admin@futurisesolutions.com',
        password: 'AdminPassword123' // This will be automatically hashed by our pre-save hook
      });
      logger.info('Default admin account seeded successfully: admin@futurisesolutions.com / AdminPassword123');
    }
  } catch (err) {
    logger.error(`Error seeding admin user: ${err.message}`);
  }
};

/**
 * POST /login
 * Login Admin user
 */
exports.login = async (req, res) => {
  const { email, password } = req.body;

  try {
    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Please provide email and password' });
    }

    const user = await User.findOne({ email });
    if (!user) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    const token = generateToken(user._id);

    return res.status(200).json({
      success: true,
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email
      }
    });
  } catch (error) {
    logger.error(`Login error: ${error.message}`);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

/**
 * POST /logout
 * Logout user
 */
exports.logout = async (req, res) => {
  // Stateless JWT doesn't need server-side invalidation initially, but client will clear token
  return res.status(200).json({ success: true, message: 'Logged out successfully' });
};

/**
 * GET /validate
 * Validate token & return user details
 */
exports.validateToken = async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('-password');
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    return res.status(200).json({
      success: true,
      user: {
        id: user._id,
        name: user.name,
        email: user.email
      }
    });
  } catch (error) {
    logger.error(`Token validation error: ${error.message}`);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};
