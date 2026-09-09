const output = document.getElementById('output');
const error = document.getElementById('error');
const button = document.getElementById('scan');

async function currentTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('No active tab found.');
  return tab.id;
}

button.addEventListener('click', async () => {
  error.textContent = '';
  output.textContent = 'Reconstructing dataset from observed traffic...';

  try {
    const tabId = await currentTabId();
    const response = await chrome.runtime.sendMessage({ kind: 'build_report', tabId });

    if (!response?.ok) {
      throw new Error(response?.error || 'Failed to create report.');
    }

    output.textContent = JSON.stringify(response.report, null, 2);
  } catch (scanError) {
    error.textContent = scanError.message;
    output.textContent = 'No report yet.';
  }
});
