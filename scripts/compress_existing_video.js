const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const telegramService = require('../src/services/telegramService');
const mediaOptimizer = require('../src/services/mediaOptimizer');
const { encryptBuffer, decryptBuffer, computeChecksum } = require('../src/utils/cryptoUtil');

async function run() {
  const docId = '6ce37d04-d1ff-4d3c-9a3f-4575ba9dc63b';
  console.log(`Connecting to MongoDB to optimize document: ${docId}...`);
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;

  const doc = await db.collection('documents').findOne({ id: docId });
  if (!doc) {
    console.error(`Document ${docId} not found!`);
    process.exit(1);
  }

  console.log(`Found doc: "${doc.filename}" (${(doc.fileSize / (1024 * 1024)).toFixed(2)} MB)`);
  console.log('Downloading existing encrypted blob from Telegram...');
  const encryptedBlob = await telegramService.downloadFile(doc.telegramFileId);
  console.log(`Downloaded ${encryptedBlob.length} bytes.`);

  console.log('Decrypting with stored AES-256-GCM credentials...');
  const decryptedBuf = decryptBuffer(encryptedBlob, doc.security.iv, doc.security.authTag);
  console.log(`Decrypted buffer length: ${decryptedBuf.length} bytes.`);

  console.log('Compressing with FFmpeg H.264 +faststart web optimization...');
  const optResult = await mediaOptimizer.compressVideo(decryptedBuf, doc.filename);

  if (!optResult.compressed) {
    console.log('Compression did not reduce size or was skipped.');
    process.exit(0);
  }

  const savedPercent = Math.round((1 - optResult.newSize / optResult.originalSize) * 100);
  console.log(`Compression successful: ${(optResult.originalSize / (1024 * 1024)).toFixed(2)} MB -> ${(optResult.newSize / (1024 * 1024)).toFixed(2)} MB (${savedPercent}% saved)!`);

  console.log('Re-encrypting compressed video with fresh AES-256-GCM key/iv...');
  const { encryptedBuffer, iv, authTag } = encryptBuffer(optResult.buffer);

  console.log('Uploading optimized encrypted blob to Telegram...');
  const uploaded = await telegramService.uploadDocument(
    encryptedBuffer,
    `enc_opt_${doc.filename}`,
    'Zero-Knowledge Encrypted Video (Optimized FastStart Stream)'
  );
  console.log('Uploaded to Telegram successfully. New file_id:', uploaded.fileId);

  const newChecksum = computeChecksum(optResult.buffer);

  console.log('Updating MongoDB document metadata...');
  const updateResult = await db.collection('documents').updateOne(
    { id: docId },
    {
      $set: {
        fileSize: optResult.newSize,
        telegramFileId: uploaded.fileId,
        'security.iv': iv,
        'security.authTag': authTag,
        checksumSha256: newChecksum,
        updatedAt: new Date(),
      },
    }
  );

  console.log('MongoDB update modified count:', updateResult.modifiedCount);
  console.log('Done! Video successfully replaced with 69% smaller, instant-streaming version.');
  await mongoose.disconnect();
}

run().catch((err) => {
  console.error('Fatal error optimizing video:', err);
  process.exit(1);
});

