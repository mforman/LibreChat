import { logger } from '@librechat/data-schemas';
import { DefaultAzureCredential } from '@azure/identity';
import { BlobServiceClient } from '@azure/storage-blob';
import type { ContainerClient } from '@azure/storage-blob';

let blobServiceClient: BlobServiceClient | null = null;
let managedIdentityCredential: DefaultAzureCredential | null = null;
let azureWarningLogged = false;

/**
 * Resolves the blob service endpoint. Honors AZURE_STORAGE_BLOB_ENDPOINT for
 * sovereign clouds and custom/emulator endpoints, falling back to the public
 * commercial-cloud host derived from the account name.
 */
const getBlobEndpoint = (accountName: string): string => {
  const override = process.env.AZURE_STORAGE_BLOB_ENDPOINT;
  if (override) {
    return override.replace(/\/+$/, '');
  }
  return `https://${accountName}.blob.core.windows.net`;
};

/**
 * Initializes the Azure Blob Service client.
 * Prefers an explicit connection string; otherwise authenticates with Managed
 * Identity (via a cached DefaultAzureCredential) against AZURE_STORAGE_ACCOUNT_NAME.
 * Container creation and its access level are handled in the CRUD layer.
 * @returns The initialized client, or null if the required configuration is missing.
 */
export const initializeAzureBlobService = (): BlobServiceClient | null => {
  if (blobServiceClient) {
    return blobServiceClient;
  }

  const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
  if (connectionString) {
    blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
    logger.info(
      '[initializeAzureBlobService] Azure Blob Service initialized using connection string',
    );
    return blobServiceClient;
  }

  const accountName = process.env.AZURE_STORAGE_ACCOUNT_NAME;
  if (!accountName) {
    if (!azureWarningLogged) {
      logger.error(
        '[initializeAzureBlobService] Azure Blob Service not initialized. Connection string missing and AZURE_STORAGE_ACCOUNT_NAME not provided.',
      );
      azureWarningLogged = true;
    }
    return null;
  }

  if (!managedIdentityCredential) {
    managedIdentityCredential = new DefaultAzureCredential();
  }
  blobServiceClient = new BlobServiceClient(
    getBlobEndpoint(accountName),
    managedIdentityCredential,
  );
  logger.info('[initializeAzureBlobService] Azure Blob Service initialized using Managed Identity');
  return blobServiceClient;
};

/**
 * Retrieves the Azure ContainerClient for the given container name.
 * @param [containerName=process.env.AZURE_CONTAINER_NAME || 'files'] - The container name.
 * @returns The Azure ContainerClient, or null when the service is not configured.
 */
export const getAzureContainerClient = (
  containerName: string = process.env.AZURE_CONTAINER_NAME || 'files',
): ContainerClient | null => {
  const serviceClient = initializeAzureBlobService();
  return serviceClient ? serviceClient.getContainerClient(containerName) : null;
};
