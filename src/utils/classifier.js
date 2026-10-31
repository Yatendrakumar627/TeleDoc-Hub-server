/**
 * Heuristic classifier to auto-categorize incoming documents into
 * multi-dimensional facets (scope, security, group, subGroup, tags, temporal).
 */
function classifyDocument(filename, text = '', userOverrides = {}) {
  const lowerName = (filename || '').toLowerCase();
  const lowerText = (text || '').substring(0, 10000).toLowerCase();
  const combined = `${lowerName} ${lowerText}`;

  // Defaults
  let scope = userOverrides.scope || 'professional';
  let securityLevel = userOverrides.securityLevel || 'internal';
  let group = userOverrides.group || 'general';
  let subGroup = userOverrides.subGroup || 'general';
  let documentDate = userOverrides.documentDate ? new Date(userOverrides.documentDate) : new Date();
  const tags = new Set(userOverrides.tags || []);

  // 1. Identity & Personal Documents
  if (
    /(passport|driver['’]?s? license|id card|ssn|social security|aadhaar|pan card|birth certificate|voter)/i.test(
      combined
    )
  ) {
    scope = 'personal';
    securityLevel = 'strictly_confidential';
    group = 'identity';
    subGroup = 'credentials';
    tags.add('identity');
    tags.add('government-id');
  }

  // 2. Medical & Health Documents (HIPAA / PII)
  else if (
    /(patient|prescription|doctor|hospital|clinic|diagnosis|radiology|pathology|blood test|lab report|dosage|treatment|rx|physician|cardiology)/i.test(
      combined
    )
  ) {
    securityLevel = 'strictly_confidential';
    group = 'medical';
    subGroup = /(prescription|rx)/i.test(combined)
      ? 'prescriptions'
      : /(lab|blood|test|report)/i.test(combined)
      ? 'lab_reports'
      : 'clinical_notes';
    tags.add('medical');
    tags.add('health-record');
  }

  // 3. Financial & Tax Records
  else if (
    /(invoice|tax return|w-?2|1099|payroll|salary|bank statement|balance sheet|receipt|expense|audit|ledger)/i.test(
      combined
    )
  ) {
    securityLevel = 'confidential';
    group = 'financial';
    subGroup = /(tax|w-?2|1099)/i.test(combined)
      ? 'taxes'
      : /(invoice|bill)/i.test(combined)
      ? 'invoices'
      : 'banking';
    tags.add('finance');
  }

  // 4. Legal & Contracts
  else if (
    /(agreement|nda|non-disclosure|contract|clause|terms of service|amendment|settlement|affidavit)/i.test(
      combined
    )
  ) {
    securityLevel = 'confidential';
    group = 'legal';
    subGroup = /(nda|confidentiality)/i.test(combined) ? 'nda' : 'contracts';
    tags.add('legal');
    tags.add('contract');
  }

  // 5. Technical & Engineering
  else if (
    /(architecture|api|specification|rfc|schema|database|deploy|release|requirements|manual)/i.test(
      combined
    )
  ) {
    securityLevel = 'internal';
    group = 'technical';
    subGroup = 'specifications';
    tags.add('engineering');
  }

  // Extract explicit date if present in format YYYY-MM-DD or Month YYYY
  if (!userOverrides.documentDate) {
    const yearMatch = combined.match(/\b(20[0-2][0-9])[-/.](0[1-9]|1[0-2])[-/.](0[1-9]|[12][0-9]|3[01])\b/);
    if (yearMatch) {
      const parsed = new Date(yearMatch[0]);
      if (!isNaN(parsed.getTime())) {
        documentDate = parsed;
      }
    }
  }

  return {
    scope,
    securityLevel,
    group,
    subGroup,
    documentDate,
    tags: Array.from(tags),
  };
}

module.exports = {
  classifyDocument,
};

