import { DefaultAzureCredential } from '@azure/identity';
import { BlobServiceClient } from '@azure/storage-blob';
import type { ImportFormat } from './format';

export const MAX_EXPORT_ARTIFACT_BYTES = 25 * 1024 * 1024;
export const EXPORT_TTL_HOURS = 24;

export interface ExportArtifactStore {
  put(key: string, bytes: Buffer, format: ImportFormat): Promise<void>;
  get(key: string): Promise<Buffer>;
  remove(key: string): Promise<void>;
}

export function exportStorageKey(tenantId: string, exportId: string, format: ImportFormat): string {
  if (!/^[0-9a-f-]{36}$/i.test(tenantId) || !/^[0-9a-f-]{36}$/i.test(exportId)) throw new Error('Invalid export artifact identity');
  return `${tenantId}/${exportId}.${format}`;
}

export function azureExportArtifactStore(): ExportArtifactStore {
  const accountUrl = process.env.AZURE_STORAGE_ACCOUNT_URL;
  const containerName = process.env.AZURE_EXPORT_CONTAINER;
  if (!accountUrl || !/^https:\/\/[a-z0-9-]+\.blob\.core\.windows\.net\/?$/i.test(accountUrl)) throw new Error('Private Azure Blob account URL is required');
  if (!containerName || !/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/.test(containerName)) throw new Error('Private Azure Blob container name is required');
  const container = new BlobServiceClient(accountUrl,new DefaultAzureCredential()).getContainerClient(containerName);
  const requirePrivateContainer = async () => {
    const policy = await container.getAccessPolicy();
    if (policy.blobPublicAccess) throw new Error('Export container must be private');
  };
  const blob = (key: string) => {
    if (!/^[0-9a-f-]{36}\/[0-9a-f-]{36}\.(csv|xlsx)$/i.test(key)) throw new Error('Invalid export artifact key');
    return container.getBlockBlobClient(key);
  };
  return {
    async put(key,bytes,format) {
      if (bytes.length > MAX_EXPORT_ARTIFACT_BYTES) throw new Error('Export artifact exceeds 25 MiB');
      await requirePrivateContainer();
      await blob(key).uploadData(bytes,{ blobHTTPHeaders: { blobContentType: format === 'csv' ? 'text/csv; charset=utf-8' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', blobCacheControl: 'private, no-store' } });
    },
    async get(key) {
      await requirePrivateContainer();
      const response = await blob(key).download();
      if (response.contentLength === undefined || response.contentLength > MAX_EXPORT_ARTIFACT_BYTES) throw new Error('Export artifact size is invalid');
      const stream = response.readableStreamBody;
      if (!stream) throw new Error('Export artifact is unavailable');
      const chunks: Buffer[] = [];
      let total = 0;
      for await (const chunk of stream) {
        const bytes = Buffer.from(chunk);
        total += bytes.length;
        if (total > MAX_EXPORT_ARTIFACT_BYTES) throw new Error('Export artifact exceeds 25 MiB');
        chunks.push(bytes);
      }
      if (total !== response.contentLength) throw new Error('Export artifact length changed');
      return Buffer.concat(chunks);
    },
    async remove(key) { await blob(key).deleteIfExists(); },
  };
}
