const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const Papa = require('papaparse');
const XLSX = require('xlsx');
const JSZip = require('jszip');

/**
 * Enterprise Parser Service
 * Zero-Knowledge ephemeral in-memory extraction & native format serialization
 * Supports: PDF, Word (DOCX/DOC), Excel (XLSX/XLS/ODS), CSV/TSV, PowerPoint (PPTX/PPT),
 * Images, Audio, Video, Markdown, Code, and Compressed Archives (ZIP).
 */
class ParserService {
  /**
   * Parse a file buffer according to its mimetype or extension
   * @param {Buffer} buffer
   * @param {string} filename
   * @param {string} mimeType
   */
  async parseBuffer(buffer, filename = '', mimeType = '') {
    const ext = filename.split('.').pop().toLowerCase();
    const cleanMime = (mimeType || '').toLowerCase();

    // 1. PDF Documents
    if (ext === 'pdf' || cleanMime.includes('pdf')) {
      return this.parsePdf(buffer);
    }

    // 2. Microsoft Word (DOCX / DOC)
    if (ext === 'docx' || ext === 'doc' || cleanMime.includes('wordprocessingml') || cleanMime.includes('msword')) {
      return this.parseDocx(buffer, ext);
    }

    // 3. Microsoft PowerPoint Presentations (PPTX / PPT)
    if (ext === 'pptx' || ext === 'ppt' || cleanMime.includes('presentation') || cleanMime.includes('powerpoint')) {
      return this.parsePresentation(buffer, ext);
    }

    // 4. Spreadsheets & Workbooks (XLSX, XLS, ODS)
    if (
      ['xlsx', 'xls', 'ods', 'xlsm'].includes(ext) ||
      cleanMime.includes('spreadsheet') ||
      cleanMime.includes('excel')
    ) {
      return this.parseExcel(buffer, ext);
    }

    // 5. Delimited Tabular (CSV / TSV)
    if (ext === 'csv' || ext === 'tsv' || cleanMime.includes('csv')) {
      return this.parseCsv(buffer.toString('utf-8'));
    }

    // 6. Visual Images (PNG, JPG, JPEG, WEBP, GIF, SVG, BMP, ICO, TIFF, AVIF)
    if (
      ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'bmp', 'ico', 'tiff', 'avif'].includes(ext) ||
      cleanMime.startsWith('image/')
    ) {
      return this.parseImage(buffer, ext, cleanMime);
    }

    // 7. Audio & Video Media (MP4, WEBM, MOV, MKV, AVI, MP3, WAV, OGG, M4A, FLAC, AAC)
    if (
      ['mp4', 'webm', 'mov', 'mkv', 'avi', 'm4v', 'ogv', 'mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac', 'wma'].includes(ext) ||
      cleanMime.startsWith('video/') ||
      cleanMime.startsWith('audio/')
    ) {
      return this.parseMedia(buffer, ext, cleanMime);
    }

    // 8. ZIP Compressed Archives
    if (ext === 'zip' || cleanMime.includes('zip') || cleanMime.includes('compressed')) {
      return this.parseZip(buffer);
    }

    // 9. Markdown Documents
    if (ext === 'md' || ext === 'markdown') {
      try {
        return this.parsePlainText(buffer.toString('utf-8'), 'md');
      } catch (err) {
        // Fallback to binary
      }
    }

    // 10. Code, Configuration, Structured Data, Logs
    const textExtensions = [
      'txt', 'json', 'js', 'jsx', 'ts', 'tsx', 'html', 'css', 'scss',
      'py', 'sql', 'xml', 'yaml', 'yml', 'sh', 'bash', 'zsh', 'log',
      'env', 'ini', 'conf', 'c', 'cpp', 'h', 'java', 'rs', 'go', 'php',
      'rb', 'swift', 'kt', 'dart', 'r', 'toml', 'dockerfile'
    ];

    if (
      textExtensions.includes(ext) ||
      cleanMime.startsWith('text/') ||
      cleanMime.includes('json') ||
      cleanMime.includes('xml') ||
      cleanMime.includes('javascript')
    ) {
      try {
        return this.parsePlainText(buffer.toString('utf-8'), ext);
      } catch (err) {
        // Fallback to binary
      }
    }

    // 11. Generic Binary / Unsupported Archive
    return this.parseBinary(buffer, ext, cleanMime);
  }

  /**
   * Parse PDF buffer using pdf-parse for text indexing + generate base64 dataUrl for pixel-perfect native rendering
   */
  async parsePdf(buffer) {
    try {
      const data = await pdfParse(buffer);
      const text = (data.text || '').trim();
      const isScanned = text.length === 0;
      const base64 = buffer ? buffer.toString('base64') : '';
      const dataUrl = base64 ? `data:application/pdf;base64,${base64}` : null;

      return {
        format: 'pdf',
        type: 'pdf',
        dataUrl: dataUrl,
        text: text,
        pageCount: data.numpages || 1,
        wordCount: this.getWordCount(text),
        isScanned: isScanned,
        fileSize: buffer ? buffer.length : 0,
        warning: isScanned
          ? 'No extractable text layer found. This document may be a scanned image or photo.'
          : null,
      };
    } catch (err) {
      console.error('Error parsing PDF:', err.message);
      const base64 = buffer ? buffer.toString('base64') : '';
      return {
        format: 'pdf',
        type: 'pdf',
        dataUrl: base64 ? `data:application/pdf;base64,${base64}` : null,
        text: '',
        wordCount: 0,
        pageCount: 1,
        fileSize: buffer ? buffer.length : 0,
        isScanned: true,
        warning: `Could not extract text: ${err.message}`,
      };
    }
  }

  /**
   * Parse DOCX buffer using mammoth with rich HTML preservation & base64 dataUrl for native client rendering
   */
  async parseDocx(buffer, ext = 'docx') {
    try {
      const [rawResult, htmlResult] = await Promise.all([
        mammoth.extractRawText({ buffer }).catch(() => ({ value: '', messages: [] })),
        mammoth.convertToHtml({ buffer }).catch(() => ({ value: '', messages: [] })),
      ]);
      const text = (rawResult.value || '').trim();
      const html = (htmlResult.value || '').trim();
      const base64 = buffer ? buffer.toString('base64') : '';
      const dataUrl = base64
        ? `data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,${base64}`
        : null;

      return {
        format: 'docx',
        type: ext,
        dataUrl: dataUrl,
        text: text,
        html: html,
        wordCount: this.getWordCount(text),
        fileSize: buffer ? buffer.length : 0,
        warning:
          rawResult.messages && rawResult.messages.length > 0
            ? rawResult.messages.map((m) => m.message).join('; ')
            : null,
      };
    } catch (err) {
      console.error('Error parsing DOCX:', err.message);
      const base64 = buffer ? buffer.toString('base64') : '';
      return {
        format: 'docx',
        type: ext,
        dataUrl: base64
          ? `data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,${base64}`
          : null,
        text: '',
        html: '',
        wordCount: 0,
        fileSize: buffer ? buffer.length : 0,
        warning: `Could not extract text: ${err.message}`,
      };
    }
  }

  /**
   * Parse Microsoft Excel (XLSX, XLS, ODS) into multi-sheet structured tables
   */
  async parseExcel(buffer, ext = 'xlsx') {
    try {
      const workbook = XLSX.read(buffer, { type: 'buffer' });
      const sheetNames = workbook.SheetNames || [];
      const sheets = [];

      for (const name of sheetNames) {
        const worksheet = workbook.Sheets[name];
        const rawRows = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '' });

        if (rawRows.length > 0) {
          const headers = (rawRows[0] || []).map(
            (h, idx) => (h !== undefined && h !== null && h.toString().trim()) || `Col ${idx + 1}`
          );
          const rows = rawRows.slice(1);
          sheets.push({
            name,
            headers,
            rows,
            totalRows: rows.length,
            totalCols: headers.length,
          });
        } else {
          sheets.push({
            name,
            headers: [],
            rows: [],
            totalRows: 0,
            totalCols: 0,
          });
        }
      }

      const active = sheets[0] || { headers: [], rows: [], totalRows: 0, totalCols: 0 };
      const allText = sheets
        .map((s) => s.headers.join(' ') + ' ' + s.rows.map((r) => r.join(' ')).join(' '))
        .join('\n');

      return {
        format: 'spreadsheet',
        type: ext,
        sheets: sheets,
        headers: active.headers,
        rows: active.rows,
        totalRows: active.totalRows,
        totalCols: active.totalCols,
        text: allText.substring(0, 10000),
        wordCount: this.getWordCount(allText),
        warning: sheets.length === 0 ? 'Workbook has no readable sheets.' : null,
      };
    } catch (err) {
      console.error('Error parsing Excel spreadsheet:', err.message);
      return {
        format: 'spreadsheet',
        type: ext,
        sheets: [],
        headers: [],
        rows: [],
        totalRows: 0,
        totalCols: 0,
        text: '',
        wordCount: 0,
        warning: `Failed to parse spreadsheet: ${err.message}`,
      };
    }
  }

  /**
   * Parse Microsoft PowerPoint (PPTX) presentations into slide cards
   */
  async parsePresentation(buffer, ext = 'pptx') {
    try {
      const zip = await JSZip.loadAsync(buffer);
      const slideFiles = Object.keys(zip.files).filter((f) => /^ppt\/slides\/slide\d+\.xml$/i.test(f));

      // Sort numerically: slide1, slide2, slide3...
      slideFiles.sort((a, b) => {
        const numA = parseInt(a.match(/\d+/)[0], 10);
        const numB = parseInt(b.match(/\d+/)[0], 10);
        return numA - numB;
      });

      const slides = [];
      let fullText = '';

      for (let i = 0; i < slideFiles.length; i++) {
        const slideName = slideFiles[i];
        const xml = await zip.files[slideName].async('text');

        // Extract slide paragraphs
        const paraMatches = xml.match(/<a:p[\s>][\s\S]*?<\/a:p>/gi) || [];
        const paragraphs = [];
        for (const pXml of paraMatches) {
          const textMatches = pXml.match(/<a:t[^>]*>([\s\S]*?)<\/a:t>/gi) || [];
          const text = textMatches.map((t) => t.replace(/<[^>]+>/g, '')).join('').trim();
          if (text) {
            paragraphs.push(text);
          }
        }

        const title = paragraphs[0] || `Slide ${i + 1}`;
        const bullets = paragraphs.slice(1);
        const slideText = paragraphs.join('\n');
        fullText += `--- Slide ${i + 1}: ${title} ---\n${slideText}\n\n`;

        slides.push({
          slideNumber: i + 1,
          title: title,
          bullets: bullets,
          paragraphs: paragraphs,
          text: slideText,
        });
      }

      return {
        format: 'presentation',
        type: ext,
        slideCount: slides.length,
        slides: slides,
        text: fullText.trim(),
        wordCount: this.getWordCount(fullText),
        warning: slides.length === 0 ? 'No readable slides found in presentation.' : null,
      };
    } catch (err) {
      console.error('Error parsing Presentation:', err.message);
      return {
        format: 'presentation',
        type: ext,
        slideCount: 0,
        slides: [],
        text: '',
        wordCount: 0,
        warning: `Could not parse presentation slides: ${err.message}`,
      };
    }
  }

  /**
   * Parse ZIP compressed archives and extract file tree listing
   */
  async parseZip(buffer) {
    try {
      const zip = await JSZip.loadAsync(buffer);
      const entries = [];
      let totalSize = 0;

      zip.forEach((relativePath, file) => {
        const size = file._data ? file._data.uncompressedSize || 0 : 0;
        totalSize += size;
        entries.push({
          path: relativePath,
          name: relativePath.split('/').filter(Boolean).pop() || relativePath,
          dir: file.dir,
          size: size,
          date: file.date || null,
        });
      });

      return {
        format: 'archive',
        type: 'zip',
        entries: entries,
        fileCount: entries.length,
        totalUncompressedSize: totalSize,
        text: entries.map((e) => e.path).join('\n'),
        wordCount: entries.length,
        warning: null,
      };
    } catch (err) {
      console.error('Error parsing ZIP archive:', err.message);
      return {
        format: 'archive',
        type: 'zip',
        entries: [],
        fileCount: 0,
        totalUncompressedSize: 0,
        warning: `Could not inspect ZIP archive: ${err.message}`,
      };
    }
  }

  /**
   * Parse image buffer into base64 data URL for instant high-res rendering
   */
  parseImage(buffer, ext, mimeType) {
    const finalMime = mimeType || `image/${ext === 'svg' ? 'svg+xml' : ext}`;
    const base64 = buffer.toString('base64');
    const dataUrl = `data:${finalMime};base64,${base64}`;

    return {
      format: 'image',
      type: ext || 'image',
      mimeType: finalMime,
      dataUrl: dataUrl,
      fileSize: buffer.length,
      text: `[Image File: ${ext.toUpperCase()}]`,
      wordCount: 0,
      warning: null,
    };
  }

  /**
   * Parse media (audio/video) with format discrimination
   */
  parseMedia(buffer, ext, mimeType) {
    const isVideo =
      ['mp4', 'webm', 'mov', 'mkv', 'avi', 'm4v', 'ogv'].includes(ext) ||
      (mimeType && mimeType.startsWith('video/'));
    const defaultMime = isVideo ? 'video/mp4' : 'audio/mp3';
    const finalMime = mimeType || defaultMime;

    // Do NOT generate a 25MB base64 dataUrl for large audio/video streams!
    // TeleDoc Hub streams video/audio via HTTP 206 Partial Content (/view route).
    return {
      format: isVideo ? 'video' : 'audio',
      type: ext || (isVideo ? 'video' : 'audio'),
      mimeType: finalMime,
      dataUrl: null,
      fileSize: buffer.length,
      text: `[${isVideo ? 'Video' : 'Audio'} Recording: ${ext.toUpperCase()}]`,
      wordCount: 0,
      warning: null,
    };
  }

  /**
   * Parse plain text, code, or markdown string
   */
  parsePlainText(rawText, ext = 'txt') {
    const text = (rawText || '').trim();
    const isMarkdown = ['md', 'markdown'].includes(ext);
    const codeExtensions = [
      'js', 'jsx', 'ts', 'tsx', 'html', 'css', 'scss', 'py', 'sql',
      'xml', 'yaml', 'yml', 'json', 'sh', 'bash', 'zsh', 'c', 'cpp',
      'h', 'java', 'rs', 'go', 'php', 'rb', 'env', 'ini', 'conf', 'log'
    ];
    const isCode = codeExtensions.includes(ext);

    return {
      format: isMarkdown ? 'markdown' : isCode ? 'code' : 'document',
      type: ext,
      text: text,
      lineCount: text ? text.split('\n').length : 0,
      wordCount: this.getWordCount(text),
      warning: null,
    };
  }

  /**
   * Parse CSV string into structured grid
   */
  parseCsv(csvString) {
    try {
      const parsed = Papa.parse(csvString, {
        header: false,
        skipEmptyLines: 'greedy',
        dynamicTyping: false,
      });

      if (!parsed.data || parsed.data.length === 0) {
        return {
          format: 'spreadsheet',
          type: 'csv',
          headers: [],
          rows: [],
          totalRows: 0,
          totalCols: 0,
          warning: 'CSV appears to be empty.',
        };
      }

      const rawRows = parsed.data;
      const headers = rawRows[0] || [];
      const rows = rawRows.slice(1);

      return {
        format: 'spreadsheet',
        type: 'csv',
        headers: headers.map((h, i) => (h && h.toString().trim()) || `Column ${i + 1}`),
        rows: rows,
        totalRows: rows.length,
        totalCols: headers.length,
        warning: null,
      };
    } catch (err) {
      console.error('Error parsing CSV:', err.message);
      return {
        format: 'spreadsheet',
        type: 'csv',
        headers: [],
        rows: [],
        totalRows: 0,
        totalCols: 0,
        warning: `Failed to parse spreadsheet: ${err.message}`,
      };
    }
  }

  /**
   * Handle generic binary / archive files
   */
  parseBinary(buffer, ext, mimeType) {
    return {
      format: 'binary',
      type: ext || 'binary',
      fileSize: buffer.length,
      text: `[Binary Archive / Document: .${ext.toUpperCase()}]`,
      wordCount: 0,
      warning: 'Binary file format. Download the file to open it in its native application.',
    };
  }

  /**
   * Calculate word count
   */
  getWordCount(text) {
    if (!text) return 0;
    const words = text.trim().match(/\S+/g);
    return words ? words.length : 0;
  }
}

module.exports = new ParserService();
