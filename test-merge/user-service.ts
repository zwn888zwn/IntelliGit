// User service module for managing user accounts and authentication.
// Provides CRUD operations, session management, and role-based access control.

// ============================================================
// SECTION 1: Imports and Constants
// ============================================================
import { Database } from "./database";
import { Logger } from "./logger";
import { hashPassword, verifyPassword } from "./crypto";

const MAX_LOGIN_ATTEMPTS = 5;
const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const DEFAULT_ROLE = "viewer";
const PASSWORD_MIN_LENGTH = 8;

// ============================================================
// SECTION 2: Types
// ============================================================
interface User {
  id: string;
  email: string;
  name: string;
  role: "admin" | "editor" | "viewer";
  createdAt: Date;
  lastLogin: Date | null;
}

interface Session {
  token: string;
  userId: string;
  expiresAt: Date;
}

// ============================================================
// SECTION 3: UserService class
// ============================================================
export class UserService {
  private db: Database;
  private logger: Logger;

  constructor(db: Database, logger: Logger) {
    this.db = db;
    this.logger = logger;
  }

  // ----------------------------------------------------------
  // SECTION 3a: Core authentication method
  // ----------------------------------------------------------
  async authenticate(email: string, password: string): Promise<Session | null> {
    const user = await this.db.findUserByEmail(email);
    if (!user) {
      this.logger.warn(`Login attempt for unknown email: ${email}`);
      return null;
    }

    const attempts = await this.db.getLoginAttempts(user.id);
    if (attempts >= MAX_LOGIN_ATTEMPTS) {
      this.logger.error(`Account locked for user: ${user.id}`);
      return null;
    }

    const valid = await verifyPassword(password, user.passwordHash);
    if (!valid) {
      await this.db.incrementLoginAttempts(user.id);
      this.logger.warn(`Failed login for user: ${user.id}`);
      return null;
    }

    await this.db.resetLoginAttempts(user.id);
    const session = await this.createSession(user.id);
    this.logger.info(`User ${user.id} authenticated successfully`);
    return session;
  }

  // ----------------------------------------------------------
  // SECTION 3b: User creation
  // ----------------------------------------------------------
  async createUser(email: string, name: string, password: string): Promise<User> {
    if (password.length < PASSWORD_MIN_LENGTH) {
      throw new Error(`Password must be at least ${PASSWORD_MIN_LENGTH} characters`);
    }

    const existing = await this.db.findUserByEmail(email);
    if (existing) {
      throw new Error("Email already registered");
    }

    const passwordHash = await hashPassword(password);
    const user = await this.db.insertUser({
      email,
      name,
      passwordHash,
      role: DEFAULT_ROLE,
      createdAt: new Date(),
      lastLogin: null,
    });

    this.logger.info(`Created user: ${user.id}`);
    return user;
  }

  // ----------------------------------------------------------
  // SECTION 3c: Session management helpers
  // ----------------------------------------------------------
  private async createSession(userId: string): Promise<Session> {
    const token = this.generateToken();
    const expiresAt = new Date(Date.now() + SESSION_TIMEOUT_MS);

    await this.db.insertSession({ token, userId, expiresAt });
    return { token, userId, expiresAt };
  }

  private generateToken(): string {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let result = "";
    for (let i = 0; i < 64; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
  }

  async validateSession(token: string): Promise<User | null> {
    const session = await this.db.findSession(token);
    if (!session || session.expiresAt < new Date()) {
      return null;
    }
    return this.db.findUserById(session.userId);
  }

  // ----------------------------------------------------------
  // SECTION 3d: Role and permission utilities
  // ----------------------------------------------------------
  async updateRole(userId: string, newRole: User["role"]): Promise<void> {
    const user = await this.db.findUserById(userId);
    if (!user) {
      throw new Error("User not found");
    }
    await this.db.updateUser(userId, { role: newRole });
    this.logger.info(`Updated role for ${userId} to ${newRole}`);
  }

  hasPermission(user: User, action: string): boolean {
    const permissions: Record<User["role"], string[]> = {
      admin: ["read", "write", "delete", "manage"],
      editor: ["read", "write"],
      viewer: ["read"],
    };
    return permissions[user.role]?.includes(action) ?? false;
  }
}
