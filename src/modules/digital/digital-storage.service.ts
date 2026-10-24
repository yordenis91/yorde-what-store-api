import { randomUUID } from 'node:crypto';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** How long the storage URL a buyer is redirected to stays valid: just long enough to start the download. */
const SIGNED_URL_TTL_SECONDS = 60;

/**
 * Private object storage for sold files. The bucket is never public and its URLs are never stored
 * or shown: the only way out is `signedDownloadUrl`, reached through a download grant that has
 * already been checked and counted.
 */
@Injectable()
export class DigitalStorageService {
  private client: S3Client | null = null;

  constructor(private readonly config: ConfigService) {}

  isConfigured(): boolean {
    return Boolean(
      this.config.get('digital.s3Endpoint') &&
      this.config.get('digital.s3Bucket') &&
      this.config.get('digital.s3AccessKeyId') &&
      this.config.get('digital.s3SecretAccessKey'),
    );
  }

  private get bucket(): string {
    return this.config.get<string>('digital.s3Bucket')!;
  }

  private s3(): S3Client {
    if (!this.isConfigured()) {
      throw new ServiceUnavailableException('Digital file storage is not configured on this platform');
    }
    this.client ??= new S3Client({
      endpoint: this.config.get<string>('digital.s3Endpoint'),
      region: this.config.get<string>('digital.s3Region') ?? 'us-east-1',
      credentials: {
        accessKeyId: this.config.get<string>('digital.s3AccessKeyId')!,
        secretAccessKey: this.config.get<string>('digital.s3SecretAccessKey')!,
      },
      // MinIO and most self-hosted S3 serve buckets by path, not by subdomain.
      forcePathStyle: true,
    });
    return this.client;
  }

  /** Keys are namespaced by store and random, so a file name can never collide with or reveal another's. */
  newKey(tenantId: string, productId: string): string {
    return `${tenantId}/${productId}/${randomUUID()}`;
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.s3().send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }));
  }

  async remove(key: string): Promise<void> {
    await this.s3().send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  signedDownloadUrl(key: string, fileName: string): Promise<string> {
    const safeName = fileName.replace(/[^\w.\- ]+/g, '_');
    return getSignedUrl(
      this.s3(),
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ResponseContentDisposition: `attachment; filename="${safeName}"`,
      }),
      { expiresIn: SIGNED_URL_TTL_SECONDS },
    );
  }
}
