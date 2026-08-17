import { FileSources } from 'librechat-data-provider';
import type { TFile } from 'librechat-data-provider';
import type { S3FileRef, BatchUpdateFn } from '~/storage/types';
import { refreshS3Url, refreshS3FileUrls } from '~/storage/s3/crud';
import { refreshAzureUrl, refreshAzureFileUrls } from '~/storage/azure/crud';

export { REFRESHABLE_FILE_SOURCES, isRefreshableSource } from '~/storage/constants';

type BatchRefresher = (
  files: TFile[] | null | undefined,
  batchUpdateFiles: BatchUpdateFn,
  bufferSeconds?: number,
) => Promise<TFile[]>;

type SingleRefresher = (fileObj: S3FileRef, bufferSeconds?: number) => Promise<string>;

const BATCH_URL_REFRESHERS: Record<string, BatchRefresher> = {
  [FileSources.s3]: refreshS3FileUrls,
  [FileSources.azure_blob]: refreshAzureFileUrls,
};

const SINGLE_URL_REFRESHERS: Record<string, SingleRefresher> = {
  [FileSources.s3]: refreshS3Url,
  [FileSources.azure_blob]: refreshAzureUrl,
};

/**
 * Refreshes any expiring signed URLs in a file list, dispatched by the deployment's
 * file strategy. No-ops for strategies whose URLs do not expire.
 */
export async function refreshFileUrls(
  source: string | null | undefined,
  files: TFile[] | null | undefined,
  batchUpdateFiles: BatchUpdateFn,
  bufferSeconds?: number,
): Promise<TFile[]> {
  const refresher = source ? BATCH_URL_REFRESHERS[source] : undefined;
  if (!refresher) {
    return files ?? [];
  }
  return refresher(files, batchUpdateFiles, bufferSeconds);
}

/**
 * Refreshes a single expiring signed URL, dispatched by the file's own source.
 * Returns the original filepath unchanged for non-refreshable sources.
 */
export async function refreshFileUrl(fileObj: S3FileRef, bufferSeconds?: number): Promise<string> {
  const refresher = fileObj?.source ? SINGLE_URL_REFRESHERS[fileObj.source] : undefined;
  if (!refresher) {
    return fileObj?.filepath ?? '';
  }
  return refresher(fileObj, bufferSeconds);
}
