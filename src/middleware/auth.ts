import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import pool from '../db/connection';

// Sanctum-compatible auth: tokens live in `personal_access_tokens` (shared with Laravel).
// Token format: "{id}|{plaintext}". DB stores sha256(plaintext).

export type UserKind = 'Entities' | 'Kth' | 'Farmers';

export interface AuthUser {
  id: number;
  type: UserKind;
  data: any;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
      tokenId?: number;
    }
  }
}

export async function authenticate(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Token not provided.' });
  }

  const tokenString = header.slice('Bearer '.length).trim();
  const parts = tokenString.split('|');
  if (parts.length !== 2) {
    return res.status(400).json({ message: 'Invalid token format.' });
  }

  const [tokenId, plaintext] = parts;
  const hashed = crypto.createHash('sha256').update(plaintext).digest('hex');

  try {
    const [rows] = await pool.query(
      'SELECT id, tokenable_type, tokenable_id, expires_at FROM personal_access_tokens WHERE id = ? AND token = ? LIMIT 1',
      [tokenId, hashed]
    );
    const tokens = rows as any[];
    if (!tokens.length) {
      return res.status(401).json({ message: 'Invalid token.' });
    }
    const tk = tokens[0];
    if (tk.expires_at && new Date(tk.expires_at) < new Date()) {
      return res.status(401).json({ message: 'Token expired.' });
    }

    // Resolve user from tokenable_type
    const typeMap: Record<string, { table: string; key: UserKind }> = {
      'App\\Models\\Entities': { table: 'entities', key: 'Entities' },
      'App\\Models\\Kth':      { table: 'kth',      key: 'Kth' },
      'App\\Models\\Farmers':  { table: 'farmers',  key: 'Farmers' },
    };
    const meta = typeMap[tk.tokenable_type];
    if (!meta) {
      return res.status(401).json({ message: 'Unknown user type.' });
    }
    const [userRows] = await pool.query(
      `SELECT * FROM \`${meta.table}\` WHERE id = ? LIMIT 1`,
      [tk.tokenable_id]
    );
    const userArr = userRows as any[];
    if (!userArr.length) {
      return res.status(401).json({ message: 'User not found.' });
    }
    const user = userArr[0];
    delete user.password;

    req.tokenId = tk.id;
    req.user = { id: user.id, type: meta.key, data: user };

    // touch last_used_at (fire-and-forget)
    pool.query('UPDATE personal_access_tokens SET last_used_at = NOW() WHERE id = ?', [tk.id])
      .catch(() => undefined);

    next();
  } catch (err: any) {
    return res.status(500).json({ message: 'Auth error.', error: err.message });
  }
}

// Restrict to entity users only (spreadsheet is entity-only per current scope).
export function requireEntity(req: Request, res: Response, next: NextFunction) {
  if (!req.user || req.user.type !== 'Entities') {
    return res.status(403).json({ message: 'Entity access only.' });
  }
  next();
}

// Issue a Sanctum-compatible token. Returns the plaintext "{id}|{rand}" the client should store.
export async function issueSanctumToken(
  tokenableType: 'App\\Models\\Entities' | 'App\\Models\\Kth' | 'App\\Models\\Farmers',
  tokenableId: number,
  name: string
): Promise<string> {
  const plaintext = crypto.randomBytes(40).toString('hex').slice(0, 40);
  const hashed = crypto.createHash('sha256').update(plaintext).digest('hex');
  const [result] = await pool.query(
    `INSERT INTO personal_access_tokens (tokenable_type, tokenable_id, name, token, abilities, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, NOW(), NOW())`,
    [tokenableType, tokenableId, name, hashed, '["*"]']
  );
  const id = (result as any).insertId;
  return `${id}|${plaintext}`;
}
