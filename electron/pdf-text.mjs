import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

const MAX_EXTRACTED_LENGTH = 1_500_000;

export async function extractPdfPages(data) {
  const loadingTask = getDocument({
    data: new Uint8Array(data),
    disableFontFace: true,
    isEvalSupported: false,
    useSystemFonts: true,
    verbosity: 0,
  });
  let pdf;
  try {
    pdf = await loadingTask.promise;
    if (pdf.numPages > 1_000) {
      throw new Error('PDFs must contain no more than 1,000 pages.');
    }
    const pages = [];
    let extractedLength = 0;
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = content.items
        .filter((item) => typeof item.str === 'string')
        .map((item) => `${item.str}${item.hasEOL ? '\n' : ' '}`)
        .join('')
        .replace(/[ \t]+\n/gu, '\n')
        .replace(/[ \t]{2,}/gu, ' ')
        .trim();
      if (text) {
        extractedLength += text.length;
        if (extractedLength > MAX_EXTRACTED_LENGTH) {
          throw new Error(`Extracted PDF text exceeds the ${MAX_EXTRACTED_LENGTH.toLocaleString()} character limit.`);
        }
        pages.push({ page: pageNumber, text });
      }
      page.cleanup();
    }
    return pages;
  } finally {
    await loadingTask.destroy();
  }
}
