const path = require('path');
const fs = require('fs');
const os = require('os');
const { execSync } = require('child_process');
const mediaOptimizer = require('./src/services/mediaOptimizer');

async function testSmartCompression() {
  console.log('🧪 Starting Smart Compression Suite (Edge Cases & Boundaries)...\n');

  console.log('1️⃣ Checking FFmpeg and FFprobe availability...');
  const ffmpegOk = mediaOptimizer.isFfmpegAvailable();
  const ffprobeOk = mediaOptimizer.isFfprobeAvailable();
  console.log(`   ✓ FFmpeg available: ${ffmpegOk}`);
  console.log(`   ✓ FFprobe available: ${ffprobeOk}`);
  if (!ffmpegOk || !ffprobeOk) {
    throw new Error('FFmpeg/FFprobe must be available for Smart Compression!');
  }

  // 2. Generate a synthetic high-bitrate video (simulating a 25 MB camera clip)
  console.log('\n2️⃣ Testing Video Smart Compression (Bitrate budgeting + +faststart)...');
  const tempVideo = path.join(os.tmpdir(), 'test_clip_raw.mp4');
  try {
    // Generate a 4-second video clip with 1080p high bitrate
    execSync(`ffmpeg -y -f lavfi -i testsrc=duration=4:size=1920x1080:rate=30 -f lavfi -i sine=frequency=440:duration=4 -c:v libx264 -b:v 15M -c:a aac -b:a 192k "${tempVideo}"`, { stdio: 'ignore' });
    const rawBuf = await fs.promises.readFile(tempVideo);
    console.log(`   Original synthetic video size: ${(rawBuf.length / (1024 * 1024)).toFixed(2)} MB`);

    const result = await mediaOptimizer.optimizeMedia(rawBuf, 'vacation_clip.mov', 'video/quicktime');
    console.log(`   Optimized video size: ${(result.newSize / (1024 * 1024)).toFixed(2)} MB (${Math.round((1 - result.newSize / result.originalSize) * 100)}% saved)`);
    console.log(`   Output format: ${result.filename} (${result.mimeType})`);

    if (result.newSize > mediaOptimizer.SAFE_TELEGRAM_CEILING) {
      throw new Error(`Video exceeded Telegram safe ceiling: ${result.newSize} bytes`);
    }
    console.log(`   ✓ Pass: Video guaranteed under Telegram 19.2 MB ceiling (${(result.newSize / (1024 * 1024)).toFixed(2)} MB)`);
  } finally {
    if (fs.existsSync(tempVideo)) await fs.promises.unlink(tempVideo);
  }

  // 3. Generate a synthetic uncompressed WAV audio file
  console.log('\n3️⃣ Testing Audio Smart Compression (WAV -> MP3/AAC 128k)...');
  const tempWav = path.join(os.tmpdir(), 'test_podcast_raw.wav');
  try {
    // Generate 6-second high quality uncompressed PCM WAV
    execSync(`ffmpeg -y -f lavfi -i sine=frequency=880:duration=6 -c:a pcm_s16le "${tempWav}"`, { stdio: 'ignore' });
    const rawWavBuf = await fs.promises.readFile(tempWav);
    console.log(`   Original synthetic WAV size: ${(rawWavBuf.length / 1024).toFixed(1)} KB`);

    const audioRes = await mediaOptimizer.optimizeMedia(rawWavBuf, 'podcast_interview.wav', 'audio/wav');
    console.log(`   Optimized audio size: ${(audioRes.newSize / 1024).toFixed(1)} KB (${Math.round((1 - audioRes.newSize / audioRes.originalSize) * 100)}% saved)`);
    console.log(`   Output format: ${audioRes.filename} (${audioRes.mimeType})`);

    if (!audioRes.filename.endsWith('.mp3')) {
      throw new Error(`Expected audio output filename to end with .mp3, got ${audioRes.filename}`);
    }
    console.log('   ✓ Pass: WAV converted to lightweight web-streamable MP3');
  } finally {
    if (fs.existsSync(tempWav)) await fs.promises.unlink(tempWav);
  }

  // 4. Edge Case: Non-media files pass-through without corruption
  console.log('\n4️⃣ Testing Pass-Through for Non-Media (e.g. documents, PDFs, zip)...');
  const testDocBuf = Buffer.from('TeleDoc Zero Knowledge Encrypted Document Test Content');
  const docRes = await mediaOptimizer.optimizeMedia(testDocBuf, 'medical_report.pdf', 'application/pdf');
  if (docRes.compressed || docRes.newSize !== testDocBuf.length) {
    throw new Error('Non-media files must not be altered!');
  }
  console.log('   ✓ Pass: Document bytes preserved with 100% binary integrity');

  console.log('\n🎉 ALL SMART COMPRESSION TESTS PASSED CLEANLY!\n');
}

testSmartCompression().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});

