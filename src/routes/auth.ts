import { Router, Request, Response } from 'express';
import bcrypt from 'bcrypt';
import pool from '../db/connection';
import { authenticate, issueSanctumToken } from '../middleware/auth';

export const router = Router();

// POST /api/login/entity
router.post('/login/entity', async (req: Request, res: Response) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(422).json({ message: 'username and password required' });
  }
  try {
    const [rows] = await pool.query(
      'SELECT * FROM entities WHERE username = ? LIMIT 1',
      [username]
    );
    const list = rows as any[];
    if (!list.length || !(await bcrypt.compare(password, list[0].password))) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }
    const entity = list[0];
    delete entity.password;
    const token = await issueSanctumToken('App\\Models\\Entities', entity.id, 'entity-auth-token');
    return res.json({ message: 'Login successful', token, entity });
  } catch (err: any) {
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
});

// POST /api/login/kth
router.post('/login/kth', async (req: Request, res: Response) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(422).json({ message: 'username and password required' });
  }
  try {
    const [rows] = await pool.query('SELECT * FROM kth WHERE username = ? LIMIT 1', [username]);
    const list = rows as any[];
    if (!list.length || !(await bcrypt.compare(password, list[0].password))) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }
    const kth = list[0];
    delete kth.password;
    const token = await issueSanctumToken('App\\Models\\Kth', kth.id, 'kth-auth-token');
    return res.json({ message: 'Login successful', token, kth });
  } catch (err: any) {
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
});

// POST /api/login/farmer
router.post('/login/farmer', async (req: Request, res: Response) => {
  const { nik, password } = req.body || {};
  if (!nik || !password) {
    return res.status(422).json({ message: 'nik and password required' });
  }
  try {
    const [rows] = await pool.query('SELECT * FROM farmers WHERE nik = ? LIMIT 1', [nik]);
    const list = rows as any[];
    if (!list.length || !(await bcrypt.compare(password, list[0].password))) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }
    const farmer = list[0];
    delete farmer.password;
    const token = await issueSanctumToken('App\\Models\\Farmers', farmer.id, 'farmer-auth-token');
    return res.json({ message: 'Login successful', token, farmer });
  } catch (err: any) {
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
});

// GET /api/me — returns the authenticated user
router.get('/me', authenticate, (req: Request, res: Response) => {
  return res.json({ user: req.user });
});

// POST /api/logout — revoke current token
router.post('/logout', authenticate, async (req: Request, res: Response) => {
  if (!req.tokenId) return res.status(401).json({ message: 'Not authenticated.' });
  await pool.query('DELETE FROM personal_access_tokens WHERE id = ?', [req.tokenId]);
  return res.json({ message: 'Logged out successfully' });
});

export default router;
