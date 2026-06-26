import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import crypto from 'crypto';

const s3Client = new S3Client({
  endpoint: process.env.S3_ENDPOINT,
  region: process.env.S3_REGION,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY,
    secretAccessKey: process.env.S3_SECRET_KEY,
  },
  forcePathStyle: true,
});

/**
 * Uploads a base64 encoded file to Sprinthost S3 storage.
 * @param {string} fileBase64 - Base64 Data URI or raw base64 string
 * @param {string} originalName - Original filename
 * @param {string} folder - Destination folder prefix
 * @returns {Promise<{url: string, key: string}>}
 */
export async function uploadToS3(fileBase64, originalName = 'file', folder = 'chat') {
  const matches = fileBase64.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
  let mimeType = 'application/octet-stream';
  let buffer;

  if (matches) {
    mimeType = matches[1];
    buffer = Buffer.from(matches[2], 'base64');
  } else {
    buffer = Buffer.from(fileBase64, 'base64');
  }

  // Sanitize filename to prevent S3 key naming issues
  const cleanName = originalName.replace(/[^a-zA-Z0-9.-]/g, '_');
  const uniqueId = crypto.randomUUID();
  const key = `${folder}/${uniqueId}-${cleanName}`;

  const command = new PutObjectCommand({
    Bucket: process.env.S3_BUCKET,
    Key: key,
    Body: buffer,
    ContentType: mimeType,
  });

  await s3Client.send(command);

  const url = `${process.env.S3_ENDPOINT}/${process.env.S3_BUCKET}/${key}`;
  return { url, key };
}
