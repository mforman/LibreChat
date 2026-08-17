import fs from 'fs';
import { Readable } from 'stream';
import { logger } from '@librechat/data-schemas';
import { FileSources } from 'librechat-data-provider';
import {
  SASProtocol,
  BlobSASPermissions,
  StorageSharedKeyCredential,
  generateBlobSASQueryParameters,
} from '@azure/storage-blob';
import type { UserDelegationKey, BlockBlobUploadOptions } from '@azure/storage-blob';
import type { TFile } from 'librechat-data-provider';
import type {
  GetURLParams,
  S3FileRef,
  BatchUpdateFn,
  SaveURLParams,
  SaveURLResult,
  UploadResult,
  SaveBufferParams,
  UploadFileParams,
  DownloadURLParams,
} from '~/storage/types';
import type { ServerRequest } from '~/types';
import {
  assertRemoteFileURL,
  getRemoteFileFetchMaxBytes,
  getRemoteFileFetchTimeoutMs,
  assertRemoteFileContentLength,
  createRemoteFileByteLimitTransform,
} from '~/storage/url';
import {
  assertPathSegment,
  assertS3FileName,
  sanitizeContentDispositionFilename,
} from '~/storage/validation';
import { DEFAULT_BASE_PATH as defaultBasePath } from '~/storage/constants';
import { initializeAzureBlobService, getAzureContainerClient } from '~/cdn/azure';
import { deleteRagFile } from '~/files';
import { azureConfig } from './azureConfig';

const CLOCK_SKEW_MS = 5 * 60 * 1000;
/** Request delegation keys valid for 6 days, comfortably under the 7-day service ceiling. */
const DELEGATION_KEY_TTL_MS = 6 * 24 * 60 * 60 * 1000;
const DELEGATION_REFRESH_BUFFER_MS = 5 * 60 * 1000;

interface UserDelegationCredential {
  key: UserDelegationKey;
  accountName: string;
}

let cachedDelegation: { credential: UserDelegationCredential; expiresOnMs: number } | null = null;

function getServiceClient() {
  const service = initializeAzureBlobService();
  if (!service) {
    throw new Error('[Azure] Blob service not initialized. Check Azure storage configuration.');
  }
  return service;
}

function getSharedKeyCredential(): StorageSharedKeyCredential | null {
  const credential = getServiceClient().credential;
  return credential instanceof StorageSharedKeyCredential ? credential : null;
}

/**
 * Returns a cached user delegation key (and its account name) for Managed
 * Identity SAS signing, refreshing it shortly before expiry. Acquiring the key
 * is a round trip to Entra ID, so it is cached module-level rather than fetched
 * per URL.
 */
async function getUserDelegationCredential(): Promise<UserDelegationCredential> {
  const now = Date.now();
  if (cachedDelegation && cachedDelegation.expiresOnMs - DELEGATION_REFRESH_BUFFER_MS > now) {
    return cachedDelegation.credential;
  }

  const service = getServiceClient();
  const startsOn = new Date(now - CLOCK_SKEW_MS);
  const expiresOn = new Date(now + DELEGATION_KEY_TTL_MS);
  const key = await service.getUserDelegationKey(startsOn, expiresOn);
  const credential: UserDelegationCredential = { key, accountName: service.accountName };
  cachedDelegation = { credential, expiresOnMs: expiresOn.getTime() };
  return credential;
}

interface SignOptions {
  contentDisposition?: string;
  contentType?: string;
}

/**
 * Produces an HTTPS-only, read-only SAS URL for a blob. Uses the account
 * shared key when a connection string is configured, otherwise a Managed
 * Identity user delegation key. Never returns an unsigned URL.
 */
async function signBlobUrl(blobPath: string, options: SignOptions = {}): Promise<string> {
  const containerName = azureConfig.AZURE_CONTAINER_NAME;
  const now = Date.now();
  const sasValues = {
    containerName,
    blobName: blobPath,
    permissions: BlobSASPermissions.parse('r'),
    protocol: SASProtocol.Https,
    startsOn: new Date(now - CLOCK_SKEW_MS),
    expiresOn: new Date(now + azureConfig.AZURE_URL_EXPIRY_SECONDS * 1000),
    ...(options.contentDisposition ? { contentDisposition: options.contentDisposition } : {}),
    ...(options.contentType ? { contentType: options.contentType } : {}),
  };

  const sharedKey = getSharedKeyCredential();
  const sas = sharedKey
    ? generateBlobSASQueryParameters(sasValues, sharedKey).toString()
    : await (async () => {
        const { key, accountName } = await getUserDelegationCredential();
        return generateBlobSASQueryParameters(sasValues, key, accountName).toString();
      })();

  const blobUrl = getServiceClient()
    .getContainerClient(containerName)
    .getBlockBlobClient(blobPath).url;
  return `${blobUrl}?${sas}`;
}

function getUnsignedBlobUrl(blobPath: string): string {
  return getServiceClient()
    .getContainerClient(azureConfig.AZURE_CONTAINER_NAME)
    .getBlockBlobClient(blobPath).url;
}

/** Resolves the URL for a stored blob: unsigned when the container is public, SAS-signed otherwise. */
async function resolveBlobUrl(blobPath: string, options: SignOptions = {}): Promise<string> {
  if (azureConfig.AZURE_STORAGE_PUBLIC_ACCESS) {
    return getUnsignedBlobUrl(blobPath);
  }
  return signBlobUrl(blobPath, options);
}

function getAzureBlobPath({
  basePath,
  userId,
  fileName,
}: {
  basePath: string;
  userId?: string | null;
  fileName: string;
}): string {
  const safeBasePath = assertPathSegment('basePath', basePath, 'getAzureBlobPath');
  const safeFileName = assertS3FileName('fileName', fileName, 'getAzureBlobPath');
  if (userId) {
    const safeUserId = assertPathSegment('userId', userId, 'getAzureBlobPath');
    return `${safeBasePath}/${safeUserId}/${safeFileName}`;
  }
  return `${safeBasePath}/${safeFileName}`;
}

async function ensureContainer(): Promise<void> {
  const container = getAzureContainerClient(azureConfig.AZURE_CONTAINER_NAME);
  if (!container) {
    throw new Error('[Azure] Blob service not initialized. Check Azure storage configuration.');
  }
  if (azureConfig.AZURE_STORAGE_PUBLIC_ACCESS) {
    await container.createIfNotExists({ access: 'blob' });
  } else {
    await container.createIfNotExists();
  }
}

/**
 * Extracts the container-relative blob key from a stored filepath. Handles
 * virtual-hosted (`https://acct.blob.core.windows.net/container/key`),
 * path-style / Azurite (`http://127.0.0.1:10000/account/container/key`), and
 * already-bare keys. Query strings (SAS tokens) are ignored.
 */
export function extractKeyFromAzureUrl(fileUrlOrKey: string): string {
  if (!fileUrlOrKey) {
    throw new Error('[extractKeyFromAzureUrl] Invalid input: URL or key is empty');
  }

  if (!fileUrlOrKey.startsWith('http://') && !fileUrlOrKey.startsWith('https://')) {
    return fileUrlOrKey.replace(/^\/+/, '');
  }

  const url = new URL(fileUrlOrKey);
  const containerName = azureConfig.AZURE_CONTAINER_NAME;
  const segments = url.pathname
    .replace(/^\/+/, '')
    .split('/')
    .map((segment) => decodeURIComponent(segment));

  const containerIdx = segments.indexOf(containerName);
  if (containerIdx >= 0) {
    return segments.slice(containerIdx + 1).join('/');
  }

  logger.warn(
    `[extractKeyFromAzureUrl] Container "${containerName}" not found in path "${url.pathname}"; falling back to URL style detection.`,
  );
  const isVirtualHosted = url.hostname.includes('.blob.');
  return segments.slice(isVirtualHosted ? 1 : 2).join('/');
}

export function resolveStoredAzureKey(
  file: Pick<TFile, 'filepath'> & { storageKey?: string | null },
): string {
  return file.storageKey || extractKeyFromAzureUrl(file.filepath);
}

/** Computes the storage key persisted for an Azure blob so refresh avoids re-parsing URLs. */
export function getAzureStorageMetadataForKey(
  key: string,
): Pick<SaveURLResult, 'storageKey' | 'storageRegion'> {
  const normalizedKey = key.replace(/^\/+/, '');
  return normalizedKey ? { storageKey: normalizedKey } : {};
}

export async function getAzureURL({
  userId,
  fileName,
  basePath = defaultBasePath,
  customFilename = null,
  contentType = null,
}: GetURLParams): Promise<string> {
  const blobPath = getAzureBlobPath({ basePath, userId, fileName });
  const contentDisposition = customFilename
    ? `attachment; filename="${sanitizeContentDispositionFilename(customFilename)}"`
    : undefined;
  return resolveBlobUrl(blobPath, {
    ...(contentDisposition ? { contentDisposition } : {}),
    ...(contentType ? { contentType } : {}),
  });
}

export async function getAzureDownloadURL({
  file,
  customFilename = null,
  contentType = null,
}: DownloadURLParams): Promise<string> {
  const blobPath = resolveStoredAzureKey(file);
  if (!blobPath) {
    throw new Error('[getAzureDownloadURL] Unable to extract blob key from file path');
  }
  const contentDisposition = customFilename
    ? `attachment; filename="${sanitizeContentDispositionFilename(customFilename)}"`
    : undefined;
  return resolveBlobUrl(blobPath, {
    ...(contentDisposition ? { contentDisposition } : {}),
    ...(contentType ? { contentType } : {}),
  });
}

export async function saveBufferToAzure({
  userId,
  buffer,
  fileName,
  basePath = defaultBasePath,
}: SaveBufferParams): Promise<string> {
  await ensureContainer();
  const blobPath = getAzureBlobPath({ basePath, userId, fileName });
  await getServiceClient()
    .getContainerClient(azureConfig.AZURE_CONTAINER_NAME)
    .getBlockBlobClient(blobPath)
    .uploadData(buffer);
  return resolveBlobUrl(blobPath);
}

export async function saveURLToAzureWithMetadata({
  userId,
  URL: sourceURL,
  fileName,
  basePath = defaultBasePath,
}: SaveURLParams): Promise<SaveURLResult> {
  const maxBytes = getRemoteFileFetchMaxBytes();
  const response = await fetch(assertRemoteFileURL(sourceURL), {
    signal: AbortSignal.timeout(getRemoteFileFetchTimeoutMs()),
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch URL: ${response.status} ${response.statusText}`);
  }
  assertRemoteFileContentLength(response.headers, maxBytes);
  const contentType = response.headers.get('content-type') ?? '';

  if (!response.body) {
    throw new Error('[saveURLToAzure] Remote response had no body');
  }
  const limited = Readable.fromWeb(
    response.body as unknown as Parameters<typeof Readable.fromWeb>[0],
  ).pipe(createRemoteFileByteLimitTransform(maxBytes));

  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of limited) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    chunks.push(buffer);
    bytes += buffer.length;
  }
  const buffer = Buffer.concat(chunks, bytes);

  await ensureContainer();
  const blobPath = getAzureBlobPath({ basePath, userId, fileName });
  const uploadOptions: BlockBlobUploadOptions = contentType
    ? { blobHTTPHeaders: { blobContentType: contentType } }
    : {};
  await getServiceClient()
    .getContainerClient(azureConfig.AZURE_CONTAINER_NAME)
    .getBlockBlobClient(blobPath)
    .uploadData(buffer, uploadOptions);

  return {
    filepath: await resolveBlobUrl(blobPath),
    ...getAzureStorageMetadataForKey(blobPath),
    bytes,
    type: contentType,
    dimensions: {},
  };
}

export async function uploadFileToAzure({
  req,
  file,
  file_id,
  basePath = defaultBasePath,
}: UploadFileParams): Promise<UploadResult> {
  if (!req.user) {
    throw new Error('[uploadFileToAzure] User not authenticated');
  }

  await ensureContainer();
  const userId = req.user.id;
  const fileName = `${file_id}__${file.originalname}`;
  const blobPath = getAzureBlobPath({ basePath, userId, fileName });
  const stats = await fs.promises.stat(file.path);
  const bytes = stats.size;

  const uploadOptions: BlockBlobUploadOptions = file.mimetype
    ? { blobHTTPHeaders: { blobContentType: file.mimetype } }
    : {};

  await getServiceClient()
    .getContainerClient(azureConfig.AZURE_CONTAINER_NAME)
    .getBlockBlobClient(blobPath)
    .uploadStream(fs.createReadStream(file.path), undefined, undefined, uploadOptions);

  return {
    filepath: await resolveBlobUrl(blobPath),
    bytes,
    ...getAzureStorageMetadataForKey(blobPath),
  };
}

export async function deleteFileFromAzure(req: ServerRequest, file: TFile): Promise<void> {
  const userId = req.user?.id;
  if (!userId) {
    throw new Error('[deleteFileFromAzure] User not authenticated');
  }

  await deleteRagFile({ userId, file });

  const container = getAzureContainerClient(azureConfig.AZURE_CONTAINER_NAME);
  if (!container) {
    throw new Error('[Azure] Blob service not initialized. Check Azure storage configuration.');
  }

  const blobPath = resolveStoredAzureKey(file);
  if (!blobPath.includes(userId)) {
    throw new Error('[deleteFileFromAzure] User ID not found in blob path');
  }

  try {
    await container.getBlockBlobClient(blobPath).delete();
    logger.debug('[deleteFileFromAzure] Blob deleted successfully from Azure Blob Storage');
  } catch (error) {
    if ((error as { statusCode?: number }).statusCode === 404) {
      return;
    }
    logger.error('[deleteFileFromAzure] Error deleting blob:', error);
    throw error;
  }
}

/**
 * Streams a blob using the service credential (Managed Identity or shared key),
 * so private containers are readable server-side without a public URL.
 */
export async function getAzureFileStream(
  _req: ServerRequest,
  fileURLOrKey: string,
): Promise<Readable> {
  const container = getAzureContainerClient(azureConfig.AZURE_CONTAINER_NAME);
  if (!container) {
    throw new Error('[Azure] Blob service not initialized. Check Azure storage configuration.');
  }
  const blobPath = extractKeyFromAzureUrl(fileURLOrKey);
  const download = await container.getBlockBlobClient(blobPath).download();
  if (!download.readableStreamBody) {
    throw new Error(`[getAzureFileStream] Empty download body for blob: ${blobPath}`);
  }
  return download.readableStreamBody as Readable;
}

/**
 * Whether a stored Azure URL should be re-signed before use.
 *
 * Unlike S3, an *unsigned* URL is treated as needing a refresh when the
 * container is private: after cutover, legacy public blob URLs already persisted
 * in the database must be SAS-signed on read or they 404. When the container is
 * public, unsigned URLs are the norm and never need refreshing.
 */
export function needsRefreshAzure(signedUrl: string, bufferSeconds: number): boolean {
  try {
    const url = new URL(signedUrl);
    if (!url.searchParams.has('sig')) {
      return !azureConfig.AZURE_STORAGE_PUBLIC_ACCESS;
    }

    const expiry = url.searchParams.get('se');
    if (!expiry) {
      return true;
    }
    const expiresAtMs = new Date(expiry).getTime();
    if (Number.isNaN(expiresAtMs)) {
      return true;
    }

    const now = Date.now();
    const start = url.searchParams.get('st');
    if (azureConfig.AZURE_REFRESH_EXPIRY_MS !== null && start) {
      const startAtMs = new Date(start).getTime();
      if (!Number.isNaN(startAtMs)) {
        return now - startAtMs >= azureConfig.AZURE_REFRESH_EXPIRY_MS;
      }
    }

    return expiresAtMs <= now + bufferSeconds * 1000;
  } catch (error) {
    logger.error('[Azure] Error checking URL expiration:', error);
    return true;
  }
}

export async function getNewAzureURL(
  currentURL: string,
  storageKey?: string | null,
): Promise<string | undefined> {
  try {
    const blobPath = storageKey || extractKeyFromAzureUrl(currentURL);
    if (!blobPath) {
      return;
    }
    return await resolveBlobUrl(blobPath);
  } catch (error) {
    logger.error('[Azure] Error getting new Azure URL:', error);
  }
}

export async function refreshAzureFileUrls(
  files: TFile[] | null | undefined,
  batchUpdateFiles: BatchUpdateFn,
  bufferSeconds = 3600,
): Promise<TFile[]> {
  if (!files || !Array.isArray(files) || files.length === 0) {
    return [];
  }

  const filesToUpdate: Array<{ file_id: string; filepath: string; storageKey?: string }> = [];
  const updatedFiles = [...files];

  for (let i = 0; i < updatedFiles.length; i++) {
    const file = updatedFiles[i];
    if (!file?.file_id || file.source !== FileSources.azure_blob || !file.filepath) {
      continue;
    }
    if (!needsRefreshAzure(file.filepath, bufferSeconds)) {
      continue;
    }

    try {
      const newURL = await getNewAzureURL(file.filepath, file.storageKey);
      if (!newURL) {
        continue;
      }
      const storageMetadata = getAzureStorageMetadataForKey(
        file.storageKey || extractKeyFromAzureUrl(file.filepath),
      );
      filesToUpdate.push({ file_id: file.file_id, filepath: newURL, ...storageMetadata });
      updatedFiles[i] = { ...file, filepath: newURL, ...storageMetadata };
    } catch (error) {
      logger.error(`[Azure] Error refreshing URL for file ${file.file_id}:`, error);
    }
  }

  if (filesToUpdate.length > 0) {
    await batchUpdateFiles(filesToUpdate);
  }

  return updatedFiles;
}

export async function refreshAzureUrl(fileObj: S3FileRef, bufferSeconds = 3600): Promise<string> {
  if (!fileObj || fileObj.source !== FileSources.azure_blob || !fileObj.filepath) {
    return fileObj?.filepath || '';
  }

  if (!needsRefreshAzure(fileObj.filepath, bufferSeconds)) {
    return fileObj.filepath;
  }

  try {
    const blobPath = fileObj.storageKey || extractKeyFromAzureUrl(fileObj.filepath);
    if (!blobPath) {
      logger.warn(`[Azure] Unable to extract blob key from URL: ${fileObj.filepath}`);
      return fileObj.filepath;
    }
    return await resolveBlobUrl(blobPath);
  } catch (error) {
    logger.error(`[Azure] Error refreshing URL: ${(error as Error).message}`);
    return fileObj.filepath;
  }
}
