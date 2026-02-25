const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');

const app = express();

// Change 7 — Increased JSON Body Size Limit
app.use(express.json({ limit: '10mb' }));

// Change 4 — Request Logging middleware
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// Change 1 — Smart Data Directory Selection
const CANDIDATES = [
  '/opt/render/project/src/data',   // Render paid disk mount
  path.join(__dirname, 'data'),     // local / same folder
  path.join(process.env.HOME || '/tmp', 'invoicevault_data'), // writable fallback
];

function getDataDir() {
  for (const dir of CANDIDATES) {
    try {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      // Test writability
      const testFile = path.join(dir, '.write_test');
      fs.writeFileSync(testFile, 'ok');
      fs.unlinkSync(testFile);
      return dir;
    } catch (e) {
      console.warn(`Directory ${dir} not writable: ${e.message}`);
    }
  }
  return '/tmp'; // Last resort
}

const DATA_DIR = getDataDir();
const DATA_FILE = path.join(DATA_DIR, 'invoices.json');
console.log(`Using data directory: ${DATA_DIR}`);

// Change 2 — Auto-Create invoices.json on Startup
if (!fs.existsSync(DATA_FILE)) {
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, '[]');
    console.log('Created fresh invoices.json at', DATA_FILE);
  } catch (e) {
    console.error('Failed to create invoices.json:', e.message);
  }
}

function loadInvoices() {
  try {
    if (!fs.existsSync(DATA_FILE)) return [];
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    console.error('Error loading invoices:', e.message);
    return [];
  }
}

function saveInvoices(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

app.use(express.static(path.join(__dirname, 'public')));

// Change 3 — Health Check Endpoint
app.get('/api/health', (req, res) => {
  try {
    res.json({
      status: 'ok',
      dataDir: DATA_DIR,
      fileExists: fs.existsSync(DATA_FILE),
      invoiceCount: loadInvoices().length,
      time: new Date().toISOString(),
      nodeVersion: process.version,
      memory: process.memoryUsage()
    });
  } catch (e) {
    res.status(500).json({ status: 'error', error: e.message });
  }
});

// GET all invoices
app.get('/api/invoices', (req, res) => {
  // Change 6 — Error Handling on Every Route
  try {
    res.json(loadInvoices());
  } catch (e) {
    res.status(500).json({ error: 'Failed to load invoices: ' + e.message });
  }
});

// DELETE an invoice
app.delete('/api/invoices/:id', (req, res) => {
  try {
    const invoices = loadInvoices();
    const filtered = invoices.filter(i => i.id !== req.params.id);
    saveInvoices(filtered);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to delete invoice: ' + e.message });
  }
});

// POST save — frontend sends already-parsed invoice object
app.post('/api/invoices', (req, res) => {
  const inv = req.body;
  if (!inv || !inv.id) return res.status(400).json({ error: 'Invalid invoice data' });

  try {
    const invoices = loadInvoices();
    // Change 5 — Duplicate Invoice Prevention
    if (invoices.find(i => i.id === inv.id)) {
      console.log(`Invoice ${inv.id} already exists, skipping save.`);
      return res.json({ ok: true });
    }

    invoices.unshift(inv);
    saveInvoices(invoices);
    res.json({ ok: true });
  } catch (err) {
    console.error('Error saving invoice:', err);
    res.status(500).json({ error: 'Failed to save to disk: ' + err.message });
  }
});

// PUT update invoice (manual corrections)
app.put('/api/invoices/:id', (req, res) => {
  try {
    const invoices = loadInvoices();
    const idx = invoices.findIndex(i => i.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Not found' });
    invoices[idx] = { ...invoices[idx], ...req.body };
    saveInvoices(invoices);
    res.json(invoices[idx]);
  } catch (e) {
    res.status(500).json({ error: 'Failed to update invoice: ' + e.message });
  }
});

// Helper: extract line items from rawTextPreview using GB Wholesale format
function extractLineItemsFromText(text) {
  if (!text) return [];
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const items = [];

  let descStartIdx = lines.findIndex(l => /^DESCRIPTION$/i.test(l));
  const descriptions = descStartIdx >= 0
    ? lines.slice(descStartIdx + 1).filter(l =>
      !/^(subtotal|sales tax|total|hst|gst|paid|cheque|cash|delivery|e-transfer|cheques|www\.|invoice)/i.test(l)
    )
    : [];

  const rowRe = /^(\d+)\s+([\d,]+\.?\d*)\s*\$\s+([\d,]+\.?\d*)\s*\$\s*$/;
  let itemIdx = 0;
  for (const line of lines) {
    const m = line.match(rowRe);
    if (m) {
      items.push({
        description: descriptions[itemIdx] || 'Item',
        quantity: parseFloat(m[1]),
        unitPrice: parseFloat(m[2].replace(/,/g, '')),
        amount: parseFloat(m[3].replace(/,/g, '')),
      });
      itemIdx++;
    }
  }
  return items;
}

// Export CSV
app.get('/api/export', (req, res) => {
  try {
    const invoices = loadInvoices();
    const headers = ['Invoice #', 'Client', 'Date', 'Year', 'Quarter', 'Month', 'Subtotal', 'Tax', 'Total', 'Currency', 'Line Items', 'File'];
    const rows = invoices.map(inv => {
      let items = (inv.lineItems && inv.lineItems.length)
        ? inv.lineItems
        : extractLineItemsFromText(inv.rawTextPreview || '');

      const lineItemsSummary = items.length
        ? items.map(l => `${l.quantity}x ${l.description} @ $${(l.unitPrice || 0).toFixed(2)}`).join(' | ')
        : '';

      const vals = [
        inv.invoiceNumber, inv.clientName, inv.date, inv.year, inv.quarter,
        inv.monthName, inv.subtotal, inv.tax, inv.total,
        inv.currency || 'CAD',
        lineItemsSummary,
        inv.fileName
      ];
      return vals.map(v => `"${(v ?? '').toString().replace(/"/g, '""')}"`);
    });
    const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="invoicevault_export.csv"');
    res.send(csv);
  } catch (e) {
    res.status(500).json({ error: 'Failed to export CSV: ' + e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`InvoiceVault (free) running on port ${PORT}`));
