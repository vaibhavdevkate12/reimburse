"use client";
import "./polyfill";
import { useEffect, useState } from "react";
import * as pdfjsLib from "pdfjs-dist";

if (typeof window !== "undefined") {
  // Use unpkg CDN for PDF worker to avoid Next.js dev server mime-type or path configuration issues (404s)
  pdfjsLib.GlobalWorkerOptions.workerSrc = "https://unpkg.com/pdfjs-dist@5.7.284/build/pdf.worker.min.mjs";
}

// A4 at 96dpi: 210mm = ~794px, minus 2×1cm margin = 190mm = ~718px
// minus 2×2.5rem padding (≈80px) = ~638px content width
const A4_CONTENT_WIDTH_PX = 638;
// A4 content height: 277mm ≈ 1047px, minus ~90px header = ~957px max
const A4_CONTENT_HEIGHT_PX = 920;
// Whitespace threshold: pixels with all channels >= this are considered "white"
const WHITE_THRESHOLD = 245;

/**
 * Scans from the bottom of a canvas upward and returns a new canvas
 * cropped to remove trailing rows of near-white pixels.
 */
function trimCanvasWhitespace(canvas: HTMLCanvasElement): HTMLCanvasElement | null {
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;

  const { width, height } = canvas;
  const imageData = ctx.getImageData(0, 0, width, height);
  const data = imageData.data; // RGBA flat array

  // Walk rows from bottom upward to find last non-white row
  let lastContentRow = -1;
  for (let y = height - 1; y >= 0; y--) {
    let rowHasContent = false;
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];
      // If any pixel is darker than threshold, this row has content
      if (r < WHITE_THRESHOLD || g < WHITE_THRESHOLD || b < WHITE_THRESHOLD) {
        rowHasContent = true;
        break;
      }
    }
    if (rowHasContent) {
      lastContentRow = y;
      break;
    }
  }

  if (lastContentRow === -1) return null; // Page is completely blank

  // Add a small bottom margin (8px scaled to the canvas resolution) after the last content row
  const scaleFactor = canvas.width / A4_CONTENT_WIDTH_PX;
  const margin = Math.round(8 * scaleFactor);
  const croppedHeight = Math.min(lastContentRow + margin, height);
  if (croppedHeight >= height) return canvas; // nothing to trim

  const trimmed = document.createElement("canvas");
  trimmed.width = width;
  trimmed.height = croppedHeight;
  const trimCtx = trimmed.getContext("2d");
  if (!trimCtx) return canvas;
  trimCtx.drawImage(canvas, 0, 0, width, croppedHeight, 0, 0, width, croppedHeight);
  return trimmed;
}

/**
 * Converts a canvas to grayscale and boosts contrast.
 * This makes the document black-and-white and keeps text extremely sharp and readable.
 */
function convertCanvasToGrayscaleAndContrast(canvas: HTMLCanvasElement): HTMLCanvasElement {
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;

  const { width, height } = canvas;
  const imageData = ctx.getImageData(0, 0, width, height);
  const data = imageData.data; // RGBA flat array

  // Contrast enhancement factor
  // factor = (259 * (contrast + 255)) / (255 * (259 - contrast))
  // A contrast boost of 50 cleans up backgrounds and makes text stand out.
  const contrast = 50;
  const factor = (259 * (contrast + 255)) / (255 * (259 - contrast));

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];

    // Grayscale conversion using BT.601 luminance weights
    const gray = 0.299 * r + 0.587 * g + 0.114 * b;

    // Apply contrast
    const adjustedGray = factor * (gray - 128) + 128;

    // Clamp between 0 and 255
    const finalGray = Math.max(0, Math.min(255, adjustedGray));

    data[i] = finalGray;     // R
    data[i + 1] = finalGray; // G
    data[i + 2] = finalGray; // B
    // data[i + 3] (alpha) remains unchanged
  }

  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

import { createPortal } from "react-dom";

interface PDFRendererProps {
  url?: string;
  file?: File;
  itemIndex: number;
  fileIndex: number;
  category: string;
  amount: number;
  symbol: string;
  expenseId: string | number;
  excludedPages: Set<string>;
  onToggleExclude?: (key: string) => void;
  onLoadingStateChange?: (key: string, isLoading: boolean) => void;
  showPreview?: boolean;
}

export default function PDFRenderer({
  url,
  file,
  itemIndex,
  fileIndex,
  category,
  amount,
  symbol,
  expenseId,
  excludedPages,
  onToggleExclude,
  onLoadingStateChange,
  showPreview = true,
}: PDFRendererProps) {
  const [pages, setPages] = useState<{ src: string; width: number; height: number }[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);

  useEffect(() => {
    const key = `pdf-${itemIndex}-${fileIndex}`;
    let objectUrl = "";
    let isCancelled = false;
    let currentLoadingTask: ReturnType<typeof pdfjsLib.getDocument> | null = null;

    async function loadPDF() {
      setLoading(true);
      onLoadingStateChange?.(key, true);
      setError(null);
      try {
        let pdfUrl = url;
        if (file) {
          objectUrl = URL.createObjectURL(file);
          pdfUrl = objectUrl;
          console.log(`[PDFRenderer] Created object URL for file: ${file.name}, URL: ${objectUrl}`);
        }
        if (!pdfUrl) {
          if (!isCancelled) {
            setLoading(false);
            onLoadingStateChange?.(key, false);
          }
          return;
        }

        console.log(`[PDFRenderer] Loading PDF from URL: ${pdfUrl}`);
        const loadingTask = pdfjsLib.getDocument(pdfUrl);
        currentLoadingTask = loadingTask;
        const pdf = await loadingTask.promise;
        
        if (isCancelled) {
          try {
            loadingTask.destroy();
          } catch {}
          return;
        }

        const pageResults: { src: string; width: number; height: number }[] = [];

        for (let i = 1; i <= pdf.numPages; i++) {
          if (isCancelled) {
            try {
              loadingTask.destroy();
            } catch {}
            return;
          }

          const page = await pdf.getPage(i);
          // Compute scale to fit within A4 content width
          const unscaledViewport = page.getViewport({ scale: 1 });
          const scaleByWidth = A4_CONTENT_WIDTH_PX / unscaledViewport.width;
          // Also limit by height so tall pages don't overflow
          const scaleByHeight = A4_CONTENT_HEIGHT_PX / unscaledViewport.height;
          const scale = Math.min(scaleByWidth, scaleByHeight);

          const viewport = page.getViewport({ scale });

          // Render at 3x scale for high resolution printing (gives crisp print output)
          const RENDER_SCALE_FACTOR = 3;
          const renderScale = scale * RENDER_SCALE_FACTOR;
          const renderViewport = page.getViewport({ scale: renderScale });
          
          const canvas = document.createElement("canvas");
          const context = canvas.getContext("2d");

          if (!context) throw new Error("Could not get canvas context");

          canvas.width = renderViewport.width;
          canvas.height = renderViewport.height;

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await (page.render({ canvasContext: context, viewport: renderViewport } as any)).promise;

          // Convert canvas to grayscale and boost contrast for clear black & white text
          convertCanvasToGrayscaleAndContrast(canvas);

          // Trim trailing whitespace from the rendered page
          const trimmed = trimCanvasWhitespace(canvas);

          if (trimmed) {
            // Calculate proportional dimensions for layout
            const layoutWidth = viewport.width;
            const layoutHeight = (trimmed.height / renderViewport.height) * viewport.height;

            pageResults.push({
              src: trimmed.toDataURL("image/png"), // Lossless PNG for crisp text
              width: layoutWidth,
              height: layoutHeight,
            });
          }
        }

        if (!isCancelled) {
          setPages(pageResults);
          console.log(`[PDFRenderer] Successfully loaded ${pdf.numPages} pages.`);
          onLoadingStateChange?.(key, false);
          setLoading(false);
        }
      } catch (err: unknown) {
        if (!isCancelled) {
          console.error("Error rendering PDF:", err);
          setError(err instanceof Error ? err.message : String(err));
          onLoadingStateChange?.(key, false);
          setLoading(false);
        }
      }
    }

    console.log(`[PDFRenderer] useEffect trigger for ${key}. url: ${url}, file: ${file?.name}`);
    if ((url && (url.toLowerCase().endsWith('.pdf') || url.startsWith('blob:') || url.includes('blob'))) || file) {
      loadPDF();
    } else {
      Promise.resolve().then(() => {
        setLoading(false);
      });
    }

    return () => {
      isCancelled = true;
      console.log(`[PDFRenderer] useEffect cleanup for ${key}. objectUrl: ${objectUrl}`);
      if (currentLoadingTask) {
        try {
          currentLoadingTask.destroy();
        } catch {}
      }
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
      onLoadingStateChange?.(key, false);
    };
  }, [url, file, itemIndex, fileIndex, onLoadingStateChange]);

  useEffect(() => {
    if (loading) return;

    const portalId = `pdf-print-target-${itemIndex}-${fileIndex}`;
    
    const checkTarget = () => {
      const target = document.getElementById(portalId);
      if (target) {
        setPortalTarget(target);
        return true;
      }
      return false;
    };

    if (checkTarget()) return;

    let count = 0;
    const interval = setInterval(() => {
      count++;
      if (checkTarget() || count >= 10) {
        clearInterval(interval);
      }
    }, 100);

    return () => clearInterval(interval);
  }, [itemIndex, fileIndex, loading]);

  if (loading) {
    return <div style={{ padding: '1rem', color: '#64748b' }}>Rendering PDF pages for print...</div>;
  }
  if (error) {
    return <div style={{ color: '#ef4444', padding: '1rem' }}>Error loading PDF.</div>;
  }

  const previewContent = (
    <div className="pdf-render-container">
      {pages.map((page, pageIndex) => {
        const key = `proof_${itemIndex}_${fileIndex}_${pageIndex}`;
        const isExcluded = excludedPages.has(key);

        if (isExcluded) {
          return (
            <div key={pageIndex} className="excluded-page-placeholder no-print">
              <div className="excluded-page-text">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
                <span>Proof {itemIndex + 1} (PDF Page {pageIndex + 1}) - Excluded from Print</span>
              </div>
              <button
                type="button"
                className="page-restore-btn"
                onClick={() => onToggleExclude?.(key)}
              >
                Restore Page
              </button>
            </div>
          );
        }

        return (
          <div key={pageIndex} className="preview-page-card no-print">
            <div className="preview-page-header">
              <span className="preview-page-title">
                Proof {itemIndex + 1}: {category} (PDF Page {pageIndex + 1} of {pages.length})
              </span>
              <button
                type="button"
                className="page-exclude-btn"
                onClick={() => onToggleExclude?.(key)}
              >
                Exclude Page
              </button>
            </div>
            <div style={{ padding: '0.75rem', backgroundColor: '#fff', display: 'flex', justifyContent: 'center', maxHeight: '250px', overflowY: 'auto' }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={page.src}
                alt={`PDF Page ${pageIndex + 1}`}
                style={{
                  maxWidth: '100%',
                  maxHeight: '220px',
                  width: 'auto',
                  height: 'auto',
                  display: 'block',
                  border: '1px solid #ddd',
                  objectFit: 'contain'
                }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );

  const printContent = (
    <div className="pdf-print-container">
      {pages.map((page, pageIndex) => {
        const key = `proof_${itemIndex}_${fileIndex}_${pageIndex}`;
        const isExcluded = excludedPages.has(key);

        if (isExcluded) return null;

        return (
          <div
            key={pageIndex}
            className="print-proof-item"
          >
            <div className="proof-header">
              <h3>
                Proof for Item {itemIndex + 1}: {category} (PDF Page {pageIndex + 1} of {pages.length})
              </h3>
              <p>
                Reimbursement ID: {expenseId} | Amount: {symbol}{Number(amount).toFixed(2)}
              </p>
            </div>
            <div className="proof-content">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={page.src}
                alt={`PDF Page ${pageIndex + 1}`}
                style={{
                  width: `${page.width}px`,
                  height: `${page.height}px`,
                  maxWidth: '100%',
                  display: 'block',
                  margin: '0 auto',
                  border: '1px solid #ddd',
                }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );

  return (
    <>
      {showPreview && previewContent}
      {portalTarget && createPortal(printContent, portalTarget)}
    </>
  );
}
