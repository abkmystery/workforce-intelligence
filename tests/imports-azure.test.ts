import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';

const mocked = vi.hoisted(() => ({
  policy: vi.fn(),
  upload: vi.fn(),
  download: vi.fn(),
}));
vi.mock('@azure/identity', () => ({ DefaultAzureCredential: class {} }));
vi.mock('@azure/storage-blob', () => ({
  BlobServiceClient: class {
    getContainerClient() {
      return {
        getAccessPolicy: mocked.policy,
        getBlockBlobClient: () => ({ uploadData: mocked.upload, download: mocked.download, deleteIfExists: vi.fn() }),
      };
    }
  },
}));

import { azureExportArtifactStore, exportStorageKey } from '../src/lib/imports/artifacts';

describe('Azure private export adapter', () => {
  const key = exportStorageKey('11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','csv');
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.AZURE_STORAGE_ACCOUNT_URL='https://synthetic.blob.core.windows.net';
    process.env.AZURE_EXPORT_CONTAINER='synthetic-exports';
  });
  it('refuses both upload and download when Azure reports public container access', async () => {
    mocked.policy.mockResolvedValue({ blobPublicAccess: 'blob' });
    const store=azureExportArtifactStore();
    await expect(store.put(key,Buffer.from('x'),'csv')).rejects.toThrow(/private/i);
    await expect(store.get(key)).rejects.toThrow(/private/i);
    expect(mocked.upload).not.toHaveBeenCalled();
    expect(mocked.download).not.toHaveBeenCalled();
  });
  it('permits private upload and bounded download', async () => {
    mocked.policy.mockResolvedValue({ blobPublicAccess: undefined });
    mocked.download.mockResolvedValue({ contentLength: 2, readableStreamBody: Readable.from([Buffer.from('ok')]) });
    const store=azureExportArtifactStore();
    await store.put(key,Buffer.from('ok'),'csv');
    expect(mocked.upload).toHaveBeenCalledOnce();
    expect((await store.get(key)).toString()).toBe('ok');
    expect(mocked.policy).toHaveBeenCalledTimes(2);
  });
});
