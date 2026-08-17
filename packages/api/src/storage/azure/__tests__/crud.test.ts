import type { TFile } from 'librechat-data-provider';
import type { S3FileRef } from '~/storage/types';

/** FileSources enum string values, referenced directly to keep this suite hermetic. */
const SOURCE_S3 = 's3';
const SOURCE_AZURE = 'azure_blob';

const ACCOUNT = 'testacct';
const CONTAINER = 'files';
const BLOB_HOST = `https://${ACCOUNT}.blob.core.windows.net`;

type MockBlobClient = {
  url: string;
  uploadData: jest.Mock;
  uploadStream: jest.Mock;
  delete: jest.Mock;
  download: jest.Mock;
};

const mockBlobClients = new Map<string, MockBlobClient>();

const makeBlobClient = (blobPath: string): MockBlobClient => {
  if (!mockBlobClients.has(blobPath)) {
    mockBlobClients.set(blobPath, {
      url: `${BLOB_HOST}/${CONTAINER}/${blobPath}`,
      uploadData: jest.fn().mockResolvedValue({}),
      uploadStream: jest.fn().mockResolvedValue({}),
      delete: jest.fn().mockResolvedValue({}),
      download: jest.fn().mockResolvedValue({ readableStreamBody: { pipe: jest.fn() } }),
    });
  }
  return mockBlobClients.get(blobPath) as MockBlobClient;
};

class MockSharedKeyCredential {
  constructor(public accountName: string) {}
}

const mockState: {
  useSharedKey: boolean;
  getUserDelegationKey: jest.Mock;
  createIfNotExists: jest.Mock;
} = {
  useSharedKey: false,
  getUserDelegationKey: jest.fn(),
  createIfNotExists: jest.fn().mockResolvedValue({}),
};

const mockContainerClient = {
  createIfNotExists: (...args: unknown[]) => mockState.createIfNotExists(...args),
  getBlockBlobClient: (blobPath: string) => makeBlobClient(blobPath),
};

const mockServiceClient = {
  accountName: ACCOUNT,
  get credential() {
    return mockState.useSharedKey ? new MockSharedKeyCredential(ACCOUNT) : { kind: 'token' };
  },
  getUserDelegationKey: (...args: unknown[]) => mockState.getUserDelegationKey(...args),
  getContainerClient: () => mockContainerClient,
};

const mockGenerateBlobSAS = jest.fn((..._args: unknown[]) => ({
  toString: () => 'sig=FAKESIG&se=2999-01-01T00%3A00%3A00Z',
}));

jest.mock('~/cdn/azure', () => ({
  initializeAzureBlobService: jest.fn(() => mockServiceClient),
  getAzureContainerClient: jest.fn(() => mockContainerClient),
}));

jest.mock('@azure/storage-blob', () => ({
  generateBlobSASQueryParameters: mockGenerateBlobSAS,
  BlobSASPermissions: { parse: jest.fn((perm: string) => ({ read: perm.includes('r'), perm })) },
  SASProtocol: { Https: 'https' },
  StorageSharedKeyCredential: MockSharedKeyCredential,
}));

jest.mock('~/files', () => ({ deleteRagFile: jest.fn().mockResolvedValue(undefined) }));

jest.mock('@librechat/data-schemas', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

type Crud = typeof import('../crud');

const loadCrud = async (env: Record<string, string | undefined> = {}): Promise<Crud> => {
  jest.resetModules();
  process.env.AZURE_CONTAINER_NAME = CONTAINER;
  process.env.AZURE_STORAGE_PUBLIC_ACCESS = env.AZURE_STORAGE_PUBLIC_ACCESS ?? 'false';
  process.env.AZURE_URL_EXPIRY_SECONDS = env.AZURE_URL_EXPIRY_SECONDS ?? '300';
  if (env.AZURE_REFRESH_EXPIRY_MS === undefined) {
    delete process.env.AZURE_REFRESH_EXPIRY_MS;
  } else {
    process.env.AZURE_REFRESH_EXPIRY_MS = env.AZURE_REFRESH_EXPIRY_MS;
  }
  const crud: Crud = await import('../crud');
  return crud;
};

describe('Azure CRUD', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    mockBlobClients.clear();
    mockState.useSharedKey = false;
    mockState.getUserDelegationKey = jest
      .fn()
      .mockResolvedValue({ signedObjectId: 'oid', value: 'delegation-key' });
    mockState.createIfNotExists = jest.fn().mockResolvedValue({});
    mockGenerateBlobSAS.mockClear();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe('extractKeyFromAzureUrl', () => {
    it('extracts the key from a virtual-hosted URL, ignoring the SAS query', async () => {
      const { extractKeyFromAzureUrl } = await loadCrud();
      const url = `${BLOB_HOST}/${CONTAINER}/images/user1/file.png?sv=2024&sig=abc&se=2030`;
      expect(extractKeyFromAzureUrl(url)).toBe('images/user1/file.png');
    });

    it('extracts the key from a path-style / Azurite URL', async () => {
      const { extractKeyFromAzureUrl } = await loadCrud();
      const url = `http://127.0.0.1:10000/devstoreaccount1/${CONTAINER}/images/user1/file.png`;
      expect(extractKeyFromAzureUrl(url)).toBe('images/user1/file.png');
    });

    it('returns a bare key unchanged, stripping leading slashes', async () => {
      const { extractKeyFromAzureUrl } = await loadCrud();
      expect(extractKeyFromAzureUrl('images/user1/file.png')).toBe('images/user1/file.png');
      expect(extractKeyFromAzureUrl('/images/user1/file.png')).toBe('images/user1/file.png');
    });

    it('throws on empty input', async () => {
      const { extractKeyFromAzureUrl } = await loadCrud();
      expect(() => extractKeyFromAzureUrl('')).toThrow();
    });
  });

  describe('needsRefreshAzure', () => {
    it('flags a legacy unsigned URL for signing when the container is private', async () => {
      const { needsRefreshAzure } = await loadCrud({ AZURE_STORAGE_PUBLIC_ACCESS: 'false' });
      expect(needsRefreshAzure(`${BLOB_HOST}/${CONTAINER}/images/u/f.png`, 3600)).toBe(true);
    });

    it('never refreshes an unsigned URL when the container is public', async () => {
      const { needsRefreshAzure } = await loadCrud({ AZURE_STORAGE_PUBLIC_ACCESS: 'true' });
      expect(needsRefreshAzure(`${BLOB_HOST}/${CONTAINER}/images/u/f.png`, 3600)).toBe(false);
    });

    it('does not refresh a signed URL that is not near expiry', async () => {
      const { needsRefreshAzure } = await loadCrud();
      const se = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      const url = `${BLOB_HOST}/${CONTAINER}/images/u/f.png?sig=x&se=${encodeURIComponent(se)}`;
      expect(needsRefreshAzure(url, 60)).toBe(false);
    });

    it('refreshes a signed URL within the buffer window', async () => {
      const { needsRefreshAzure } = await loadCrud();
      const se = new Date(Date.now() + 30 * 1000).toISOString();
      const url = `${BLOB_HOST}/${CONTAINER}/images/u/f.png?sig=x&se=${encodeURIComponent(se)}`;
      expect(needsRefreshAzure(url, 3600)).toBe(true);
    });

    it('refreshes a signed URL missing the expiry param', async () => {
      const { needsRefreshAzure } = await loadCrud();
      expect(needsRefreshAzure(`${BLOB_HOST}/${CONTAINER}/images/u/f.png?sig=x`, 60)).toBe(true);
    });

    it('refreshes on malformed input', async () => {
      const { needsRefreshAzure } = await loadCrud();
      expect(needsRefreshAzure('not a url', 60)).toBe(true);
    });

    it('honors AZURE_REFRESH_EXPIRY_MS by URL age', async () => {
      const { needsRefreshAzure } = await loadCrud({ AZURE_REFRESH_EXPIRY_MS: '1000' });
      const st = new Date(Date.now() - 5000).toISOString();
      const se = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      const url = `${BLOB_HOST}/${CONTAINER}/images/u/f.png?sig=x&st=${encodeURIComponent(st)}&se=${encodeURIComponent(se)}`;
      expect(needsRefreshAzure(url, 60)).toBe(true);
    });
  });

  describe('getAzureURL signing', () => {
    it('returns an unsigned URL when the container is public', async () => {
      const { getAzureURL } = await loadCrud({ AZURE_STORAGE_PUBLIC_ACCESS: 'true' });
      const url = await getAzureURL({ userId: 'u', fileName: 'f.png', basePath: 'images' });
      expect(url).toBe(`${BLOB_HOST}/${CONTAINER}/images/u/f.png`);
      expect(mockGenerateBlobSAS).not.toHaveBeenCalled();
    });

    it('signs with HTTPS-only, read-only SAS when private with a shared key', async () => {
      mockState.useSharedKey = true;
      const { getAzureURL } = await loadCrud();
      const url = await getAzureURL({ userId: 'u', fileName: 'f.png', basePath: 'images' });
      expect(url).toContain(`${BLOB_HOST}/${CONTAINER}/images/u/f.png?`);
      expect(url).toContain('sig=FAKESIG');
      expect(mockState.getUserDelegationKey).not.toHaveBeenCalled();
      const sasValues = mockGenerateBlobSAS.mock.calls[0][0] as Record<string, unknown>;
      expect(sasValues.protocol).toBe('https');
      expect(sasValues.blobName).toBe('images/u/f.png');
      expect(sasValues.containerName).toBe(CONTAINER);
      expect((sasValues.permissions as { read: boolean }).read).toBe(true);
    });

    it('signs with a Managed Identity delegation key and caches it across calls', async () => {
      const crud = await loadCrud();
      await crud.getAzureURL({ userId: 'u', fileName: 'a.png', basePath: 'images' });
      await crud.getAzureURL({ userId: 'u', fileName: 'b.png', basePath: 'images' });
      expect(mockState.getUserDelegationKey).toHaveBeenCalledTimes(1);
      const [key, accountName] = mockGenerateBlobSAS.mock.calls[0].slice(1);
      expect(key).toEqual({ signedObjectId: 'oid', value: 'delegation-key' });
      expect(accountName).toBe(ACCOUNT);
    });
  });

  describe('refreshAzureUrl', () => {
    it('leaves non-Azure files untouched', async () => {
      const { refreshAzureUrl } = await loadCrud();
      const fileObj: S3FileRef = {
        source: SOURCE_S3,
        filepath: 'https://bucket.s3/x?sig=y',
      };
      expect(await refreshAzureUrl(fileObj)).toBe('https://bucket.s3/x?sig=y');
      expect(mockGenerateBlobSAS).not.toHaveBeenCalled();
    });

    it('re-signs a legacy unsigned Azure URL on a private container', async () => {
      mockState.useSharedKey = true;
      const { refreshAzureUrl } = await loadCrud();
      const fileObj: S3FileRef = {
        source: SOURCE_AZURE,
        filepath: `${BLOB_HOST}/${CONTAINER}/images/u/legacy.png`,
      };
      const refreshed = await refreshAzureUrl(fileObj);
      expect(refreshed).toContain('sig=FAKESIG');
      expect(mockGenerateBlobSAS).toHaveBeenCalledTimes(1);
    });
  });

  describe('refreshAzureFileUrls', () => {
    it('re-signs only expiring azure_blob files and batch-persists them', async () => {
      mockState.useSharedKey = true;
      const { refreshAzureFileUrls } = await loadCrud();
      const batchUpdateFiles = jest.fn().mockResolvedValue(undefined);
      const files = [
        {
          file_id: '1',
          source: SOURCE_AZURE,
          filepath: `${BLOB_HOST}/${CONTAINER}/images/u/old.png`,
        },
        { file_id: '2', source: SOURCE_S3, filepath: 'https://bucket.s3/x?sig=y' },
      ] as unknown as TFile[];

      const updated = await refreshAzureFileUrls(files, batchUpdateFiles);

      expect(batchUpdateFiles).toHaveBeenCalledTimes(1);
      const persisted = batchUpdateFiles.mock.calls[0][0] as Array<{
        file_id: string;
        storageKey?: string;
      }>;
      expect(persisted).toHaveLength(1);
      expect(persisted[0].file_id).toBe('1');
      expect(persisted[0].storageKey).toBe('images/u/old.png');
      expect(updated[0].filepath).toContain('sig=FAKESIG');
      expect(updated[1].filepath).toBe('https://bucket.s3/x?sig=y');
    });
  });

  describe('getAzureStorageMetadataForKey', () => {
    it('returns the normalized blob key as the storage key', async () => {
      const { getAzureStorageMetadataForKey } = await loadCrud();
      expect(getAzureStorageMetadataForKey('/images/u/f.png')).toEqual({
        storageKey: 'images/u/f.png',
      });
      expect(getAzureStorageMetadataForKey('')).toEqual({});
    });
  });
});
