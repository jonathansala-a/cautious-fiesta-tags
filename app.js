const API_BASE = (window.location.hostname === 'localhost') ? 'http://localhost:8000' : 'https://YOUR_RENDER_SERVICE_URL';

document.getElementById('generateBtn').addEventListener('click', async () => {
  const text = document.getElementById('text').value;
  const country = document.getElementById('country').value;
  const result = document.getElementById('result');
  result.innerHTML = 'Generating...';
  try {
    const r = await fetch(`${API_BASE}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, country, limit: 20 })
    });
    const json = await r.json();
    if (r.ok) {
      result.innerHTML = json.generated.map(h => `<span class="tag" onclick="copyTag('${h}')">${h}</span>`).join(' ');
    } else {
      result.innerHTML = 'Error: ' + (json.error || 'unknown');
    }
  } catch (err) {
    result.innerHTML = 'Network error';
  }
});

async function loadTrends(country = 'global') {
  const trendsDiv = document.getElementById('trends');
  trendsDiv.innerHTML = 'Loading...';
  try {
    const r = await fetch(`${API_BASE}/trending?country=${country}`);
    const json = await r.json();
    if (!r.ok) { trendsDiv.innerHTML = 'Error'; return; }
    const rows = (json.hashtags || []).slice(0, 80).map(h => `<span class="tag">${h.tag}</span>`).join(' ');
    trendsDiv.innerHTML = `<div>Updated: ${json.updatedAt ? new Date(json.updatedAt._seconds * 1000).toLocaleString() : '—'}</div>${rows}`;
  } catch (err) {
    trendsDiv.innerHTML = 'Network error';
  }
}

document.getElementById('refreshTrends').addEventListener('click', ()=> loadTrends('global'));
window.onload = () => loadTrends('global');

window.copyTag = async (tag) => {
  try {
    await navigator.clipboard.writeText(tag);
    alert('Copied: ' + tag);
  } catch (e) {
    console.error('copy failed', e);
  }
};
