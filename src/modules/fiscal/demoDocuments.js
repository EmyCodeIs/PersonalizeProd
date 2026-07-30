'use strict';

const fs = require('node:fs');
const path = require('node:path');

function escapeXml(value) {
  return String(value ?? '').replace(/[<>&"']/g, (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[char]));
}

function createMinimalPdf(lines) {
  const escaped = lines.map((line) => String(line).replace(/[()\\]/g, '\\$&'));
  const content = ['BT', '/F1 12 Tf', '50 790 Td'];
  escaped.forEach((line, index) => {
    if (index) content.push('0 -22 Td');
    content.push(`(${line}) Tj`);
  });
  content.push('ET');
  const stream = content.join('\n');
  const objects = [
    '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
    '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj',
    '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >> endobj',
    `4 0 obj << /Length ${Buffer.byteLength(stream)} >> stream\n${stream}\nendstream endobj`,
    '5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj',
  ];
  let body = '%PDF-1.4\n';
  const offsets = [0];
  for (const object of objects) {
    offsets.push(Buffer.byteLength(body));
    body += `${object}\n`;
  }
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let index = 1; index <= objects.length; index += 1) body += `${String(offsets[index]).padStart(10, '0')} 00000 n \n`;
  body += `trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(body);
}

function writeDemoDocuments(config, invoice) {
  const folder = path.join(config.documentDirectory, invoice.focus_reference);
  fs.mkdirSync(folder, { recursive: true });
  const pdfPath = path.join(folder, 'danfse-demo.pdf');
  const xmlPath = path.join(folder, 'nfse-demo.xml');
  const pdf = createMinimalPdf([
    'PERSONALIZE NF - DOCUMENTO DE DEMONSTRACAO',
    `NFS-e: ${invoice.nfse_number || 'DEMO'}`,
    `Cliente: ${invoice.client_name}`,
    `Documento: ${invoice.client_document}`,
    `Servico: ${invoice.service_description}`,
    `Valor: R$ ${Number(invoice.service_amount).toFixed(2)}`,
    'SEM VALIDADE FISCAL',
  ]);
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<NFSeDemo>\n  <referencia>${escapeXml(invoice.focus_reference)}</referencia>\n  <numero>${escapeXml(invoice.nfse_number || '')}</numero>\n  <prestador>${escapeXml(config.company.name)}</prestador>\n  <tomador>${escapeXml(invoice.client_name)}</tomador>\n  <documentoTomador>${escapeXml(invoice.client_document)}</documentoTomador>\n  <descricao>${escapeXml(invoice.service_description)}</descricao>\n  <valor>${Number(invoice.service_amount).toFixed(2)}</valor>\n  <ambiente>DEMONSTRACAO</ambiente>\n</NFSeDemo>\n`;
  fs.writeFileSync(pdfPath, pdf);
  fs.writeFileSync(xmlPath, xml);
  return { pdfPath, xmlPath };
}

module.exports = { writeDemoDocuments, createMinimalPdf };
