const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
const DATA_FILE = path.join(__dirname, 'data', 'invoices.json');

function loadInvoices() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch { return []; }
}
function saveInvoices(data) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// GET all invoices
app.get('/api/invoices', (req, res) => res.json(loadInvoices()));

// DELETE an invoice
app.delete('/api/invoices/:id', (req, res) => {
  saveInvoices(loadInvoices().filter(i => i.id !== req.params.id));
  res.json({ ok: true });
});

// POST save — frontend sends already-parsed invoice object
app.post('/api/invoices', (req, res) => {
  const inv = req.body;
  if (!inv || !inv.id) return res.status(400).json({ error: 'Invalid invoice data' });
  const invoices = loadInvoices();
  invoices.unshift(inv);
  saveInvoices(invoices);
  res.json({ ok: true });
});

// PUT update invoice (manual corrections)
app.put('/api/invoices/:id', (req, res) => {
  const invoices = loadInvoices();
  const idx = invoices.findIndex(i => i.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  invoices[idx] = { ...invoices[idx], ...req.body };
  saveInvoices(invoices);
  res.json(invoices[idx]);
});

// Helper: extract line items from rawTextPreview using GB Wholesale format
// Format: "520   3.95 $   2,054.00 $" and description on a separate DESCRIPTION line
function extractLineItemsFromText(text) {
  if (!text) return [];
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const items = [];

  // Find description lines (appear after "DESCRIPTION" header)
  let descStartIdx = lines.findIndex(l => /^DESCRIPTION$/i.test(l));
  const descriptions = descStartIdx >= 0
    ? lines.slice(descStartIdx + 1).filter(l =>
      !/^(subtotal|sales tax|total|hst|gst|paid|cheque|cash|delivery|e-transfer|cheques|www\.|invoice)/i.test(l)
    )
    : [];

  // Find quantity/price/amount rows: "520   3.95 $   2,054.00 $"
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
  const invoices = loadInvoices();
  const headers = ['Invoice #', 'Client', 'Date', 'Year', 'Quarter', 'Month', 'Subtotal', 'Tax', 'Total', 'Currency', 'Line Items', 'File'];
  const rows = invoices.map(inv => {
    // Use saved lineItems if populated, otherwise re-parse from rawTextPreview
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
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`InvoiceVault (free) running on port ${PORT}`));
