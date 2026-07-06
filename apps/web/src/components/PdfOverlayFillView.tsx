import { useEffect, useState } from 'react';
import { Document, Page } from 'react-pdf';
import { usePdfFile } from '../hooks/usePdfFile';
import { PDF_DISPLAY_SCALE, pdfBoxToBrowserBox } from '../lib/pdfCoordinates';
import type { TemplateFieldSchema } from '../lib/fieldSchema';
import { PDF_PAGE_CANVAS_ONLY } from '../lib/pdfjsSetup';
import '../styles/pdfVisualMapper.css';

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:4000';

type Props = {
  sessionId: string;
  schema: TemplateFieldSchema;
  responses: Record<string, unknown>;
  onResponseChange: (responses: Record<string, unknown>) => void;
  showLiveJson?: boolean;
};

export function PdfOverlayFillView({
  sessionId,
  schema,
  responses,
  onResponseChange,
  showLiveJson = true,
}: Props) {
  const [numPages, setNumPages] = useState(0);
  const [pageSizes, setPageSizes] = useState<Record<number, { width: number; height: number }>>({});

  const pdfUrl = `${API_BASE}/api/submissions/${sessionId}/source-pdf`;
  const { file: pdfFile, loading: pdfLoading, error: pdfError } = usePdfFile(pdfUrl);
  const fields = schema.fields;

  useEffect(() => {
    setPageSizes({});
  }, [sessionId, schema]);

  function pageLoaded(
    page: { getViewport: (opts: { scale: number }) => { width: number; height: number } },
    pageNumber: number,
  ) {
    const viewport = page.getViewport({ scale: 1 });
    setPageSizes((prev) => ({
      ...prev,
      [pageNumber - 1]: { width: viewport.width, height: viewport.height },
    }));
  }

  function setResponse(key: string, value: unknown) {
    onResponseChange({ ...responses, [key]: value });
  }

  function fieldsForPage(pageNumber: number) {
    return fields.filter((field) => field.page === pageNumber - 1);
  }

  if (pdfLoading) {
    return <p>Loading PDF form…</p>;
  }

  if (pdfError) {
    return <div className="error">{pdfError}</div>;
  }

  if (!pdfFile) {
    return null;
  }

  return (
    <div className="pdf-overlay-fill">
      {showLiveJson ? (
        <details style={{ marginBottom: 16 }}>
          <summary style={{ cursor: 'pointer', fontWeight: 600 }}>Live response JSON</summary>
          <pre className="jsonBox">{JSON.stringify(responses, null, 2)}</pre>
        </details>
      ) : null}

      <Document file={pdfFile} onLoadSuccess={({ numPages: n }) => setNumPages(n)}>
        {Array.from({ length: numPages }, (_, index) => {
          const pageNumber = index + 1;
          const pageSize = pageSizes[index];
          const pageWidth = pageSize ? pageSize.width * PDF_DISPLAY_SCALE : 612 * PDF_DISPLAY_SCALE;
          const pageHeightPx = pageSize ? pageSize.height * PDF_DISPLAY_SCALE : 0;

          return (
            <div key={pageNumber} className="pageWrapper">
              <div className="pageTitle">Page {pageNumber}</div>
              <div className="pageCanvas" style={{ width: pageWidth }}>
                <Page
                  pageNumber={pageNumber}
                  scale={PDF_DISPLAY_SCALE}
                  onLoadSuccess={(page) => pageLoaded(page, pageNumber)}
                  {...PDF_PAGE_CANVAS_ONLY}
                />

                {pageSize ? (
                  <div className="pageFieldLayer" style={{ width: pageWidth, height: pageHeightPx }}>
                    {fieldsForPage(pageNumber).map((field) => {
                  const pageSizeForField = pageSizes[field.page];
                  if (!pageSizeForField) return null;

                  if (field.type === 'text') {
                    const browserField = pdfBoxToBrowserBox(field, pageSizeForField.height);
                    const fontPx = (field.fontSize ?? 10) * PDF_DISPLAY_SCALE;
                    const maxH = Math.max(fontPx * 2.2, 22);
                    return (
                      <input
                        key={field.id}
                        className="pdfTextInput"
                        placeholder={field.label}
                        style={{
                          left: browserField.x,
                          top: browserField.y,
                          width: browserField.width,
                          height: Math.min(browserField.height, maxH),
                          fontSize: fontPx,
                        }}
                        value={String(responses[field.key] ?? '')}
                        onChange={(e) => setResponse(field.key, e.target.value)}
                      />
                    );
                  }

                  if (field.type === 'checkbox') {
                    const browserField = pdfBoxToBrowserBox(field, pageSizeForField.height);
                    const checked = responses[field.key] === true;
                    return (
                      <button
                        key={field.id}
                        type="button"
                        className={checked ? 'pdfCheckbox checked' : 'pdfCheckbox'}
                        style={{
                          left: browserField.x,
                          top: browserField.y,
                          width: browserField.width,
                          height: browserField.height,
                        }}
                        onClick={() => setResponse(field.key, !checked)}
                        aria-label={field.label}
                      >
                        {checked ? '✓' : ''}
                      </button>
                    );
                  }

                  if (field.type === 'radio') {
                    return (field.options ?? []).map((option) => {
                      const browserOption = pdfBoxToBrowserBox(option, pageSizeForField.height);
                      const selected = responses[field.key] === option.value;
                      return (
                        <button
                          key={option.id}
                          type="button"
                          className={selected ? 'pdfRadio selected' : 'pdfRadio'}
                          style={{
                            left: browserOption.x,
                            top: browserOption.y,
                            width: Math.max(browserOption.width, 22),
                            height: Math.max(browserOption.height, 22),
                          }}
                          onClick={() => setResponse(field.key, option.value)}
                          title={`${field.label}: ${option.value}`}
                          aria-label={`${field.label} ${option.value}`}
                        />
                      );
                    });
                  }

                      return null;
                    })}
                  </div>
                ) : null}
              </div>
            </div>
          );
        })}
      </Document>
    </div>
  );
}
