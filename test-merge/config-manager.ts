// Configuration manager for application settings and environment handling.
// Supports loading from files, environment variables, and runtime overrides.

// ============================================================
// SECTION 1: Imports and Constants
// ============================================================
import * as fs from "fs";
import * as path from "path";

const CONFIG_FILE_NAME = "app.config.json";
const ENV_PREFIX = "APP_";
const MAX_CACHE_SIZE = 100;
const DEFAULT_LOG_LEVEL = "info";

// ============================================================
// SECTION 2: Types
// ============================================================
interface AppConfig {
  port: number;
  host: string;
  logLevel: "debug" | "info" | "warn" | "error";
  database: {
    url: string;
    poolSize: number;
    timeout: number;
  };
  features: Record<string, boolean>;
}

type ConfigOverride = Partial<AppConfig>;

// ============================================================
// SECTION 3: ConfigManager class
// ============================================================
export class ConfigManager {
  private config: AppConfig;
  private overrides: Map<string, unknown>;
  private configPath: string;

  constructor(basePath: string) {
    this.configPath = path.join(basePath, CONFIG_FILE_NAME);
    this.overrides = new Map();
    this.config = this.loadDefaults();
  }

  // ----------------------------------------------------------
  // SECTION 3a: Loading and parsing configuration
  // ----------------------------------------------------------
  loadFromFile(): AppConfig {
    if (!fs.existsSync(this.configPath)) {
      throw new Error(`Config file not found: ${this.configPath}`);
    }

    const raw = fs.readFileSync(this.configPath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<AppConfig>;

    this.config = {
      ...this.config,
      ...parsed,
      database: {
        ...this.config.database,
        ...(parsed.database ?? {}),
      },
    };

    return this.config;
  }

  loadFromEnv(): void {
    const envPort = process.env[`${ENV_PREFIX}PORT`];
    if (envPort) {
      this.config.port = parseInt(envPort, 10);
    }

    const envHost = process.env[`${ENV_PREFIX}HOST`];
    if (envHost) {
      this.config.host = envHost;
    }

    const envLogLevel = process.env[`${ENV_PREFIX}LOG_LEVEL`];
    if (envLogLevel) {
      this.config.logLevel = envLogLevel as AppConfig["logLevel"];
    }

    const envDbUrl = process.env[`${ENV_PREFIX}DATABASE_URL`];
    if (envDbUrl) {
      this.config.database.url = envDbUrl;
    }
  }

  // ----------------------------------------------------------
  // SECTION 3b: Default configuration builder
  // ----------------------------------------------------------
  private loadDefaults(): AppConfig {
    return {
      port: 3000,
      host: "localhost",
      logLevel: DEFAULT_LOG_LEVEL as AppConfig["logLevel"],
      database: {
        url: "postgres://localhost:5432/app",
        poolSize: 10,
        timeout: 5000,
      },
      features: {},
    };
  }

  // ----------------------------------------------------------
  // SECTION 3c: Runtime overrides and feature flags
  // ----------------------------------------------------------
  setOverride(key: string, value: unknown): void {
    if (this.overrides.size >= MAX_CACHE_SIZE) {
      const firstKey = this.overrides.keys().next().value;
      if (firstKey !== undefined) {
        this.overrides.delete(firstKey);
      }
    }
    this.overrides.set(key, value);
  }

  getOverride(key: string): unknown | undefined {
    return this.overrides.get(key);
  }

  isFeatureEnabled(featureName: string): boolean {
    const override = this.overrides.get(`feature.${featureName}`);
    if (typeof override === "boolean") {
      return override;
    }
    return this.config.features[featureName] ?? false;
  }

  // ----------------------------------------------------------
  // SECTION 3d: Getters and export
  // ----------------------------------------------------------
  getConfig(): Readonly<AppConfig> {
    return Object.freeze({ ...this.config });
  }

  getDatabaseConfig(): Readonly<AppConfig["database"]> {
    return Object.freeze({ ...this.config.database });
  }

  exportToJson(): string {
    return JSON.stringify(this.config, null, 2);
  }
}
