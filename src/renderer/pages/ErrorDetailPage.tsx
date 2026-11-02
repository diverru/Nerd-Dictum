import { useState, useEffect, useRef, useCallback } from 'react';
import './ErrorDetailPage.css';

interface ErrorDetail {
  message: string;
  statusCode?: number;
  responseBody?: string;
  audioFilePath?: string;
  audioFileName?: string;
  audioSizeBytes?: number;
}

function formatSize(bytes?: number): string {
  if (!bytes || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function ErrorDetailPage() {
  const [error, setError] = useState<ErrorDetail | null>(null);
  const [isRetrying, setIsRetrying] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    window.electronAPI.getErrorDetail().then(setError);
  }, []);

  const audioFilePath = error?.audioFilePath;

  const handleRetry = useCallback(async () => {
    if (!audioFilePath) return;
    setIsRetrying(true);
    const ok = await window.electronAPI.retryFailedRecording(audioFilePath);
    if (!ok) {
      setIsRetrying(false);
    }
    // On success the main process closes this window.
  }, [audioFilePath]);

  const handleReveal = useCallback(() => {
    if (!audioFilePath) return;
    window.electronAPI.showItemInFolder(audioFilePath);
  }, [audioFilePath]);

  if (!error) {
    return null;
  }

  const isHtml = error.responseBody
    ? /^\s*<!doctype|^\s*<html/i.test(error.responseBody)
    : false;

  return (
    <div className="error-detail-page">
      <div className="error-detail-header">
        <h1 className="error-detail-title">API Error</h1>
        <div className="error-detail-summary">
          {error.statusCode && (
            <span className="error-detail-status">HTTP {error.statusCode}</span>
          )}
          <span className="error-detail-message">{error.message}</span>
        </div>
      </div>
      {audioFilePath ? (
        <div className="error-detail-recording">
          <div className="error-detail-recording-info">
            <span className="error-detail-recording-label">Recording saved</span>
            <button
              type="button"
              className="error-detail-file-link"
              onClick={handleReveal}
              title={audioFilePath}
            >
              {error.audioFileName || audioFilePath}
            </button>
            {formatSize(error.audioSizeBytes) && (
              <span className="error-detail-recording-size">{formatSize(error.audioSizeBytes)}</span>
            )}
          </div>
          <button
            type="button"
            className="error-detail-retry-button"
            onClick={handleRetry}
            disabled={isRetrying}
          >
            {isRetrying ? 'Retrying…' : 'Retry'}
          </button>
        </div>
      ) : (
        <div className="error-detail-recording error-detail-recording--missing">
          <span className="error-detail-recording-label">Recording could not be saved</span>
        </div>
      )}
      {error.responseBody && (
        <div className="error-detail-body-section">
          <h2 className="error-detail-body-label">Response</h2>
          {isHtml ? (
            <iframe
              ref={iframeRef}
              className="error-detail-iframe"
              sandbox=""
              srcDoc={error.responseBody}
              title="API error response"
            />
          ) : (
            <pre className="error-detail-pre">{error.responseBody}</pre>
          )}
        </div>
      )}
    </div>
  );
}
