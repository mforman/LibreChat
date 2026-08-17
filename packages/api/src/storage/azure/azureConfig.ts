import { logger } from '@librechat/data-schemas';
import { isEnabled } from '~/utils/common';

const MAX_EXPIRY_SECONDS = 7 * 24 * 60 * 60; // 7 days (Azure SAS ceiling for account/service keys)
const DEFAULT_EXPIRY_SECONDS = 5 * 60; // 5 minutes

const parseUrlExpiry = (): number => {
  if (process.env.AZURE_URL_EXPIRY_SECONDS === undefined) {
    return DEFAULT_EXPIRY_SECONDS;
  }

  const parsed = parseInt(process.env.AZURE_URL_EXPIRY_SECONDS, 10);
  if (isNaN(parsed) || parsed <= 0) {
    logger.warn(
      `[Azure] Invalid AZURE_URL_EXPIRY_SECONDS value: "${process.env.AZURE_URL_EXPIRY_SECONDS}". Using ${DEFAULT_EXPIRY_SECONDS}s expiry.`,
    );
    return DEFAULT_EXPIRY_SECONDS;
  }

  return Math.min(parsed, MAX_EXPIRY_SECONDS);
};

const parseRefreshExpiry = (): number | null => {
  if (!process.env.AZURE_REFRESH_EXPIRY_MS) {
    return null;
  }

  const parsed = parseInt(process.env.AZURE_REFRESH_EXPIRY_MS, 10);
  if (isNaN(parsed) || parsed <= 0) {
    logger.warn(
      `[Azure] Invalid AZURE_REFRESH_EXPIRY_MS value: "${process.env.AZURE_REFRESH_EXPIRY_MS}". Using default refresh logic.`,
    );
    return null;
  }

  logger.info(`[Azure] Using custom refresh expiry time: ${parsed}ms`);
  return parsed;
};

// Internal module config — not part of the public @librechat/api surface
export const azureConfig: {
  /** Blob container name */
  AZURE_CONTAINER_NAME: string;
  /**
   * When true, containers are created with anonymous blob read and unsigned URLs
   * are served. Defaults to false: containers are private and URLs are SAS-signed.
   */
  AZURE_STORAGE_PUBLIC_ACCESS: boolean;
  /** SAS URL expiry in seconds (clamped to the 7-day ceiling) */
  AZURE_URL_EXPIRY_SECONDS: number;
  /** Custom refresh expiry in milliseconds (null = use default buffer logic) */
  AZURE_REFRESH_EXPIRY_MS: number | null;
} = {
  AZURE_CONTAINER_NAME: process.env.AZURE_CONTAINER_NAME || 'files',
  AZURE_STORAGE_PUBLIC_ACCESS: isEnabled(process.env.AZURE_STORAGE_PUBLIC_ACCESS),
  AZURE_URL_EXPIRY_SECONDS: parseUrlExpiry(),
  AZURE_REFRESH_EXPIRY_MS: parseRefreshExpiry(),
};
