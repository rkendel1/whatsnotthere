export const DEFAULT_PAGE_LIMIT = 25;

function findDataset(report, datasetId) {
  return report?.structuredExtraction?.datasets?.find((dataset) => dataset.id === datasetId);
}

export async function followPagination({
  report,
  datasetId,
  replayPage,
  recordObservation,
  analyze,
  maxPages = DEFAULT_PAGE_LIMIT,
}) {
  let currentReport = report;
  let pagesFetched = 0;
  const requests = new Set();
  let stopReason = 'complete';

  while (pagesFetched < maxPages) {
    const dataset = findDataset(currentReport, datasetId);
    const request = dataset?.pagination?.nextRequest;
    if (!request?.url) break;
    if (request.method !== 'GET') {
      stopReason = 'unsafe-method';
      break;
    }
    if (requests.has(request.url)) {
      stopReason = 'continuation-loop';
      break;
    }
    requests.add(request.url);

    const event = await replayPage(request);
    if (!event || event.status < 200 || event.status >= 300) {
      stopReason = 'request-failed';
      break;
    }

    recordObservation(event);
    pagesFetched += 1;
    currentReport = await analyze();
  }

  if (pagesFetched === maxPages && findDataset(currentReport, datasetId)?.pagination?.nextRequest) {
    stopReason = 'page-limit';
  }

  return { report: currentReport, pagesFetched, stopReason };
}
