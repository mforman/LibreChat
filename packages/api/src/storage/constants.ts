import { FileSources } from 'librechat-data-provider';

/** Default base path for cloud-stored files (used by all storage strategies). */
export const DEFAULT_BASE_PATH = 'images';

/** Storage sources whose stored URLs are time-limited and refreshed on read. */
export const REFRESHABLE_FILE_SOURCES: ReadonlySet<string> = new Set<string>([
  FileSources.s3,
  FileSources.azure_blob,
]);

export const isRefreshableSource = (source: string | null | undefined): boolean =>
  source != null && REFRESHABLE_FILE_SOURCES.has(source);

/** Shared avatar base path for cloud-stored public/avatar assets. */
export const AVATAR_BASE_PATH = 'avatars';

/** CloudFront cookie path prefix for private inline images. */
export const INLINE_IMAGE_PATH_PREFIX = 'i';

/** CloudFront cookie path prefix for app-visible avatars. */
export const INLINE_AVATAR_PATH_PREFIX = 'a';
