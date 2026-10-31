const axios = require('axios');
const parserService = require('./parserService');

class GoogleLinkService {
  /**
   * Validate and parse Google Workspace links
   * @param {string} urlString
   * @param {string} customTitle
   */
  async fetchGoogleResource(urlString, customTitle = '') {
    // 1. SSRF & Hostname Validation
    let parsedUrl;
    try {
      parsedUrl = new URL(urlString.trim());
    } catch {
      throw new Error('Invalid URL format. Please provide a valid web link.');
    }

    if (parsedUrl.hostname !== 'docs.google.com') {
      throw new Error('Security Restriction: Only links from docs.google.com are permitted.');
    }

    const fullUrl = parsedUrl.toString();

    // 2. Identify Google Docs vs Google Sheets
    const docMatch = fullUrl.match(/\/document\/d\/([a-zA-Z0-9-_]+)/);
    const sheetMatch = fullUrl.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);

    if (docMatch) {
      const docId = docMatch[1];
      const exportUrl = `https://docs.google.com/document/d/${docId}/export?format=txt`;
      return this.fetchDocExport(exportUrl, docId, customTitle);
    }

    if (sheetMatch) {
      const sheetId = sheetMatch[1];
      // Check for specific sheet gid in hash or query
      let gid = null;
      if (parsedUrl.searchParams.has('gid')) {
        gid = parsedUrl.searchParams.get('gid');
      } else if (parsedUrl.hash && parsedUrl.hash.includes('gid=')) {
        const hashMatch = parsedUrl.hash.match(/gid=([0-9]+)/);
        if (hashMatch) gid = hashMatch[1];
      }

      const exportUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv${gid ? `&gid=${gid}` : ''}`;
      return this.fetchSheetExport(exportUrl, sheetId, customTitle);
    }

    throw new Error('Unrecognized Google Workspace URL. Please provide a public Google Docs or Google Sheets link.');
  }

  /**
   * Fetch and process Google Doc export
   */
  async fetchDocExport(exportUrl, docId, customTitle) {
    try {
      const response = await axios.get(exportUrl, {
        responseType: 'arraybuffer',
        maxRedirects: 5,
        timeout: 10000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) TeleDoc-Hub/1.0'
        }
      });

      const contentType = response.headers['content-type'] || '';

      // If Google returned an HTML page, it's a login redirect (Private Doc)
      if (contentType.includes('text/html')) {
        throw new Error(
          "Access denied: This Google Doc is private. Please ensure sharing is set to 'Anyone with the link can view'."
        );
      }

      const buffer = Buffer.from(response.data);
      const text = buffer.toString('utf-8');
      const title = customTitle.trim() || `Google Doc (${docId.substring(0, 8)})`;
      const filename = `${title.replace(/[^a-zA-Z0-9-_ ]/g, '') || 'document'}.txt`;

      const parsed = parserService.parsePlainText(text);

      return {
        type: 'google_doc',
        title,
        filename,
        buffer,
        parsedContent: parsed,
        originalUrl: `https://docs.google.com/document/d/${docId}`
      };
    } catch (err) {
      if (err.response && (err.response.status === 401 || err.response.status === 403)) {
        throw new Error(
          "Access denied: This Google Doc is private. Please ensure sharing is set to 'Anyone with the link can view'."
        );
      }
      throw err;
    }
  }

  /**
   * Fetch and process Google Sheet export
   */
  async fetchSheetExport(exportUrl, sheetId, customTitle) {
    try {
      const response = await axios.get(exportUrl, {
        responseType: 'arraybuffer',
        maxRedirects: 5,
        timeout: 10000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) TeleDoc-Hub/1.0'
        }
      });

      const contentType = response.headers['content-type'] || '';

      if (contentType.includes('text/html')) {
        throw new Error(
          "Access denied: This Google Sheet is private. Please ensure sharing is set to 'Anyone with the link can view'."
        );
      }

      const buffer = Buffer.from(response.data);
      const csvString = buffer.toString('utf-8');
      const title = customTitle.trim() || `Google Sheet (${sheetId.substring(0, 8)})`;
      const filename = `${title.replace(/[^a-zA-Z0-9-_ ]/g, '') || 'sheet'}.csv`;

      const parsed = parserService.parseCsv(csvString);

      return {
        type: 'google_sheet',
        title,
        filename,
        buffer,
        parsedContent: parsed,
        originalUrl: `https://docs.google.com/spreadsheets/d/${sheetId}`
      };
    } catch (err) {
      if (err.response && (err.response.status === 401 || err.response.status === 403)) {
        throw new Error(
          "Access denied: This Google Sheet is private. Please ensure sharing is set to 'Anyone with the link can view'."
        );
      }
      throw err;
    }
  }
}

module.exports = new GoogleLinkService();

