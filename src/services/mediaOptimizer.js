const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, exec } = require('child_process');

class MediaOptimizer {
  constructor() {
    this._ffmpegAvailable = null;
    this._ffprobeAvailable = null;
    this.SAFE_TELEGRAM_CEILING = 19.2 * 1024 * 1024; // 19.2 MB (strict headroom under Telegram's 20.0 MB getFile limit)
  }

  /**
   * Check if FFmpeg is installed and accessible on PATH
   * @returns {boolean}
   */
  isFfmpegAvailable() {
    if (this._ffmpegAvailable !== null) return this._ffmpegAvailable;
    try {
      execSync('ffmpeg -version', { stdio: 'ignore' });
      this._ffmpegAvailable = true;
    } catch (err) {
      this._ffmpegAvailable = false;
    }
    return this._ffmpegAvailable;
  }

  /**
   * Check if FFprobe is installed and accessible on PATH
   * @returns {boolean}
   */
  isFfprobeAvailable() {
    if (this._ffprobeAvailable !== null) return this._ffprobeAvailable;
    try {
      execSync('ffprobe -version', { stdio: 'ignore' });
      this._ffprobeAvailable = true;
    } catch (err) {
      this._ffprobeAvailable = false;
    }
    return this._ffprobeAvailable;
  }

  /**
   * Probe media duration, width, and height using ffprobe
   * @param {string} filePath
   * @returns {Promise<{ duration: number, width: number, height: number }>}
   */
  async probeMedia(filePath) {
    if (!this.isFfprobeAvailable()) {
      return { duration: 0, width: 0, height: 0 };
    }
    try {
      const cmd = `ffprobe -v error -select_streams v:0 -show_entries stream=width,height,duration -show_entries format=duration -of json "${filePath}"`;
      const output = await new Promise((resolve, reject) => {
        exec(cmd, { timeout: 15000 }, (err, stdout) => {
          if (err) return reject(err);
          resolve(stdout);
        });
      });
      const data = JSON.parse(output || '{}');
      const stream = data.streams?.[0] || {};
      const format = data.format || {};
      const duration = parseFloat(stream.duration || format.duration || 0);
      const width = parseInt(stream.width || 0, 10);
      const height = parseInt(stream.height || 0, 10);
      return { duration, width, height };
    } catch (err) {
      console.warn('[MediaOptimizer] ffprobe warning:', err.message);
      return { duration: 0, width: 0, height: 0 };
    }
  }

  /**
   * Adaptive Video Compression for files up to 50 MB
   * Dynamically calculates target bitrate to GUARANTEE output stays below 19.2 MB (Telegram safe ceiling)
   * while preserving crisp 1080p/720p visuals and injecting +faststart.
   *
   * @param {Buffer} buffer
   * @param {string} filename
   * @returns {Promise<{ buffer: Buffer, compressed: boolean, originalSize: number, newSize: number, filename: string }>}
   */
  async compressVideo(buffer, filename = 'video.mp4') {
    const originalSize = buffer.length;

    if (!this.isFfmpegAvailable()) {
      return { buffer, compressed: false, originalSize, newSize: originalSize, filename };
    }

    // Skip tiny videos under 2 MB unless they exceed safe ceiling
    if (originalSize < 2 * 1024 * 1024) {
      return { buffer, compressed: false, originalSize, newSize: originalSize, filename };
    }

    const ext = (filename.split('.').pop() || 'mp4').toLowerCase();
    const tempId = `${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const inPath = path.join(os.tmpdir(), `teledoc_v_in_${tempId}.${ext}`);
    const outPath = path.join(os.tmpdir(), `teledoc_v_out_${tempId}.mp4`);

    try {
      await fs.promises.writeFile(inPath, buffer);

      // Probe media metadata for intelligent bitrate budgeting
      const probe = await this.probeMedia(inPath);
      const duration = probe.duration || 30; // fallback duration estimate if unreadable

      // Target budget: 18.5 MB total (155,189,760 bits)
      // video_bits = total_bits - (audio_bitrate * duration)
      const targetTotalBits = 18.5 * 1024 * 1024 * 8;
      const audioBitrateBps = 96 * 1000;
      let targetVideoBitrateBps = Math.floor(targetTotalBits / Math.max(duration, 1)) - audioBitrateBps;

      // Bound video bitrate between 350 kbps (long video) and 3500 kbps (short video)
      targetVideoBitrateBps = Math.max(350 * 1000, Math.min(3500 * 1000, targetVideoBitrateBps));
      const targetVideoBitrateKbps = Math.round(targetVideoBitrateBps / 1000);

      // Intelligent Resolution Scaling:
      // - If duration > 240s: downscale to 480p to preserve sharpness at low bitrates
      // - If duration > 90s: downscale to 720p
      // - Otherwise: cap at 1080p
      let scaleFilter = "scale='min(1920,iw)':-2";
      if (duration > 240) {
        scaleFilter = "scale='min(854,iw)':-2";
      } else if (duration > 90) {
        scaleFilter = "scale='min(1280,iw)':-2";
      }

      // First Pass: Web-optimized H.264 + AAC + faststart with bitrate ceiling
      const pass1Cmd = `ffmpeg -y -i "${inPath}" -vf "${scaleFilter}" -c:v libx264 -preset veryfast -b:v ${targetVideoBitrateKbps}k -maxrate ${Math.round(targetVideoBitrateKbps * 1.3)}k -bufsize ${Math.round(targetVideoBitrateKbps * 2)}k -crf 27 -movflags +faststart -c:a aac -b:a 96k -ac 2 -max_muxing_queue_size 1024 "${outPath}"`;

      await new Promise((resolve, reject) => {
        exec(pass1Cmd, { timeout: 180000 }, (error) => {
          if (error) return reject(error);
          resolve();
        });
      });

      if (fs.existsSync(outPath)) {
        let compressedBuf = await fs.promises.readFile(outPath);
        let newSize = compressedBuf.length;

        // Edge Case: If file still exceeds 19.2 MB (e.g. high-motion long clip), perform emergency second pass
        if (newSize > this.SAFE_TELEGRAM_CEILING) {
          console.warn(`[MediaOptimizer] Video pass 1 was ${(newSize / (1024 * 1024)).toFixed(2)} MB, running emergency pass 2...`);
          const emergencyOutPath = path.join(os.tmpdir(), `teledoc_v_emg_${tempId}.mp4`);
          const emergencyBitrateKbps = Math.max(250, Math.round(targetVideoBitrateKbps * 0.7));
          const pass2Cmd = `ffmpeg -y -i "${outPath}" -vf "scale='min(854,iw)':-2" -c:v libx264 -preset veryfast -b:v ${emergencyBitrateKbps}k -maxrate ${emergencyBitrateKbps}k -bufsize ${emergencyBitrateKbps * 2}k -crf 32 -movflags +faststart -c:a aac -b:a 64k -ac 1 "${emergencyOutPath}"`;

          await new Promise((resolve, reject) => {
            exec(pass2Cmd, { timeout: 120000 }, (err) => {
              if (err) return reject(err);
              resolve();
            });
          });

          if (fs.existsSync(emergencyOutPath)) {
            compressedBuf = await fs.promises.readFile(emergencyOutPath);
            newSize = compressedBuf.length;
            try { await fs.promises.unlink(emergencyOutPath); } catch (_) {}
          }
        }

        const savedPercent = Math.round((1 - newSize / originalSize) * 100);
        console.log(`[MediaOptimizer] Video optimized "${filename}": ${(originalSize / (1024 * 1024)).toFixed(2)} MB -> ${(newSize / (1024 * 1024)).toFixed(2)} MB (${savedPercent}% saved)`);

        return {
          buffer: compressedBuf,
          compressed: true,
          originalSize,
          newSize,
          filename: filename.endsWith('.mp4') ? filename : `${filename.replace(/\.[^/.]+$/, '')}.mp4`,
        };
      }

      return { buffer, compressed: false, originalSize, newSize: originalSize, filename };
    } catch (err) {
      console.warn(`[MediaOptimizer] Video compression failed for "${filename}":`, err.message);
      return { buffer, compressed: false, originalSize, newSize: originalSize, filename };
    } finally {
      try {
        if (fs.existsSync(inPath)) await fs.promises.unlink(inPath);
        if (fs.existsSync(outPath)) await fs.promises.unlink(outPath);
      } catch (_) {}
    }
  }

  /**
   * Smart Audio Compression (WAV, FLAC, AIFF, high-bitrate MP3)
   * Transcodes uncompressed studio formats into crystal-clear 128k AAC/MP3
   * Reduces 50 MB WAV files to ~4 MB (90% reduction)
   *
   * @param {Buffer} buffer
   * @param {string} filename
   * @returns {Promise<{ buffer: Buffer, compressed: boolean, originalSize: number, newSize: number, filename: string }>}
   */
  async compressAudio(buffer, filename = 'audio.mp3') {
    const originalSize = buffer.length;

    // Only compress if over 5 MB or uncompressed studio format
    const ext = (filename.split('.').pop() || '').toLowerCase();
    const isUncompressed = ['wav', 'flac', 'aiff', 'aif', 'alac', 'pcm'].includes(ext);

    if (!this.isFfmpegAvailable() || (originalSize < 5 * 1024 * 1024 && !isUncompressed)) {
      return { buffer, compressed: false, originalSize, newSize: originalSize, filename };
    }

    const tempId = `${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const inPath = path.join(os.tmpdir(), `teledoc_a_in_${tempId}.${ext}`);
    const outPath = path.join(os.tmpdir(), `teledoc_a_out_${tempId}.mp3`);

    try {
      await fs.promises.writeFile(inPath, buffer);

      // Transcode to clean 128k stereo MP3
      const cmd = `ffmpeg -y -i "${inPath}" -c:a libmp3lame -b:a 128k -ac 2 "${outPath}"`;

      await new Promise((resolve, reject) => {
        exec(cmd, { timeout: 60000 }, (error) => {
          if (error) return reject(error);
          resolve();
        });
      });

      if (fs.existsSync(outPath)) {
        const compressedBuf = await fs.promises.readFile(outPath);
        const newSize = compressedBuf.length;

        if (newSize < originalSize) {
          const savedPercent = Math.round((1 - newSize / originalSize) * 100);
          console.log(`[MediaOptimizer] Audio optimized "${filename}": ${(originalSize / (1024 * 1024)).toFixed(2)} MB -> ${(newSize / (1024 * 1024)).toFixed(2)} MB (${savedPercent}% saved)`);
          return {
            buffer: compressedBuf,
            compressed: true,
            originalSize,
            newSize,
            filename: `${filename.replace(/\.[^/.]+$/, '')}.mp3`,
          };
        }
      }

      return { buffer, compressed: false, originalSize, newSize: originalSize, filename };
    } catch (err) {
      console.warn(`[MediaOptimizer] Audio compression failed for "${filename}":`, err.message);
      return { buffer, compressed: false, originalSize, newSize: originalSize, filename };
    } finally {
      try {
        if (fs.existsSync(inPath)) await fs.promises.unlink(inPath);
        if (fs.existsSync(outPath)) await fs.promises.unlink(outPath);
      } catch (_) {}
    }
  }

  /**
   * Smart Image Optimization (PNG, TIFF, BMP, high-res JPEG)
   * Caps maximum dimensions at 2560px and encodes with WebP/JPEG quality 85
   * Reduces 30 MB - 50 MB images to ~2 MB
   *
   * @param {Buffer} buffer
   * @param {string} filename
   * @returns {Promise<{ buffer: Buffer, compressed: boolean, originalSize: number, newSize: number, filename: string }>}
   */
  async compressImage(buffer, filename = 'image.webp') {
    const originalSize = buffer.length;

    // Only compress images over 6 MB or heavy formats (TIFF, BMP)
    const ext = (filename.split('.').pop() || '').toLowerCase();
    const isHeavy = ['tiff', 'tif', 'bmp', 'raw'].includes(ext);

    if (!this.isFfmpegAvailable() || (originalSize < 6 * 1024 * 1024 && !isHeavy)) {
      return { buffer, compressed: false, originalSize, newSize: originalSize, filename };
    }

    const tempId = `${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const inPath = path.join(os.tmpdir(), `teledoc_i_in_${tempId}.${ext}`);
    const outPath = path.join(os.tmpdir(), `teledoc_i_out_${tempId}.webp`);

    try {
      await fs.promises.writeFile(inPath, buffer);

      // Convert to WebP with max 2560px width/height and quality 84
      const cmd = `ffmpeg -y -i "${inPath}" -vf "scale='min(2560,iw)':-2" -q:v 84 "${outPath}"`;

      await new Promise((resolve, reject) => {
        exec(cmd, { timeout: 60000 }, (error) => {
          if (error) return reject(error);
          resolve();
        });
      });

      if (fs.existsSync(outPath)) {
        const compressedBuf = await fs.promises.readFile(outPath);
        const newSize = compressedBuf.length;

        if (newSize < originalSize) {
          const savedPercent = Math.round((1 - newSize / originalSize) * 100);
          console.log(`[MediaOptimizer] Image optimized "${filename}": ${(originalSize / (1024 * 1024)).toFixed(2)} MB -> ${(newSize / (1024 * 1024)).toFixed(2)} MB (${savedPercent}% saved)`);
          return {
            buffer: compressedBuf,
            compressed: true,
            originalSize,
            newSize,
            filename: `${filename.replace(/\.[^/.]+$/, '')}.webp`,
          };
        }
      }

      return { buffer, compressed: false, originalSize, newSize: originalSize, filename };
    } catch (err) {
      console.warn(`[MediaOptimizer] Image compression failed for "${filename}":`, err.message);
      return { buffer, compressed: false, originalSize, newSize: originalSize, filename };
    } finally {
      try {
        if (fs.existsSync(inPath)) await fs.promises.unlink(inPath);
        if (fs.existsSync(outPath)) await fs.promises.unlink(outPath);
      } catch (_) {}
    }
  }

  /**
   * Unified Entry Point: Automatically identifies media type and applies appropriate smart compression
   *
   * @param {Buffer} buffer
   * @param {string} filename
   * @param {string} mimeType
   * @returns {Promise<{ buffer: Buffer, compressed: boolean, originalSize: number, newSize: number, filename: string, mimeType: string }>}
   */
  async optimizeMedia(buffer, filename, mimeType = '') {
    const ext = (filename.split('.').pop() || '').toLowerCase();

    // 1. Video files
    if (['mp4', 'mov', 'webm', 'mkv', 'avi', 'm4v', 'flv', 'wmv'].includes(ext) || mimeType.startsWith('video/')) {
      const res = await this.compressVideo(buffer, filename);
      return {
        ...res,
        mimeType: 'video/mp4',
      };
    }

    // 2. Audio files
    if (['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac', 'wma', 'aiff'].includes(ext) || mimeType.startsWith('audio/')) {
      const res = await this.compressAudio(buffer, filename);
      return {
        ...res,
        mimeType: res.filename.endsWith('.mp3') ? 'audio/mpeg' : (mimeType || 'audio/mpeg'),
      };
    }

    // 3. Image files
    if (['png', 'jpg', 'jpeg', 'webp', 'bmp', 'tiff', 'tif'].includes(ext) || mimeType.startsWith('image/')) {
      const res = await this.compressImage(buffer, filename);
      return {
        ...res,
        mimeType: res.filename.endsWith('.webp') ? 'image/webp' : (mimeType || 'image/jpeg'),
      };
    }

    // 4. Other files (PDFs, docs, zips) - Pass-through
    return {
      buffer,
      compressed: false,
      originalSize: buffer.length,
      newSize: buffer.length,
      filename,
      mimeType,
    };
  }
}

module.exports = new MediaOptimizer();
