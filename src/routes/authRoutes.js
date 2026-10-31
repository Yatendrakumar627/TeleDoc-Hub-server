const express = require('express');
const crypto = require('crypto');
const uuidv4 = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}_${Math.random().toString(36).substring(2, 9)}`);
const UserModel = require('../models/User');
const { hashPassword, comparePassword, generateToken, generateVaultSalt } = require('../utils/authUtil');
const { requireAuth } = require('../middleware/authMiddleware');
const indexManager = require('../utils/indexManager');

const router = express.Router();

// In-memory fallback if MongoDB is offline
const memoryUsers = [];

/**
 * GET /api/auth/status - Check if system has users registered
 */
router.get('/status', async (req, res) => {
  try {
    let count = 0;
    if (indexManager.isMongoConnected) {
      count = await UserModel.countDocuments();
    } else {
      count = memoryUsers.length;
    }

    res.json({
      success: true,
      hasUsers: count > 0,
      userCount: count,
      requireLogin: true,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/auth/register - Create a new user vault account
 */
router.post('/register', async (req, res) => {
  try {
    const { email, password, name } = req.body;

    if (!email || !email.trim()) {
      return res.status(400).json({ error: 'Email address is required.' });
    }

    const cleanEmail = email.trim().toLowerCase();
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(cleanEmail)) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }

    if (!password || password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters long.' });
    }

    // Check if user already exists
    if (indexManager.isMongoConnected) {
      const existing = await UserModel.findOne({ email: cleanEmail });
      if (existing) {
        return res.status(400).json({ error: 'An account with this email already exists.' });
      }
    } else {
      const existing = memoryUsers.find((u) => u.email === cleanEmail);
      if (existing) {
        return res.status(400).json({ error: 'An account with this email already exists.' });
      }
    }

    // Determine role (first registered user is admin)
    let role = 'user';
    let isFirstUser = false;
    if (indexManager.isMongoConnected) {
      const count = await UserModel.countDocuments();
      if (count === 0) {
        role = 'admin';
        isFirstUser = true;
      }
    } else if (memoryUsers.length === 0) {
      role = 'admin';
      isFirstUser = true;
    }

    const passwordHash = await hashPassword(password);
    const userId = uuidv4 ? uuidv4() : Date.now().toString();
    const vaultSalt = generateVaultSalt();

    let userRecord = null;
    if (indexManager.isMongoConnected) {
      userRecord = await UserModel.create({
        id: userId,
        email: cleanEmail,
        passwordHash,
        name: name ? name.trim() : cleanEmail.split('@')[0],
        role,
        vaultSalt,
        lastLoginAt: new Date(),
      });

      // If first user, claim any existing legacy documents into their personal vault
      if (isFirstUser) {
        await indexManager.claimLegacyDocuments(userId);
      }
    } else {
      userRecord = {
        id: userId,
        email: cleanEmail,
        passwordHash,
        name: name ? name.trim() : cleanEmail.split('@')[0],
        role,
        vaultSalt,
        lastLoginAt: new Date(),
      };
      memoryUsers.push(userRecord);
      if (isFirstUser) {
        await indexManager.claimLegacyDocuments(userId);
      }
    }

    const token = generateToken(userRecord);

    res.status(201).json({
      success: true,
      token,
      user: {
        id: userRecord.id,
        email: userRecord.email,
        name: userRecord.name,
        role: userRecord.role,
      },
      message: 'Vault account created successfully.',
    });
  } catch (err) {
    console.error('Registration error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/auth/login - Authenticate existing user
 */
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    const cleanEmail = email.trim().toLowerCase();

    let user = null;
    if (indexManager.isMongoConnected) {
      user = await UserModel.findOne({ email: cleanEmail });
    } else {
      user = memoryUsers.find((u) => u.email === cleanEmail);
    }

    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const isMatch = await comparePassword(password, user.passwordHash);
    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    // Update lastLoginAt
    if (indexManager.isMongoConnected) {
      await UserModel.updateOne({ id: user.id }, { $set: { lastLoginAt: new Date() } });
    } else {
      user.lastLoginAt = new Date();
    }

    const token = generateToken(user);

    res.json({
      success: true,
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
      },
      message: 'Welcome back to your secure vault.',
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/auth/me - Retrieve authenticated user profile
 */
router.get('/me', requireAuth, async (req, res) => {
  try {
    let user = null;
    if (indexManager.isMongoConnected) {
      user = await UserModel.findOne({ id: req.user.id }, '-passwordHash').lean();
    } else {
      user = memoryUsers.find((u) => u.id === req.user.id);
    }

    if (!user) {
      return res.status(404).json({ error: 'User not found.' });
    }

    res.json({
      success: true,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        lastLoginAt: user.lastLoginAt,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

