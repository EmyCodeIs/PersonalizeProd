'use strict';

require('dotenv').config();
const path = require('path');
const LeadReport = require('../src/services/leadAbandonmentReport');

const result = LeadReport.writeTxtReport();
console.log(`[LEADS 24H] relatório criado: ${path.resolve(result.filePath)}`);
console.log(`[LEADS 24H] total=${result.report.total} | aguardandoAviso=${result.report.pendingNotification}`);
